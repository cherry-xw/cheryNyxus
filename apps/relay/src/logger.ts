export interface RelayAuditEvent {
  requestId: string
  backendId?: string
  pathCategory: 'health' | 'list' | 'discovery' | 'binding' | 'backend-api' | 'backend-ws' | 'control' | 'unknown'
  status: number
  durationMs: number
  failureCategory?: string
}

export type RelayAuditLogger = (event: RelayAuditEvent) => void

export const jsonAuditLogger: RelayAuditLogger = (event) => {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), ...event })}\n`)
}
