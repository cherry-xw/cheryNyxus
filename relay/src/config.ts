import { resolve } from 'node:path'

export interface RelayLimits {
  maxOnlineBackends: number
  maxControlConnections: number
  maxBrowserWebSockets: number
  maxWebSocketsPerBackend: number
  maxConcurrentHttp: number
  maxRequestBytes: number
  requestsPerMinutePerIp: number
  upstreamTimeoutMs: number
}

export interface RelayConfig {
  host: string
  port: number
  publicBasePath: string
  publicOrigin: string
  identityFile?: string
  sessionSecret: string
  sessionTtlSeconds: number
  challengeTtlMs: number
  heartbeatIntervalMs: number
  leaseTtlMs: number
  limits: RelayLimits
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`)
  return parsed
}

export function normalizeBasePath(value: string | undefined): string {
  if (!value || value === '/') return ''
  const normalized = `/${value.replace(/^\/+|\/+$/g, '')}`
  if (normalized.includes('..') || normalized.includes('\\')) {
    throw new Error('RELAY_PUBLIC_BASE_PATH must not contain traversal segments')
  }
  return normalized
}

export function loadRelayConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const sessionSecret = env.RELAY_SESSION_SECRET ?? ''
  if (Buffer.byteLength(sessionSecret) < 32) {
    throw new Error('RELAY_SESSION_SECRET must contain at least 32 bytes')
  }
  const publicOrigin = env.RELAY_PUBLIC_ORIGIN ?? 'http://127.0.0.1:4080'
  const parsedOrigin = new URL(publicOrigin)
  if (parsedOrigin.protocol !== 'http:' && parsedOrigin.protocol !== 'https:') {
    throw new Error('RELAY_PUBLIC_ORIGIN must use http or https')
  }
  return {
    host: env.RELAY_HOST ?? '127.0.0.1',
    port: positiveInteger(env.RELAY_PORT, 4080, 'RELAY_PORT'),
    publicBasePath: normalizeBasePath(env.RELAY_PUBLIC_BASE_PATH),
    publicOrigin: parsedOrigin.origin,
    identityFile: resolve(env.RELAY_IDENTITY_FILE ?? './relay-data/identities.json'),
    sessionSecret,
    sessionTtlSeconds: positiveInteger(env.RELAY_SESSION_TTL_SECONDS, 8 * 60 * 60, 'RELAY_SESSION_TTL_SECONDS'),
    challengeTtlMs: positiveInteger(env.RELAY_CHALLENGE_TTL_MS, 30_000, 'RELAY_CHALLENGE_TTL_MS'),
    heartbeatIntervalMs: positiveInteger(env.RELAY_HEARTBEAT_INTERVAL_MS, 15_000, 'RELAY_HEARTBEAT_INTERVAL_MS'),
    leaseTtlMs: positiveInteger(env.RELAY_LEASE_TTL_MS, 45_000, 'RELAY_LEASE_TTL_MS'),
    limits: {
      maxOnlineBackends: positiveInteger(env.RELAY_MAX_ONLINE_BACKENDS, 1_000, 'RELAY_MAX_ONLINE_BACKENDS'),
      maxControlConnections: positiveInteger(env.RELAY_MAX_CONTROL_CONNECTIONS, 1_100, 'RELAY_MAX_CONTROL_CONNECTIONS'),
      maxBrowserWebSockets: positiveInteger(env.RELAY_MAX_BROWSER_WEBSOCKETS, 5_000, 'RELAY_MAX_BROWSER_WEBSOCKETS'),
      maxWebSocketsPerBackend: positiveInteger(env.RELAY_MAX_WS_PER_BACKEND, 100, 'RELAY_MAX_WS_PER_BACKEND'),
      maxConcurrentHttp: positiveInteger(env.RELAY_MAX_CONCURRENT_HTTP, 1_000, 'RELAY_MAX_CONCURRENT_HTTP'),
      maxRequestBytes: positiveInteger(env.RELAY_MAX_REQUEST_BYTES, 128 * 1024 * 1024, 'RELAY_MAX_REQUEST_BYTES'),
      requestsPerMinutePerIp: positiveInteger(env.RELAY_REQUESTS_PER_MINUTE, 120, 'RELAY_REQUESTS_PER_MINUTE'),
      upstreamTimeoutMs: positiveInteger(env.RELAY_UPSTREAM_TIMEOUT_MS, 30_000, 'RELAY_UPSTREAM_TIMEOUT_MS'),
    },
  }
}
