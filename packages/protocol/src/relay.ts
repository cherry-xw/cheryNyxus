export const RELAY_PROTOCOL_VERSION = 1 as const

export const RELAY_ERROR_CODES = [
  'INVALID_REQUEST',
  'BACKEND_AUTH_FAILED',
  'SESSION_BACKEND_MISMATCH',
  'BACKEND_NOT_FOUND',
  'BACKEND_ID_CONFLICT',
  'BACKEND_OFFLINE',
  'REQUEST_TOO_LARGE',
  'PROTOCOL_VERSION_UNSUPPORTED',
  'RATE_LIMITED',
  'CAPACITY_EXCEEDED',
  'BACKEND_UNAVAILABLE',
  'BACKEND_TIMEOUT',
] as const

export type RelayErrorCode = (typeof RELAY_ERROR_CODES)[number]
export type RelayBackendStatus = 'online' | 'offline'

export interface RelayErrorBody {
  error: {
    code: RelayErrorCode
    message: string
    requestId: string
    retryAfterSeconds?: number
  }
}

export interface RelayBackendCapabilities {
  http: boolean
  websocket: boolean
}

export interface RelayBackendSummary {
  backendId: string
  displayName: string
  status: RelayBackendStatus
  capabilities: RelayBackendCapabilities
  lastSeenAt: string
}

export interface RelayDiscovery extends RelayBackendSummary {
  transport: 'binary'
  httpBasePath: string
  wsPath: string
}

export interface RelayChallenge {
  type: 'challenge'
  protocolVersion: typeof RELAY_PROTOCOL_VERSION
  nonce: string
  expiresAt: string
}

export interface RelayHello {
  type: 'hello'
  protocolVersion: number
  backendId: string
  displayName: string
  publicKey: string
  signature: string
  configVersion: number
  capabilities: RelayBackendCapabilities
}

export interface RelayAccepted {
  type: 'accepted'
  protocolVersion: typeof RELAY_PROTOCOL_VERSION
  backendId: string
  leaseId: string
  heartbeatIntervalMs: number
  leaseExpiresAt: string
  configVersion: number
  tunnel: {
    httpService: string
    websocketService: string
    token: string
  }
}

export interface RelayTunnelAddresses {
  httpLocalAddr: string
  websocketLocalAddr: string
}

export interface RelayHeartbeat {
  type: 'heartbeat'
  leaseId: string
}

export interface RelayHeartbeatAck {
  type: 'heartbeat_ack'
  leaseId: string
  leaseExpiresAt: string
}

export function relaySignaturePayload(input: {
  nonce: string
  backendId: string
  protocolVersion: number
  configVersion: number
}): string {
  return [
    'cherynyxus-relay-v1',
    input.nonce,
    input.backendId,
    String(input.protocolVersion),
    String(input.configVersion),
  ].join('\n')
}
