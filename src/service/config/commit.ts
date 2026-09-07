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
  readRuntimeConfigSource,
  restoreRedactedSecrets,
  saveRawConfig,
  validateConfigCandidate,
  validateLoadable,
  type ConfigRaw,
  getAppliedRawConfig,
} from '@/utils/config.js'
import { loadHookRegistry, readGlobalHooks } from '@/agent/hooks/registry.js'
import {
  createConfigRevision,
  markConfigRevisionHandled,
  collectRuntimeResourceManifest,
  ensureCurrentConfigRevision,
} from './revision.js'
import { ConfigApplyCoordinator } from './applyCoordinator.js'
import {
  setMcpReloadCoordinator,
  mcpReloadSummary,
  listConnectedServerNames,
} from '@/core/mcp/loader.js'
import { McpServerError } from '@/core/mcp/types.js'
import { setMcpIdleListener } from '@/core/mcp/lifetime.js'
import { registerRuntimeConfigAdapters } from './runtimeApply.js'
import {
  destructiveTargets,
  diffResources,
  imageRevision,
  resources,
  stable,
  isTreeImpact,
  type ConfigImage,
} from './impact.js'
import { getRootChatIdForEpoch } from '@/db/epoch.js'
import {
  activeRootIds,
  setTreeConfigBoundary,
  treeBoundaryReason,
  treeUsesImpacts,
} from './treeBoundary.js'

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
const handledDiskImages = new Set<string>()
function configPaths(): { config: string; hooks: string } {
  const root = path.join(process.env.CHERY_DIR || process.cwd(), '.chery')
  return { config: path.join(root, 'config.yaml'), hooks: path.join(root, 'hooks', 'hooks.json') }
}
export function readConfigImage(): ConfigImage {
  const root = process.env.CHERY_DIR || process.cwd()
  const source = readRuntimeConfigSource(root)
  const raw = readRawConfig() as ConfigImage['config']
  raw.server = structuredClone(source.server ?? { port: 8182, transport: 'binary' })
  const hooks = readGlobalHooks()
  const manifest = collectRuntimeResourceManifest().entries as Array<{
    path: string
    sha256: string
  }>
  const assets = Object.fromEntries(
    manifest
      .filter((entry) => !['config.yaml', 'hooks/hooks.json'].includes(entry.path))
      .map((entry) => [entry.path, entry.sha256]),
  )
  return { config: raw, hooks, assets }
}
export function getSavedBaseRevision(image = readConfigImage()): string {
  return imageRevision(image)
}
export function getConfigApplyCoordinator(): ConfigApplyCoordinator {
  if (!coordinator) {
    loadHookRegistry() // retain old hooks until the module adopts the saved candidate
    const image = readConfigImage()
    // A first explicit MCP reload may follow an external edit. Disk is not proof
    // that the existing connections have adopted those parameters.
    image.config.mcp_servers = getAppliedRawConfig().mcp_servers
    ensureCurrentConfigRevision()
    coordinator = new ConfigApplyCoordinator(image)
    registerRuntimeConfigAdapters(coordinator, image)
    const engine = coordinator
    setMcpReloadCoordinator(reloadMcpConfiguration, (name) => {
      const impact = engine
        .getState()
        .impacts.find((item) => item.resource === JSON.stringify(['mcp_servers', name]))
      return { applyStatus: impact?.status ?? 'applied', applyReason: impact?.reason }
    })
    setMcpIdleListener(() => {
      void engine.retry().catch(() => {})
    })
    setTreeConfigBoundary({
      retry: () => engine.retry(),
      admission(chatId) {
        const pending = engine
          .getState()
          .impacts.filter((impact) => isTreeImpact(impact) && impact.status !== 'applied')
        if (!pending.length) return undefined
        const rootId = getRootChatIdForEpoch(chatId)
        if (
          !treeUsesImpacts(rootId, getAppliedRawConfig(), pending) &&
          !treeUsesImpacts(rootId, engine.getSavedImage().config, pending)
        )
          return undefined
        // Existing work, including approvals and child wakeups, drains on its old
        // config. Idle/new trees cannot start a fresh run on pending semantics.
        if (treeBoundaryReason(rootId)) return undefined
        return '该节点树依赖的配置尚未生效，请等待受影响任务结束或查看设置生效状态'
      },
    })
  }
  return coordinator
}

