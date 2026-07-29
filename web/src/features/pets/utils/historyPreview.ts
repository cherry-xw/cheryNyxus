import type { HistoryItem, SenseCallRecord } from '@/stores/agents'
import type { useAgentsStore } from '@/stores'
import { hasRenderer } from '@/features/agent/renderers/registry'

/** AgentsStore 实例类型（iconForTool 等方法来源）。 */
type AgentsStore = ReturnType<typeof useAgentsStore>

/**
 * hover-bubble 内容预览。
 * - 有 content → 截 80 字
 * - 无 content 但有 senseCalls → 按工具类型分支展示
 *   - 内置（有 renderer） → icon + 解析后的关键字段（question / command / path / query / prompt 等）
 *   - 外部（无 renderer） → 「工具」前缀 + 工具名
 *   - 内置但解析失败 → 降级为 icon + 工具名
 * - 都没有 → "(空消息)"
 */
export function previewOf(item: HistoryItem, agents: AgentsStore): string {
  const text = (item.content ?? '').trim()
  if (text) return truncate(text, 80)
  const calls = item.senseCalls ?? []
  if (calls.length === 0) return '(空消息)'
  return calls.map((c) => toolSummaryOf(c, agents)).join('\n')
}

/** 截断到 n 字符，末尾省略号（hover-bubble 单行宽度有限）。 */
export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}

/** 单条 sense 调用的单行摘要。 */
export function toolSummaryOf(call: SenseCallRecord, agents: AgentsStore): string {
  const name = call.name || '(unknown)'
  const icon = agents.iconForTool(name)
  if (!hasRenderer(name)) return `工具 ${name}`
  const detail = parseToolDetail(call)
  return detail ? `${icon} ${truncate(detail, 80)}` : `${icon} ${name}`
}

/**
 * 按工具名从 args 提取关键展示字段。失败返回 null，调用方降级到「icon + name」。
 * 后端契约：args 可能是 JSON 字符串或对象（与 parseArgs.ts 一致）。
 */
export function parseToolDetail(call: SenseCallRecord): string | null {
  const obj = parseJsonObject(call.args)
  if (!obj) return null
  const s = (k: string): string | null => {
    const v = obj[k]
    return typeof v === 'string' && v.length > 0 ? v : null
  }
  switch (call.name) {
    case 'ask_user_question':
      return s('question')
    case 'execute_command':
      return s('command')
    case 'read_file':
    case 'write_file':
      return s('path')
    case 'search_codebase':
      return s('query')
    case 'spawn_role':
      return s('type')
    case 'skill':
      return s('name')
    case 'generate_image':
    case 'generate_video':
    case 'generate_audio':
      return s('prompt')
    case 'update_todo': {
      const todos = obj.todos
      if (!Array.isArray(todos) || todos.length === 0) return null
      const first = todos[0] as { content?: unknown } | undefined
      const content = typeof first?.content === 'string' ? first.content : ''
      return todos.length > 1 ? `${content} (+${todos.length - 1})` : content
    }
    default:
      return null
  }
}

/** args → 对象；失败返回 null。复用 parseArgs 的契约。 */
export function parseJsonObject(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) return null
    try {
      const v = JSON.parse(trimmed)
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        return v as Record<string, unknown>
      }
    } catch {
      /* 非 JSON → null */
    }
  }
  return null
}
