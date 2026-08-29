import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import config, {
  readRawConfig,
  redactConfigSecrets,
  type ConfigRaw,
} from '@/utils/config.js'
import {
  activateConfigRevision,
  getActiveConfigRevision,
  rejectConfigRevision,
  upsertConfigRevision,
  type ConfigRevisionRecord,
} from '@/db/epoch.js'

const SENSITIVE_KEY = /(?:key|token|secret|password|passwd|credential|authorization|auth)/i
const INCLUDED_ROOTS = ['prompt', 'skills', 'senses', 'plugins', 'rule', 'command', 'hooks']
const INCLUDED_FILES = ['config.yaml', 'model-thinking.yaml']
let processRevision: ConfigRevisionRecord | undefined
const handledCandidateFingerprints = new Set<string>()

function redact(value: unknown, key = ''): unknown {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]'
  if (Array.isArray(value)) return value.map((entry) => redact(entry))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([childKey, child]) => [childKey, redact(child, childKey)]),
    )
  }
  return value
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

// ========== 语义面 / 连接面分层（见 docs/context-epochs.md「配置修订的语义面与连接面」） ==========
//
// fingerprint 只覆盖语义面：影响发往 LLM 的消息内容或工具契约的字段属语义面；
// 只影响请求目标、请求参数或执行策略的字段属连接面（url/key/rpm/超时等），变更仅热更新运行配置。
// 裁剪用排除法：剔除已登记的连接面字段，其余（未登记字段）默认按语义面保守兜底。

/** 已登记为连接面的顶层配置 roots（从语义面 snapshot 中剔除）。 */
const CONNECTION_ROOTS = ['global', 'memory', 'media', 'server'] as const

/** brain 配置内已登记为连接面的字段（url/key/rpm/fullUrl/contextLimit/thinking/anthropicCompat）。 */
const CONNECTION_BRAIN_FIELDS = new Set([
  'url',
  'key',
  'rpm',
  'fullUrl',
  'contextLimit',
  'thinking',
  'anthropicCompat',
])

/**
 * 从脱敏 snapshot 提取语义面子集：剔除连接面顶层 roots 与 llm.brain.<n> 的连接面字段，
 * 其余全部保留（未登记字段默认语义面）。
 */
function extractSemanticConfig(snapshot: Record<string, unknown>): Record<string, unknown> {
  const semantic: Record<string, unknown> = {}
  for (const [root, value] of Object.entries(snapshot)) {
    if ((CONNECTION_ROOTS as readonly string[]).includes(root)) continue
    if (root === 'llm') {
      const brains = (value as { brain?: Record<string, unknown> } | undefined)?.brain
      if (brains && typeof brains === 'object') {
        const semanticBrains: Record<string, unknown> = {}
        for (const [name, brain] of Object.entries(brains)) {
          const b = (brain ?? {}) as Record<string, unknown>
          semanticBrains[name] = Object.fromEntries(
            Object.entries(b).filter(([field]) => !CONNECTION_BRAIN_FIELDS.has(field)),
          )
        }
        semantic.llm = { brain: semanticBrains }
      }
      continue
    }
    semantic[root] = value
  }
  return semantic
}

/**
 * fingerprint 用资源清单：剔除 `config.yaml` 条目（其文件哈希随连接面变化），
 * `model-thinking.yaml` 与资源目录（prompt/skills/...）保留——均属语义面。
 */
function semanticResourceManifest(resources: Record<string, unknown>): Record<string, unknown> {
  const entries = Array.isArray(resources.entries)
    ? resources.entries.filter(
        (entry) =>
          !(entry as { path?: string } | null)?.path ||
          (entry as { path: string }).path !== 'config.yaml',
      )
    : resources.entries
  return { ...resources, entries }
}

function walkFiles(root: string): string[] {
  if (!fs.existsSync(root)) return []
  const result: string[] = []
  const visit = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) visit(absolute)
      else if (entry.isFile()) result.push(absolute)
    }
  }
  visit(root)
  return result.sort((a, b) => a.localeCompare(b))
}

/** Hash-only manifest. Runtime snapshots never retain credentials or executable source. */
export function collectRuntimeResourceManifest(): Record<string, unknown> {
  const cheryRoot = path.resolve(config.global.prompts_dir, '..')
  const files = [
    ...INCLUDED_FILES.map((name) => path.join(cheryRoot, name)).filter(fs.existsSync),
    ...INCLUDED_ROOTS.flatMap((name) => walkFiles(path.join(cheryRoot, name))),
  ]
  const entries = files.map((absolute) => {
    const relative = path.relative(cheryRoot, absolute).replaceAll('\\', '/')
    const content = fs.readFileSync(absolute)
    return { path: relative, sha256: sha256(content), size: content.byteLength }
  })
  return {
    version: 1,
    root: '.chery',
    entries,
  }
}

export function createConfigRevision(input: {
  raw?: ConfigRaw
  source: ConfigRevisionRecord['source']
  status?: 'candidate' | 'active' | 'rejected'
  validationError?: string
}): ConfigRevisionRecord {
  const raw = input.raw ?? readRawConfig()
  const snapshot = redact(redactConfigSecrets(raw)) as Record<string, unknown>
  const resources = collectRuntimeResourceManifest()
  // fingerprint 只覆盖语义面（连接面变更不产生新修订、不切纪元）；snapshot/resources 仍存全量供审计
  const semanticImage = {
    snapshot: extractSemanticConfig(snapshot),
    resources: semanticResourceManifest(resources),
  }
  // rejected 记录不能与相同语义面的 active 记录共用唯一 fingerprint。例如 workspace、URL
  // 等连接面字段校验失败时，直接复用 active 会导致 rejectConfigRevision 试图拒绝活动修订。
  const fingerprint = sha256(
    stableStringify(
      input.status === 'rejected'
        ? {
            rejected: snapshot,
            semanticImage,
            validationError: input.validationError ?? '配置验证失败',
          }
        : semanticImage,
    ),
  )
  const revision = upsertConfigRevision({
    fingerprint,
    source: input.source,
    snapshot,
    resources,
    status: input.status ?? 'candidate',
    validationError: input.validationError,
  })
  if (input.status === 'rejected' && revision.status !== 'rejected') {
    rejectConfigRevision(revision.revisionId, input.validationError ?? '配置验证失败')
    return { ...revision, status: 'rejected', validationError: input.validationError }
  }
  return revision
}

/**
 * Process startup is the activation boundary: imports already hold one validated
 * config image, so a differing disk fingerprint becomes the next active revision.
 */
export function ensureCurrentConfigRevision(): ConfigRevisionRecord {
  if (processRevision) return processRevision
  const current = createConfigRevision({ source: 'startup' })
  const active = getActiveConfigRevision()
  processRevision =
    active?.fingerprint === current.fingerprint
      ? active
      : activateConfigRevision(current.revisionId)
  return processRevision
}

/**
 * Structured saves already applied lifecycle effects and scheduled a restart.
 * The filesystem watcher consumes this one-shot acknowledgement so the same
 * disk write is not misclassified and applied again as a manual edit.
 */
export function markConfigRevisionHandled(revision: ConfigRevisionRecord): void {
  handledCandidateFingerprints.add(revision.fingerprint)
}

export function consumeHandledConfigRevision(fingerprint: string): boolean {
  return handledCandidateFingerprints.delete(fingerprint)
}

/** Tests and a future maintenance worker may force a fresh disk fingerprint. */
export function clearProcessRevisionCache(): void {
  processRevision = undefined
  handledCandidateFingerprints.clear()
}
