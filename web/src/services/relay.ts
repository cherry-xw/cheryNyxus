import { httpUrl } from './platform'

function joinRelayBase(base: string, path: string): string {
  const prefix = base.replace(/\/$/, '')
  const suffix = path.startsWith('/') ? path : `/${path}`
  return `${prefix}${suffix}`
}

export interface RelayBackendSummary {
  backendId: string
  displayName: string
  status: 'online' | 'offline'
  capabilities: { http: boolean; websocket: boolean }
  lastSeenAt: string
}

export interface RelayDiscovery extends RelayBackendSummary {
  transport: 'binary'
  httpBasePath: string
  wsPath: string
}

export async function listRelayBackends(base = ''): Promise<RelayBackendSummary[]> {
  const response = await fetch(joinRelayBase(base, '/api/backends'), {
    credentials: 'include',
    cache: 'no-store',
  })
  if (!response.ok) throw new Error(`获取后端列表失败：${response.status}`)
  return ((await response.json()) as { backends?: RelayBackendSummary[] }).backends ?? []
}

export async function discoverRelayBackend(backendId: string, base = ''): Promise<RelayDiscovery> {
  const response = await fetch(joinRelayBase(base, `/api/backends/${encodeURIComponent(backendId)}`), {
    credentials: 'include',
    cache: 'no-store',
  })
  if (!response.ok) throw new Error(`获取后端连接信息失败：${response.status}`)
  return (await response.json()) as RelayDiscovery
}

export async function bindRelayBackend(backendId: string, base = ''): Promise<RelayDiscovery> {
  const response = await fetch(joinRelayBase(base, '/api/session/backend'), {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ backendId }),
  })
  if (!response.ok) throw new Error(`绑定后端失败：${response.status}`)
  return (await response.json()) as RelayDiscovery
}

export async function unbindRelayBackend(base = ''): Promise<void> {
  const response = await fetch(joinRelayBase(base, '/api/session/backend'), {
    method: 'DELETE',
    credentials: 'include',
  })
  if (!response.ok && response.status !== 204) throw new Error(`解除后端绑定失败：${response.status}`)
}

export function relayHttpUrl(discovery: RelayDiscovery, path: string): string {
  return new URL(`${discovery.httpBasePath}${path}`, window.location.origin).toString()
}

export function relayWsUrl(discovery: RelayDiscovery): string {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${scheme}//${window.location.host}${discovery.wsPath}`
}

export function relayApiUrl(path: string): string {
  return httpUrl(path)
}
