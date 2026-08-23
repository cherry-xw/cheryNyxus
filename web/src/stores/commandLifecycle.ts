import type { ConnectionStatus } from '@/services/ws'

export type CanonicalCommandError = {
  code: string
  message: string
  retryable: boolean
  retryAfterMs?: number
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
    retryAfterMs?: number
    retryAfter?: number
  }
  const code = source?.code ?? 'INTERNAL'
  const retryAfterMs =
    typeof source?.retryAfterMs === 'number'
      ? source.retryAfterMs
      : typeof source?.retryAfter === 'number'
        ? source.retryAfter * 1000
        : undefined
  return {
    code,
    message: source instanceof Error ? source.message : fallback,
    retryable: ![
      'ROOT_REQUIRED',
      'PROFILE_VERSION_UNSUPPORTED',
      'RUNTIME_SELECTION_REQUIRED',
    ].includes(code),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  }
}

export function commandGateError(gate: Exclude<CommandGate, { allowed: true }>): Error & {
  code: string
  retryable: boolean
} {
  const error = new Error(gate.reason) as Error & { code: string; retryable: boolean }
  error.code = gate.code
  error.retryable = gate.retryable
  return error
}
