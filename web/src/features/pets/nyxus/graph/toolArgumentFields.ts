/** Shared, semantic tool argument/result field parsing. */

export const FIELD_LABELS: Record<string, string> = {
  action: '操作',
  activeForm: '进行时描述',
  batchId: '问题批次',
  childId: '子角色',
  compression: '压缩方式',
  content: '内容',
  contextLines: '上下文行数',
  description: '说明',
  explanation: '说明',
  freeText: '补充回答',
  header: '分组标题',
  instruction: '指令',
  label: '选项名称',
  labels: '已选目标',
  limit: '数量限制',
  maxResults: '最大结果数',
  mode: '模式',
  multiSelect: '选择方式',
  name: '名称',
  offset: '起始位置',
  options: '可选目标',
  path: '路径',
  prompt: '提示词',
  query: '查询内容',
  question: '问题',
  reason: '原因',
  regex: '正则匹配',
  replaceReason: '替换原因',
  replaceTarget: '替换目标',
  scope: '作用范围',
  status: '状态',
  task: '任务',
  todos: '待办事项',
  type: '类型',
  url: '地址',
  wake: '唤醒方式',
  command: '命令',
}

export type FieldKind =
  | 'command'
  | 'path'
  | 'url'
  | 'group'
  | 'list'
  | 'boolean'
  | 'scalar'
  | 'multiline'
  | 'text'

export interface FieldView {
  /** Stable full path, suitable for keys/copy state. */
  key: string
  /** Raw key at this level. */
  rawKey: string
  label: string
  value: string
  kind: FieldKind
  depth: number
  children?: FieldView[]
}

export function parseRecord(source?: string): Record<string, unknown> {
  if (!source) return {}
  try {
    const value: unknown = JSON.parse(source)
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** Parse JSON objects/arrays into fields; malformed or scalar text stays a raw fallback. */
export function parseFieldViews(source?: string, rootLabel = '执行结果'): FieldView[] {
  if (!source) return []
  try {
    const value: unknown = JSON.parse(source)
    if (Array.isArray(value)) return [fieldView(rootLabel, value)]
    if (value && typeof value === 'object') return fieldViews(value as Record<string, unknown>)
    return []
  } catch {
    return []
  }
}

export function displayValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return ''
  if (value === null) return '空值'
  if (typeof value === 'boolean') return value ? '是' : '否'
  return JSON.stringify(value, null, 2)
}

function readableKey(key: string): string {
  return key
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function fieldLabel(key: string): string {
  const known = FIELD_LABELS[key]
  if (known) return known
  const readable = readableKey(key)
  return readable && readable !== key ? `${readable}（${key}）` : key || '未命名字段'
}

export function fieldKind(key: string, value: unknown): FieldKind {
  if (Array.isArray(value)) return 'list'
  if (value && typeof value === 'object') return 'group'
  if (key === 'command') return 'command'
  if (/^(path|cwd|file|filePath|root)$/i.test(key)) return 'path'
  if (/^(url|uri|href)$/i.test(key)) return 'url'
  if (typeof value === 'boolean') return 'boolean'
  if (key === 'content' && typeof value === 'string') return 'multiline'
  if (typeof value === 'number' || value === null) return 'scalar'
  return 'text'
}

function childPath(parent: string, key: string, arrayItem = false): string {
  if (!parent) return key
  return arrayItem ? `${parent}[${key}]` : `${parent}.${key}`
}

export function fieldView(
  key: string,
  value: unknown,
  options: { path?: string; depth?: number; arrayItem?: boolean } = {},
): FieldView {
  const depth = options.depth ?? 0
  const path = childPath(options.path ?? '', key, options.arrayItem)
  const kind = fieldKind(key, value)
  const label = options.arrayItem ? `第 ${Number(key) + 1} 项` : fieldLabel(key)
  let children: FieldView[] | undefined

  if (Array.isArray(value)) {
    children = value.map((item, index) =>
      fieldView(String(index), item, { path, depth: depth + 1, arrayItem: true }),
    )
  } else if (value && typeof value === 'object') {
    children = Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) =>
      fieldView(childKey, childValue, { path, depth: depth + 1 }),
    )
  }

  return {
    key: path,
    rawKey: key,
    label,
    value:
      kind === 'list'
        ? `${(value as unknown[]).length} 项`
        : kind === 'group'
          ? `${Object.keys(value as Record<string, unknown>).length} 个字段`
          : displayValue(value),
    kind,
    depth,
    ...(children?.length ? { children } : {}),
  }
}

export function fieldViews(record: Record<string, unknown>): FieldView[] {
  return Object.entries(record).map(([key, value]) => fieldView(key, value))
}

export function flattenFieldViews(fields: readonly FieldView[]): FieldView[] {
  return fields.flatMap((field) => [field, ...flattenFieldViews(field.children ?? [])])
}
