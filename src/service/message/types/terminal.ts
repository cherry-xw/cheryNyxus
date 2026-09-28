export type TerminalTarget =
  | { kind: 'local'; cwd?: string }
  | {
      kind: 'ssh'
      host: string
      port?: number
      username: string
      credentialId?: string
      password?: string
      privateKey?: string
      passphrase?: string
    }

export interface TerminalCreateRequestData {
  chatId: string
  target?: TerminalTarget
  cols?: number
  rows?: number
}

export interface TerminalCreateResponseData {
  sessionId: string
  target: { kind: 'local' | 'ssh'; label: string }
  cols: number
  rows: number
}

export interface TerminalInputRequestData {
  sessionId: string
  data: string
}
export interface TerminalInputResponseData {
  sessionId: string
  accepted: boolean
}
export interface TerminalResizeRequestData {
  sessionId: string
  cols: number
  rows: number
}
export interface TerminalResizeResponseData {
  sessionId: string
  cols: number
  rows: number
}
export interface TerminalCloseRequestData {
  sessionId: string
}
export interface TerminalCloseResponseData {
  sessionId: string
  closed: boolean
}
export interface TerminalEventNotificationData {
  sessionId: string
  event: 'output' | 'exit' | 'error'
  data?: string
  code?: number | null
  signal?: string | null
  message?: string
}
