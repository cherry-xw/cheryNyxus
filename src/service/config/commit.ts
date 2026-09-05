import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  CONFIG_APPLY_VERSION,
  HooksDraftSchema,
  type ConfigPreview,
  type ConfigSaveResult,
  type HooksDraft,
} from '@chery/protocol'
import {
  readRawConfig,
  restoreRedactedSecrets,
  saveRawConfig,
  validateConfigCandidate,
  validateLoadable,
  type ConfigRaw,
} from '@/utils/config.js'
import { loadHookRegistry } from '@/agent/hooks/registry.js'
import {
  createConfigRevision,
  markConfigRevisionHandled,
  collectRuntimeResourceManifest,
} from './revision.js'
import { ConfigApplyCoordinator } from './applyCoordinator.js'
import {
  destructiveTargets,
  diffResources,
  imageRevision,
  resources,
  stable,
  type ConfigImage,
} from './impact.js'

export type ConfigCommitResult =
  | ({ ok: true } & ConfigSaveResult)
  | {
      ok: false
      kind: 'stale' | 'validation' | 'save' | 'partial-save' | 'preview' | 'idempotency'
      currentRevision?: string
      errors: string[]
      warnings: string[]
    }
export interface ConfigCommitInput {
  candidate: ConfigRaw
  expectedBaseRevision: string
  hooks?: HooksDraft
  requestId?: string
  previewToken?: string
  policy?: 'wait'
}
let coordinator: ConfigApplyCoordinator | undefined
const requests = new Map<string, { fingerprint: string; result: ConfigCommitResult }>()
const previews = new Map<string, { fingerprint: string; expires: number }>()
let handledDiskImage: string | undefined
function configPaths(): { config: string; hooks: string } {
  const root = path.join(process.env.CHERY_DIR || process.cwd(), '.chery')
  return { config: path.join(root, 'config.yaml'), hooks: path.join(root, 'hooks', 'hooks.json') }
}
export function readConfigImage(): ConfigImage {
  const hooksPath = configPaths().hooks
  const hooks = fs.existsSync(hooksPath) ? JSON.parse(fs.readFileSync(hooksPath, 'utf8')) : {}
  const manifest = collectRuntimeResourceManifest().entries as Array<{
    path: string
    sha256: string
  }>
  const assets = Object.fromEntries(
    manifest
      .filter((entry) => !['config.yaml', 'hooks/hooks.json'].includes(entry.path))
      .map((entry) => [entry.path, entry.sha256]),
  )
  return { config: readRawConfig(), hooks, assets }
}
export function getSavedBaseRevision(image = readConfigImage()): string {
  return imageRevision(image)
}
export function getConfigApplyCoordinator(): ConfigApplyCoordinator {
  if (!coordinator) {
    loadHookRegistry() // retain old hooks until the module adopts the saved candidate
    coordinator = new ConfigApplyCoordinator(readConfigImage())
  }
  return coordinator
}
export function isStructuredConfigImageHandled(): boolean {
  return handledDiskImage === imageRevision(collectRuntimeResourceManifest())
}
function acknowledgeDisk(): void {
  handledDiskImage = imageRevision(collectRuntimeResourceManifest())
}
function validated(
  input: ConfigCommitInput,
): { image: ConfigImage; before: ConfigImage; warnings: string[] } | ConfigCommitResult {
  const before = readConfigImage()
  const currentRevision = imageRevision(before)
  if (input.expectedBaseRevision !== currentRevision)
    return {
      ok: false,
      kind: 'stale',
      currentRevision,
      errors: ['baseRevision 已过期：配置或 Hooks 已被其他操作修改，请重新读取后保存'],
      warnings: [],
    }
  const candidate = restoreRedactedSecrets(structuredClone(input.candidate), before.config)
  const hooks = HooksDraftSchema.safeParse(input.hooks ?? before.hooks)
  if (!hooks.success)
    return {
      ok: false,
      kind: 'validation',
      errors: ['Hooks 草稿无效：请检查事件、command 和 timeout'],
      warnings: [],
    }
  const check = validateConfigCandidate(candidate, before.config)
  if (!check.ok)
    return { ok: false, kind: 'validation', errors: check.errors, warnings: check.warnings }
  const loadable = validateLoadable(candidate)
  if (!loadable.ok)
    return { ok: false, kind: 'validation', errors: loadable.errors, warnings: loadable.warnings }
  return {
    before,
    image: { config: candidate, hooks: hooks.data, assets: before.assets },
    warnings: [...check.warnings, ...loadable.warnings],
  }
}
function previewFingerprint(
  input: ConfigCommitInput,
  image: ConfigImage,
  before: ConfigImage,
): string {
  return imageRevision({
    base: imageRevision(before),
    image,
    targets: destructiveTargets(before.config, image.config),
    policy: input.policy ?? 'wait',
    resources: collectRuntimeResourceManifest(),
  })
}
export function previewConfigCandidate(
  input: ConfigCommitInput,
): ConfigPreview | ConfigCommitResult {
  const checked = validated(input)
  if ('ok' in checked) return checked
  const previewToken = randomUUID()
  if (previews.size >= 100) previews.delete(previews.keys().next().value!)
  previews.set(previewToken, {
    fingerprint: previewFingerprint(input, checked.image, checked.before),
    expires: Date.now() + 300_000,
  })
  return {
    protocolVersion: CONFIG_APPLY_VERSION,
    baseRevision: imageRevision(checked.before),
    previewToken,
    impacts: diffResources(
      resources(checked.before),
      resources(checked.image),
      imageRevision(checked.before),
    ),
    destructiveTargets: destructiveTargets(checked.before.config, checked.image.config),
    policy: 'wait',
  }
}
function atomicRestore(filename: string, content: Buffer | undefined): void {
  if (content === undefined) {
    if (fs.existsSync(filename)) fs.unlinkSync(filename)
    return
  }
  const temporary = `${filename}.${randomUUID()}.restore`
  try {
    fs.writeFileSync(temporary, content)
    fs.renameSync(temporary, filename)
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
  }
}
/** Synchronous validation/writes serialize commits; preparation and application
 * are separately serialized by the coordinator. No lifecycle effects here. */