/** Explicit MCP reload uses the saved candidate and the same tree transaction as save. */
export async function reloadMcpConfiguration(name?: string) {
  const engine = getConfigApplyCoordinator()
  const image = engine.getSavedImage()
  const disk = readRawConfig()
  if (name) {
    if (!disk.mcp_servers?.[name] && !image.config.mcp_servers?.[name])
      throw new McpServerError(`扩展工具 "${name}" 没配置`, 'NOT_FOUND')
    image.config.mcp_servers ??= {}
    if (disk.mcp_servers?.[name]) image.config.mcp_servers[name] = disk.mcp_servers[name]
    else delete image.config.mcp_servers[name]
  } else image.config.mcp_servers = disk.mcp_servers
  const check = validateLoadable(image.config)
  if (!check.ok) throw new Error('MCP 配置校验失败，请检查已保存设置')
  registerRuntimeConfigAdapters(engine, image)
  engine.submit(image)
  if (name && image.config.mcp_servers?.[name])
    engine.requestResourceReload(JSON.stringify(['mcp_servers', name]))
  if (!name) {
    const connected = new Set(listConnectedServerNames())
    for (const server of Object.keys(image.config.mcp_servers ?? {}))
      if (!connected.has(server))
        engine.requestResourceReload(JSON.stringify(['mcp_servers', server]))
  }
  await engine.retry()
  const apply = engine.getState()
  const result = mcpReloadSummary()
  return { ...result, apply }
}
export function isStructuredConfigImageHandled(image = readConfigImage()): boolean {
  return handledDiskImages.has(imageRevision(image))
}
export function consumeHandledConfigImage(image: ConfigImage): boolean {
  return handledDiskImages.delete(imageRevision(image))
}
function acknowledgeDisk(image = readConfigImage()): void {
  if (handledDiskImages.size >= 64)
    handledDiskImages.delete(handledDiskImages.values().next().value!)
  handledDiskImages.add(imageRevision(image))
}

export function submitDiskConfigImage(source: 'manual' | 'structured' = 'manual') {
  const image = readConfigImage()
  const check = validateLoadable(image.config)
  if (!check.ok) throw new Error(check.errors.join('\n'))
  const engine = getConfigApplyCoordinator()
  createConfigRevision({ raw: image.config, source })
  registerRuntimeConfigAdapters(engine, image)
  const state = engine.submit(image)
  acknowledgeDisk(image)
  return state
}

function referencesEnv(value: unknown, changed: ReadonlySet<string>): boolean {
  if (typeof value === 'string') {
    const match = /^\$([A-Z_][A-Z0-9_]*)$/.exec(value)
    return !!match?.[1] && changed.has(match[1])
  }
  if (Array.isArray(value)) return value.some((entry) => referencesEnv(entry, changed))
  return (
    !!value &&
    typeof value === 'object' &&
    Object.values(value).some((entry) => referencesEnv(entry, changed))
  )
}

/** Re-resolve only resources that refer to changed .env names. Root/process
 * bindings stay on their startup values and surface as restart work. */
export function submitEnvironmentRefresh(image: ConfigImage, names: readonly string[]) {
  const engine = getConfigApplyCoordinator()
  registerRuntimeConfigAdapters(engine, image)
  engine.submit(image)
  const changed = new Set(names)
  for (const [resource, entry] of resources(image)) {
    if (referencesEnv(entry.value, changed)) engine.requestResourceReload(resource)
  }
  if (
    names.some((name) =>
      ['CHERY_DIR', 'DB_DIR', 'WEB_PORT', 'CHERY_AUTH_SESSION_SECRET'].includes(name),
    )
  ) {
    for (const [resource, entry] of resources(image)) {
      if (entry.path[0] === 'server') engine.requestResourceReload(resource)
    }
  }
  return engine.getState()
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
  const candidate = Object.assign(
    restoreRedactedSecrets(structuredClone(input.candidate), before.config),
    { server: structuredClone(before.config.server ?? {}) },
  )
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
    ).map((impact) => ({
      ...impact,
      ...(isTreeImpact(impact)
        ? {
            affectedRootChatIds: activeRootIds().filter(
              (id) =>
                treeUsesImpacts(id, checked.before.config, [impact]) ||
                treeUsesImpacts(id, checked.image.config, [impact]),
            ),
          }
        : {}),
    })),
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
  acknowledgeDisk(persisted)
  registerRuntimeConfigAdapters(engine, persisted)
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
