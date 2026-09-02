import type { OpenWorkspaceWindowInput } from '@/application/shell/public'

export type WorkspaceVisualEvent =
  | {
      type: 'failure'
      source: string
      message: string
      code?: string
      chatId?: string
    }
  | {
      type: 'business'
      event: 'workspace.boot' | 'quality.downgraded' | 'graph.fallback'
      message: string
      chatId?: string
    }

function shortHash(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
/** ERROR is reserved for genuine failures; decorative/business notices never use it. */
export function visualEventWindow(event: WorkspaceVisualEvent): OpenWorkspaceWindowInput {
  if (event.type === 'failure') {
    const fingerprint = shortHash(`${event.source}\u0000${event.code ?? ''}\u0000${event.message}`)
    return {
      resourceKey: `diagnostic:error:${fingerprint}`,
      title: `错误 // ${event.code ?? 'UNHANDLED'}`,
      context: {
        kind: 'diagnostic',
        severity: 'error',
        source: event.source,
        message: event.message,
        code: event.code,
        chatId: event.chatId,
        transient: true,
      },
      geometry: { width: 520, height: 310 },
      persistent: false,
      attention: true,
    }
  }
  const fingerprint = shortHash(`${event.event}\u0000${event.message}`)
  return {
    resourceKey: `diagnostic:event:${fingerprint}`,
    title: event.event === 'graph.fallback' ? '警告 // 图谱回退' : '诊断 // 系统事件',
    context: {
      kind: 'diagnostic',
      severity: event.event === 'graph.fallback' ? 'warning' : 'diagnostic',
      source: event.event,
      message: event.message,
      chatId: event.chatId,
      transient: true,
    },
    geometry: { width: 480, height: 280 },
    persistent: false,
    attention: event.event === 'graph.fallback',
  }
}
