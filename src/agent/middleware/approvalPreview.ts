import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { safeJsonParse } from '@/utils/json.js'
import { readRawConfig, redactConfigSecrets } from '@/utils/config.js'
import { applyConfigOperations, configOperationsSchema } from '@/service/config/operations.js'

const MAX_PREVIEW_BYTES = 1024 * 1024

export type ApprovalPreviewFile = {
  path: string
  before: string
  after: string
  kind: 'create' | 'modify' | 'delete'
}

export type ApprovalPreview = {
  files?: ApprovalPreviewFile[]
  error?: string
}

export type ApprovalSnapshot = { path: string; contentHash: string }

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function readText(file: string): string | undefined {
  if (!fs.existsSync(file)) return undefined
  const stat = fs.statSync(file)
  if (!stat.isFile()) throw new Error('目标不是文件')
  if (stat.size > MAX_PREVIEW_BYTES) throw new Error(`文件超过 ${MAX_PREVIEW_BYTES / 1024}KB，无法生成完整差异`)
  return fs.readFileSync(file, 'utf8')
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function assetFile(assetPath: string): string {
  const relative = assetPath.replaceAll('\\', '/').replace(/^\.chery\//, '')
  if (!/^(?:prompt\/.+\.md|skills\/[^/]+(?:\/.+)?|rule\/[^/]+\.ya?ml)$/i.test(relative) || relative.split('/').includes('..')) {
    throw new Error('资产路径不在允许范围内')
  }
  const root = path.resolve(process.env.CHERY_DIR || process.cwd(), '.chery')
  const absolute = path.resolve(root, relative)
  if (!absolute.startsWith(`${root}${path.sep}`)) throw new Error('资产路径越出 .chery 目录')
  return absolute
}

function writeFilePreview(args: Record<string, unknown>): ApprovalPreviewFile | undefined {
  if (typeof args.path !== 'string' || typeof args.content !== 'string') return undefined
  const before = readText(args.path) ?? ''
  let after = args.content
  if (typeof args.offset === 'number' && typeof args.limit === 'number') {
    const lines = before.split('\n')
    const start = Math.max(0, Math.min(args.offset, lines.length))
    const end = Math.max(start, Math.min(args.offset + args.limit, lines.length))
    after = [...lines.slice(0, start), ...args.content.split('\n'), ...lines.slice(end)].join('\n')
  }
  return { path: args.path, before, after, kind: fs.existsSync(args.path) ? 'modify' : 'create' }
}

/** Builds display-only approval data. The returned JSON must never be used to execute the tool. */
export function approvalPreview(name: string, argsJson: string): { arguments: string; snapshot?: ApprovalSnapshot } {
  const args = safeJsonParse(argsJson, {}) as Record<string, unknown>
  try {
    let files: ApprovalPreviewFile[] | undefined
    let snapshotPath: string | undefined
    if (name === 'write_file') {
      const file = writeFilePreview(args)
      if (file) {
        files = [file]
        snapshotPath = file.path
      }
    } else if (name === 'config_manage' && args.action === 'patch') {
      const operations = configOperationsSchema.safeParse(args.operations)
      if (!operations.success) throw new Error('配置操作参数无效，无法生成差异')
      const before = stableJson(redactConfigSecrets(readRawConfig()))
      const applied = applyConfigOperations(readRawConfig(), operations.data)
      if (!applied.ok) throw new Error(applied.errors.join('；'))
      files = [{ path: '.chery/config.yaml', before, after: stableJson(redactConfigSecrets(applied.candidate)), kind: 'modify' }]
    } else if (name === 'config_manage' && args.action === 'asset_save') {
      if (typeof args.assetPath !== 'string' || typeof args.content !== 'string') return { arguments: argsJson }
      const absolute = assetFile(args.assetPath)
      const before = readText(absolute) ?? ''
      files = [{ path: `.chery/${args.assetPath.replace(/^\.chery\//, '')}`, before, after: args.content, kind: before ? 'modify' : 'create' }]
      snapshotPath = absolute
    } else if (name === 'config_manage' && args.action === 'asset_archive') {
      if (typeof args.assetPath !== 'string') return { arguments: argsJson }
      const absolute = assetFile(args.assetPath)
      const before = readText(absolute)
      if (before === undefined) throw new Error('资产不存在，无法生成归档差异')
      files = [{ path: `.chery/${args.assetPath.replace(/^\.chery\//, '')}`, before, after: '', kind: 'delete' }]
      snapshotPath = absolute
    }
    if (!files) return { arguments: argsJson }
    const snapshotFile = files.length === 1 && (name === 'write_file' || args.action === 'asset_save' || args.action === 'asset_archive') ? files[0] : undefined
    return {
      arguments: JSON.stringify({ ...args, __filePreview: { files } satisfies ApprovalPreview }),
      snapshot: snapshotFile && snapshotPath
        ? { path: snapshotPath, contentHash: hash(snapshotFile.before) }
        : undefined,
    }
  } catch (error) {
    return {
      arguments: JSON.stringify({ ...args, __filePreview: { error: (error as Error).message } satisfies ApprovalPreview }),
    }
  }
}

/** Reject approval when an approved writable target changed after the user reviewed it. */
export function approvalSnapshotMatches(snapshot: ApprovalSnapshot): boolean {
  try {
    return hash(readText(snapshot.path) ?? '') === snapshot.contentHash
  } catch {
    return false
  }
}
