import type { ConnectionStatus } from '@/services/ws'
import type { ErrorSource, ProtocolError, UserFeedback } from '@chery/protocol'

export type CanonicalCommandError = ProtocolError

let localTraceSequence = 0

function localTracingId(code: string): string {
  localTraceSequence += 1
  return `local:${code}:${Date.now().toString(36)}:${localTraceSequence.toString(36)}`
}

function errorSource(value: unknown): ErrorSource {
  return typeof value === 'string' &&
    ['brain', 'sense', 'media', 'mcp', 'chat', 'system', 'hook', 'config', 'transport'].includes(
      value,
    )
    ? (value as ErrorSource)
    : 'system'
}

function localCommandFeedback(input: {
  code: string
  message: string
  source: ErrorSource
  tracingId: string
  retryable: boolean
}): UserFeedback {
  const preset: Record<
    string,
    { title: string; guidance: string; actions: UserFeedback['actions'] }
  > = {
    ROOT_REQUIRED: {
      title: '请先选择会话',
      guidance: '创建或选择一个会话后再执行此操作。',
      actions: [{ type: 'select_chat' }],
    },
    CONNECTING: {
      title: '正在连接服务',
      guidance: '连接完成后即可继续。',
      actions: [{ type: 'reconnect' }],
    },
    RECONNECTING: {
      title: '服务连接已断开',
      guidance: '请重新连接后继续。',
      actions: [{ type: 'reconnect' }],
    },
    HYDRATING: {
      title: '会话仍在加载',
      guidance: '请稍候，加载完成后重试。',
      actions: [{ type: 'retry' }],
    },
    SESSION_UNAVAILABLE: {
      title: '当前会话暂不可用',
      guidance: '请重新加载会话；如果持续出现，请查看详情。',
      actions: [{ type: 'retry' }, { type: 'view_details' }],
    },
  }
  const selected = preset[input.code] ?? {
    title: '操作没有完成',
    guidance: input.retryable ? '请稍后重试。' : '请检查当前状态后再试。',
    actions: input.retryable
      ? ([{ type: 'retry' }] satisfies UserFeedback['actions'])
      : ([{ type: 'dismiss' }] satisfies UserFeedback['actions']),
  }
  return {
    code: input.code,
    severity: input.code === 'CONNECTING' || input.code === 'HYDRATING' ? 'info' : 'warning',
    source: input.source,
    title: selected.title,
    description: input.message,
    guidance: selected.guidance,
    actions: selected.actions,
    retention: 'transient',
    tracingId: input.tracingId,
  }
}

export interface CommandGateInput {
  connectionStatus: ConnectionStatus
  rootChatId?: string
  hydrated: boolean
  hydrating?: boolean
  fatalError?: string | null
}

export type CommandGate =
  { allowed: true } | { allowed: false; code: string; reason: string; retryable: boolean }

/** Shared guard used by the full workbench and Lite adapters. */
export function commandGate(input: CommandGateInput): CommandGate {
  if (!input.rootChatId) {
    return { allowed: false, code: 'ROOT_REQUIRED', reason: '请先创建或选择会话', retryable: false }
  }
  if (input.connectionStatus !== 'connected') {
    const connecting = input.connectionStatus === 'connecting'
    return {
      allowed: false,
      code: connecting ? 'CONNECTING' : 'RECONNECTING',
      reason: connecting ? '正在连接服务，请稍候' : '连接已断开，重连后可继续',
      retryable: true,
    }
  }
  if (input.hydrating || !input.hydrated) {
    return {
      allowed: false,
      code: 'HYDRATING',
      reason: '会话状态仍在加载，请稍候',
      retryable: true,
    }
  }
  if (input.fatalError) {
    return {
      allowed: false,
      code: 'SESSION_UNAVAILABLE',
      reason: input.fatalError,
      retryable: true,
    }
  }
  return { allowed: true }
}

export function commandErrorFact(cause: unknown, fallback: string): CanonicalCommandError {
  const source = cause as Error & {
    code?: string
    source?: ErrorSource
    retryable?: boolean
    tracingId?: string
    retryAfterMs?: number
    retryAfter?: number
    feedback?: UserFeedback
  }
  const code = source?.code ?? 'INTERNAL'
  const retryAfterMs =
    typeof source?.retryAfterMs === 'number'
      ? source.retryAfterMs
      : typeof source?.retryAfter === 'number'
        ? source.retryAfter * 1000
        : undefined
  const message = source instanceof Error ? source.message : fallback
  const resolvedSource = errorSource(source?.source)
  const retryable =
    typeof source?.retryable === 'boolean'
      ? source.retryable
      : !['ROOT_REQUIRED', 'PROFILE_VERSION_UNSUPPORTED', 'RUNTIME_SELECTION_REQUIRED'].includes(
          code,
        )
  const tracingId =
    typeof source?.tracingId === 'string' && source.tracingId.length > 0
      ? source.tracingId
      : localTracingId(code)
  return {
    code,
    message,
    source: resolvedSource,
    retryable,
    tracingId,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    feedback:
      source?.feedback ??
      localCommandFeedback({ code, message, source: resolvedSource, tracingId, retryable }),
  }
}

export function commandGateError(gate: Exclude<CommandGate, { allowed: true }>): Error & {
  code: string
  source: ErrorSource
  retryable: boolean
  tracingId: string
} {
  const error = new Error(gate.reason) as Error & {
    code: string
    source: ErrorSource
    retryable: boolean
    tracingId: string
  }
  error.code = gate.code
  error.source = gate.code === 'CONNECTING' || gate.code === 'RECONNECTING' ? 'transport' : 'chat'
  error.retryable = gate.retryable
  error.tracingId = localTracingId(gate.code)
  return error
}