export function commitConfigCandidate(input: ConfigCommitInput): ConfigCommitResult {
  const fingerprint = imageRevision(input)
  const previous = input.requestId ? requests.get(input.requestId) : undefined
  if (previous)
    return previous.fingerprint === fingerprint
      ? structuredClone(previous.result)
      : {
          ok: false,
          kind: 'idempotency',
          errors: ['requestId 已用于不同内容，请使用新的请求 ID'],
          warnings: [],
        }
  const engine = getConfigApplyCoordinator()
  const checked = validated(input)
  if ('ok' in checked) return checked
  const { before, image, warnings } = checked
  const targets = destructiveTargets(before.config, image.config)
  if (targets.length || input.previewToken) {
    const preview = input.previewToken ? previews.get(input.previewToken) : undefined
    if (
      !preview ||
      preview.expires < Date.now() ||
      preview.fingerprint !== previewFingerprint(input, image, before)
    )
      return {
        ok: false,
        kind: 'preview',
        errors: ['删除角色或预设前需要有效影响预览；请重新预览后按等待策略保存'],
        warnings: [],
      }
  }
  const files = configPaths()
  const originals = new Map<string, Buffer | undefined>()
  let candidateRevisionId = ''
  try {
    if (stable(before.config) !== stable(image.config)) {
      originals.set(files.config, fs.readFileSync(files.config))
      const saved = saveRawConfig(image.config)
      if (!saved.ok)
        return { ok: false, kind: 'validation', errors: saved.errors, warnings: saved.warnings }
    }
    if (stable(before.hooks) !== stable(image.hooks)) {
      originals.set(
        files.hooks,
        fs.existsSync(files.hooks) ? fs.readFileSync(files.hooks) : undefined,
      )
      fs.mkdirSync(path.dirname(files.hooks), { recursive: true })
      atomicRestore(files.hooks, Buffer.from(JSON.stringify(image.hooks, null, 2)))
    }
  } catch {
    let partial = false
    for (const [filename, content] of [...originals].reverse()) {
      try {
        atomicRestore(filename, content)
      } catch {
        partial = true
      }
    }
    return {
      ok: false,
      kind: partial ? 'partial-save' : 'save',
      errors: [
        partial
          ? '部分文件保存失败且恢复失败，请检查 config.yaml 和 hooks/hooks.json；不能视为保存成功'
          : '保存失败，已恢复原配置与 Hooks',
      ],
      warnings: [],
    }
  }
  const persisted = readConfigImage()
  let auditFailed = false
  try {
    const revision = createConfigRevision({ raw: persisted.config, source: 'structured' })
    candidateRevisionId = revision.revisionId
    markConfigRevisionHandled(revision)
  } catch {
    auditFailed = true
  }
  acknowledgeDisk()
  const state = engine.submit(
    persisted,
    auditFailed
      ? [
          {
            resource: '["audit"]',
            paths: [],
            semanticPaths: [],
            semantic: false,
            boundary: 'unsupported',
            status: 'failed',
            appliedRevision: engine.getState().appliedRevision,
            reason: '配置已保存，但审计修订登记失败；请检查修订存储后重试',
          },
        ]
      : [],
  )
  const result: ConfigCommitResult = {
    ok: true,
    ...state,
    baseRevision: imageRevision(persisted),
    candidateRevisionId: candidateRevisionId || imageRevision(persisted),
    warnings,
  }
  if (input.requestId) {
    if (requests.size >= 256) requests.delete(requests.keys().next().value!)
    requests.set(input.requestId, { fingerprint, result: structuredClone(result) })
  }
  return result
}
