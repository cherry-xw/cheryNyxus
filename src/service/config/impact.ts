import { createHash } from 'node:crypto'
import type { ConfigImpact, HooksDraft } from '@chery/protocol'
import type { ConfigRaw } from '@/utils/config.js'

export interface ConfigImage {
  /** server is retained for complete disk diffing even though settings do not edit it. */
  config: ConfigRaw & { server?: unknown }
  hooks: HooksDraft
  /** Relative resource filename -> content hash; executable content is never exported. */
  assets?: Record<string, string>
}
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
export function imageRevision(value: unknown): string {
  return `config-${createHash('sha256').update(stable(value)).digest('hex')}`
}
export interface ConfigResource {
  path: string[]
  value: unknown
}
export function isTreeImpact(impact: ConfigImpact): boolean {
  const [root, name] = JSON.parse(impact.resource) as string[]
  return (
    impact.boundary === 'tree' ||
    (impact.boundary === 'resource' &&
      (root === 'mcp_servers' || (root === 'assets' && !name?.startsWith('hooks/'))))
  )
}
export function resources(image: ConfigImage): Map<string, ConfigResource> {
  const result = new Map<string, ConfigResource>()
  for (const [root, value] of Object.entries(image.config)) {
    const entries = root === 'llm' ? (value as ConfigRaw['llm']).brain : value
    if (root === 'mcp_servers' && (!entries || !Object.keys(entries).length)) continue
    const prefix = root === 'llm' ? ['llm', 'brain'] : [root]
    if (root === 'llm') {
      for (const [key, entry] of Object.entries(value))
        if (key !== 'brain') {
          const path = ['llm', key]
          result.set(JSON.stringify(path), { path, value: entry })
        }
    }
    if (entries && typeof entries === 'object' && !Array.isArray(entries)) {
      if (!Object.keys(entries).length)
        result.set(JSON.stringify(prefix), { path: prefix, value: entries })
      for (const [name, entry] of Object.entries(entries)) {
        const path = [...prefix, name]
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
          const separated = { ...entry } as Record<string, unknown>
          const localField = root === 'llm' ? 'hooks' : root === 'presets' ? 'schedule' : undefined
          if (localField) {
            const localPath = [...path, localField]
            if (localField in separated)
              result.set(JSON.stringify(localPath), {
                path: localPath,
                value: separated[localField],
              })
            delete separated[localField]
          }
          result.set(JSON.stringify(path), { path, value: separated })
        } else result.set(JSON.stringify(path), { path, value: entry })
      }
    } else result.set(JSON.stringify(prefix), { path: prefix, value: entries })
  }
  result.set('["hooks"]', { path: ['hooks'], value: image.hooks })
  for (const [name, hash] of Object.entries(image.assets ?? {})) {
    const path = ['assets', name]
    result.set(JSON.stringify(path), { path, value: hash })
  }
  return result
}
function leaves(before: unknown, after: unknown, path: string[]): string[][] {
  if (stable(before) === stable(after)) return []
  const isRecord = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v)
  if (isRecord(before) || isRecord(after)) {
    const a = isRecord(before) ? before : {},
      b = isRecord(after) ? after : {}
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
    if (keys.length) return keys.flatMap((k) => leaves(a[k], b[k], [...path, k]))
  }
  return [path]
}
const fields: Record<string, string[]> = {
  global: [
    'thinking',
    'supervision',
    'stream',
    'sense_execute_timeout',
    'approval_timeout',
    'approval_hard_timeout',
    'disconnect_grace_ms',
    'maxLoopCount',
    'bash_log_retention_hours',
    'textEditor',
    'file_compression',
    'logger',
    'command',
    'history_recall',
    'watchdog',
    'tree_full_render_threshold',
  ],
  llm: [
    'url',
    'model',
    'key',
    'thinking',
    'provider',
    'protocol',
    'rpm',
    'fullUrl',
    'mock',
    'contextLimit',
    'capabilities',
    'hooks',
    'anthropicCompat',
  ],
  roles: [
    'id',
    'kind',
    'brain',
    'avatar',
    'description',
    'mentionable',
    'senseGroup',
    'mcpServers',
    'systemPrompt',
    'skills',
    'plugins',
    'permissions',
    'lock',
  ],
  presets: [
    'id',
    'shadows',
    'detailRole',
    'leader',
    'roles',
    'mediaImage',
    'mediaVideo',
    'mediaAudio',
    'workspace',
    'rule',
    'schedule',
  ],
  media: ['type', 'url', 'model', 'key', 'enabled', 'maxUploadMb'],
  mcp_servers: ['transport', 'command', 'args', 'env', 'url', 'supervision'],
  memory: ['max_count', 'max_chars'],
}
const nested: Record<string, string[]> = {
  logger: ['level', 'output', 'timestamp', 'location', 'format'],
  file_compression: [
    'truncate_threshold',
    'truncate_preview_lines',
    'log_file_extensions',
    'drain_preview_count',
  ],
  history_recall: ['max_output_chars'],
  watchdog: ['timeout_ms', 'wake_on_timeout'],
  command: ['warn', 'auto', 'min_context_limit', 'safety_margin', 'unit', 'value'],
  capabilities: ['toolCall', 'input', 'generate', 'image', 'video', 'audio'],
  mock: ['enabled', 'file', 'chunkDelayMs', 'preRespondMs'],
  anthropicCompat: ['official'],
  shadows: ['conversationRouting'],
  schedule: ['cron', 'task', 'enabled'],
  permissions: [
    'template',
    'tools',
    'filesystem',
    'read',
    'write',
    'commands',
    'shells',
    'maxSandboxMode',
    'categories',
    'mcp',
    'default',
    'spawn',
    'allowedRoles',
    'effect',
  ],
}
function boundary(path: string[]): { boundary: ConfigImpact['boundary']; semantic: boolean } {
  const [root = '', name = ''] = path
  if (root === 'assets')
    return {
      boundary:
        name === 'model-catalog.yaml' ||
        /^(prompt|skills|senses|plugins|rule|command|hooks)\//.test(name)
          ? 'resource'
          : 'unsupported',
      semantic: true,
    }
  if (root === 'llm' && name !== 'brain') return { boundary: 'unsupported', semantic: true }
  if (root === 'hooks') return { boundary: 'resource', semantic: true }
  if (root === 'llm' && path[3] === 'hooks') return { boundary: 'resource', semantic: true }
  if (root === 'presets' && path[2] === 'schedule') return { boundary: 'resource', semantic: false }
  if (root === 'server') return { boundary: 'restart', semantic: false }
  if (root === 'sense_groups') return { boundary: 'tree', semantic: true }
  const offset = root === 'global' ? 1 : root === 'llm' ? 3 : 2
  const field = path[offset]
  const known = fields[root]
  if (
    !known ||
    (root === 'memory' && !['global', 'workspace'].includes(name)) ||
    (field !== undefined && !known.includes(field))
  )
    return { boundary: 'unsupported', semantic: true }
  if (field && path.length > offset + 1) {
    const rest = path.slice(offset + 1)
    const dynamic =
      field === 'env' ||
      (field === 'permissions' && rest.some((k) => ['tools', 'categories'].includes(k)))
    if (!dynamic && (!nested[field] || rest.some((k) => !nested[field]!.includes(k))))
      return { boundary: 'unsupported', semantic: true }
  }
  if (root === 'global')
    return {
      boundary: [
        'textEditor',
        'file_compression',
        'history_recall',
        'logger',
        'command',
        'bash_log_retention_hours',
      ].includes(name)
        ? 'operation'
        : 'run',
      semantic: false,
    }
  if (root === 'llm') {
    const semantic =
      !field || ['model', 'provider', 'protocol', 'capabilities', 'hooks'].includes(field)
    return { boundary: semantic ? 'tree' : 'run', semantic }
  }
  if (root === 'media' || root === 'memory') return { boundary: 'operation', semantic: false }
  if (root === 'mcp_servers') return { boundary: 'resource', semantic: true }
  if (root === 'roles' && field && ['avatar', 'description', 'mentionable'].includes(field))
    return { boundary: 'operation', semantic: false }
  if (root === 'presets' && field === 'schedule') return { boundary: 'resource', semantic: false }
  return { boundary: 'tree', semantic: true }
}
export function diffResources(
  before: Map<string, ConfigResource>,
  after: Map<string, ConfigResource>,
  revision: string,
): ConfigImpact[] {
  const priority = ['operation', 'run', 'resource', 'tree', 'restart', 'unsupported']
  return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap((resource) => {
    const a = before.get(resource),
      b = after.get(resource)
    const changed = leaves(a?.value, b?.value, (b ?? a)!.path)
    if (!changed.length) return []
    const kinds = changed.map(boundary)
    const selected = kinds.reduce((a, b) =>
      priority.indexOf(a.boundary) >= priority.indexOf(b.boundary) ? a : b,
    )
    return [
      {
        resource,
        paths: changed.map(
          (p) => '/' + p.map((k) => k.replaceAll('~', '~0').replaceAll('/', '~1')).join('/'),
        ),
        semanticPaths: changed
          .filter((_, i) => kinds[i]!.semantic)
          .map((p) => '/' + p.map((k) => k.replaceAll('~', '~0').replaceAll('/', '~1')).join('/')),
        semantic: kinds.some((k) => k.semantic),
        boundary: selected.boundary,
        status: 'pending' as const,
        appliedRevision: revision,
        reason:
          selected.boundary === 'unsupported'
            ? '未登记字段，不支持自动应用'
            : '等待模块接入或安全边界',
      },
    ]
  })
}
export function destructiveTargets(before: ConfigRaw, after: ConfigRaw): string[] {
  return (['roles', 'presets'] as const)
    .flatMap((root) => {
      const next = Object.entries(after[root] ?? {})
      return Object.entries(before[root] ?? {}).flatMap(([name, value]) =>
        next.some(([n, v]) => (value.id ? v.id === value.id : n === name))
          ? []
          : [`${root}/${value.id ?? name}`],
      )
    })
    .sort()
}
