/**
 * lite 详情：工具参数 / 结果的结构化解析与「英文键 → 中文标签」翻译。
 *
 * 供 LiteToolCallDetail 使用：
 * - 不同工具类型走各自的高亮字段（TOOL_TYPE_PRIMARY_FIELDS）——命令、路径、URL、任务说明等；
 * - 通用兜底把任意 JSON 字段转成「中文标签 + 值」行；
 * - 嵌套对象 / 数组递归翻译键后 pretty-print，避免整段英文 JSON 直接糊在 <pre> 里。
 */
import type { LiteToolType } from './executionMonitor'

/** 常见参数 / 结果字段的英文键 → 中文标签（键已归一化为 snake_case）。 */
const KEY_LABELS: Record<string, string> = {
  // 命令 / 执行
  command: '命令',
  cmd: '命令',
  description: '说明',
  // 文件 / 搜索
  path: '路径',
  file_path: '文件路径',
  filepath: '文件路径',
  filename: '文件名',
  file: '文件',
  content: '内容',
  offset: '起始行',
  line: '行号',
  limit: '行数限制',
  max_results: '结果上限',
  context_lines: '上下文行数',
  mode: '模式',
  regex: '正则匹配',
  pattern: '匹配模式',
  query: '查询',
  // 网络
  url: '链接',
  urls: '链接列表',
  source: '来源',
  headers: '请求头',
  timeout: '超时时间',
  // 结果 / 搜索产物
  results: '结果列表',
  matches: '匹配结果',
  files: '文件列表',
  total: '总计',
  count: '数量',
  items: '条目',
  // 结果状态
  status: '状态',
  exit_code: '退出码',
  pid: '进程 ID',
  duration: '耗时',
  output: '输出',
  stdout: '标准输出',
  stderr: '标准错误',
  error: '错误信息',
  message: '消息',
  log_path: '日志路径',
  success: '是否成功',
  // 委派 / 协作
  type: '类型',
  role: '角色',
  target: '目标',
  agent: '智能体',
  prompt: '任务说明',
  wake: '唤醒策略',
  // 提问
  question: '问题',
  options: '选项',
  multi_select: '多选',
  // 通用字段
  name: '名称',
  title: '标题',
  text: '文本',
  summary: '摘要',
  detail: '详情',
  reason: '原因',
  updated: '是否更新',
  created: '是否创建',
  deleted: '是否删除',
  // 技能 / 工具
  skill: '技能',
  skills: '技能列表',
  docs: '文档',
  tool: '工具',
  tools: '工具列表',
  args: '参数',
  arguments: '参数',
  result: '结果',
  // 会话 / 标识
  id: 'ID',
  chat_id: '会话 ID',
  conversation_id: '会话 ID',
  question_id: '问题 ID',
  call_id: '调用 ID',
  node_id: '节点 ID',
  key: '键',
  value: '值',
  // 环境 / 工程
  cwd: '工作目录',
  working_directory: '工作目录',
  env: '环境变量',
  branch: '分支',
  repo: '仓库',
  project: '项目',
  extension: '扩展名',
  language: '语言',
  // 时间 / 元信息
  time: '时间',
  timestamp: '时间戳',
  elapsed: '耗时',
  order: '顺序',
  sort: '排序',
  direction: '方向',
  page: '页码',
  page_size: '每页数量',
  cursor: '游标',
  size: '大小',
  bytes: '字节',
  lines: '行数',
  // 其他常见
  preview: '预览',
  snippet: '摘要',
  plan: '计划',
  task: '任务',
  tasks: '任务列表',
  todos: '待办列表',
  done: '是否完成',
  related: '相关',
  references: '引用',
  notes: '备注',
  tags: '标签',
  links: '链接列表',
  warnings: '警告',
}

/** 英文键 → 归一化 snake_case（camelCase 转下划线、空格/连字符转下划线、小写）。 */
export function normalizeKey(key: string): string {
  return key
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase()
}

/** 英文键 → 中文标签；未收录回退原键。 */
export function translateKey(key: string): string {
  return KEY_LABELS[normalizeKey(key)] ?? key
}

/** 解析字符串或对象为 unknown：JSON 字符串解析；非字符串直用；解析失败返回 undefined。 */
export function parseJsonValue(value: string | null | undefined): unknown {
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

/** 递归翻译对象 / 数组的键（叶子标量原样保留）。 */
function translateValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(translateValue)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[translateKey(k)] = translateValue(v)
    }
    return out
  }
  return value
}

/** 对象 / 数组 → 键已翻译的 pretty JSON；标量 / 解析失败 → 原样字符串。 */
export function prettyTranslatedJson(value: unknown): string {
  try {
    if (value === null || value === undefined) return ''
    if (typeof value === 'object') {
      return JSON.stringify(translateValue(value), null, 2) ?? ''
    }
    return String(value)
  } catch {
    return String(value ?? '')
  }
}

/** 已解析的一行字段（key=原始键，label=中文标签）。 */
export interface RenderedEntry {
  key: string
  label: string
  value: unknown
}

/** 把解析值转成「顶层字段」列表；非对象（含解析失败）返回 null。 */
export function toObjectEntries(value: unknown): RenderedEntry[] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return Object.entries(value as Record<string, unknown>).map(([key, val]) => ({
    key,
    label: translateKey(key),
    value: val,
  }))
}

/** 工具类型 → 高亮展示的字段（其余字段收进「更多参数」折叠区）。 */
export const TOOL_TYPE_PRIMARY_FIELDS: Readonly<Record<LiteToolType, readonly string[]>> = {
  exec: [
    'command',
    'cmd',
    'description',
    'output',
    'stdout',
    'stderr',
    'status',
    'exit_code',
    'duration',
    'error',
    'message',
    'log_path',
    'pid',
  ],
  read: [
    'path',
    'file_path',
    'filepath',
    'query',
    'pattern',
    'mode',
    'max_results',
    'context_lines',
    'limit',
    'offset',
    'results',
    'matches',
    'files',
    'line',
    'total',
    'content',
  ],
  write: [
    'path',
    'file_path',
    'filepath',
    'content',
    'offset',
    'limit',
    'status',
    'result',
    'message',
    'error',
    'updated',
    'created',
  ],
  web: [
    'url',
    'urls',
    'query',
    'source',
    'results',
    'matches',
    'title',
    'description',
    'snippet',
    'total',
    'error',
    'message',
  ],
  dispatch: ['role', 'type', 'target', 'prompt', 'wake', 'status', 'result', 'message', 'error', 'task'],
  other: [],
}

/** 该 key 是否为指定工具类型的高亮字段。 */
export function isPrimaryField(type: LiteToolType, key: string): boolean {
  const normalized = normalizeKey(key)
  return TOOL_TYPE_PRIMARY_FIELDS[type].some((field) => normalizeKey(field) === normalized)
}

/** 值是否为「标量」（可直接行内展示）；对象 / 数组走 pretty JSON。 */
export function isScalarValue(value: unknown): boolean {
  return value === null || typeof value !== 'object'
}

/** 标量 → 展示文本。 */
export function scalarText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return prettyTranslatedJson(value)
}
