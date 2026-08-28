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
  const fingerprint = sha256(stableStringify({ snapshot, resources }))
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
