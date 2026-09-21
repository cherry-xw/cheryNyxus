import { randomBytes } from 'node:crypto'
import type { WebSocket } from 'ws'
import type {
  RelayAccepted,
  RelayBackendCapabilities,
  RelayBackendSummary,
} from '@chery/protocol/relay'
import { RELAY_PROTOCOL_VERSION } from '@chery/protocol/relay'
import type { RelayConfig } from './config.js'
import { RelayError } from './errors.js'
import type { IdentityStore, KnownBackendIdentity } from './identityStore.js'

interface ActiveBackend {
  identity: KnownBackendIdentity
  capabilities: RelayBackendCapabilities
  socket: WebSocket
  leaseId: string
  leaseExpiresAt: number
  configVersion: number
}

export class BackendRegistry {
  private readonly active = new Map<string, ActiveBackend>()
  private readonly websocketCounts = new Map<string, number>()
  private totalBrowserWebSockets = 0

  constructor(
    private readonly identities: IdentityStore,
    private readonly config: RelayConfig,
  ) {}

  isOnline(backendId: string): boolean {
    const active = this.active.get(backendId)
    return Boolean(active && active.leaseExpiresAt > Date.now())
  }

  register(input: {
    identity: KnownBackendIdentity
    capabilities: RelayBackendCapabilities
    socket: WebSocket
    configVersion: number
  }): RelayAccepted {
    if (this.isOnline(input.identity.backendId)) {
      throw new RelayError('BACKEND_ID_CONFLICT', 'Backend ID already has an active connection')
    }
    if (this.active.size >= this.config.limits.maxOnlineBackends) {
      throw new RelayError('CAPACITY_EXCEEDED', 'Online backend capacity exceeded', 30)
    }
    const leaseId = randomBytes(18).toString('base64url')
    const opaque = randomBytes(18).toString('base64url')
    const token = randomBytes(32).toString('base64url')
    const leaseExpiresAt = Date.now() + this.config.leaseTtlMs
    this.active.set(input.identity.backendId, {
      ...input,
      leaseId,
      leaseExpiresAt,
    })
    return {
      type: 'accepted',
      protocolVersion: RELAY_PROTOCOL_VERSION,
      backendId: input.identity.backendId,
      leaseId,
      heartbeatIntervalMs: this.config.heartbeatIntervalMs,
      leaseExpiresAt: new Date(leaseExpiresAt).toISOString(),
      configVersion: input.configVersion,
      tunnel: {
        httpService: `http-${opaque}`,
        websocketService: `ws-${opaque}`,
        token,
      },
    }
  }

  heartbeat(backendId: string, leaseId: string): string {
    const active = this.active.get(backendId)
    if (!active || active.leaseId !== leaseId || active.leaseExpiresAt <= Date.now()) {
      throw new RelayError('BACKEND_AUTH_FAILED', 'Lease is not active')
    }
    active.leaseExpiresAt = Date.now() + this.config.leaseTtlMs
    return new Date(active.leaseExpiresAt).toISOString()
  }

  disconnect(backendId: string, socket: WebSocket): void {
    const active = this.active.get(backendId)
    if (active?.socket === socket) this.active.delete(backendId)
  }

  expire(now = Date.now()): void {
    for (const [backendId, active] of this.active) {
      if (active.leaseExpiresAt <= now) {
        this.active.delete(backendId)
        active.socket.close(4001, 'Lease expired')
      }
    }
  }

  list(): RelayBackendSummary[] {
    return this.identities.list().map((identity) => this.summary(identity))
  }

  get(backendId: string): RelayBackendSummary | undefined {
    const identity = this.identities.get(backendId)
    return identity ? this.summary(identity) : undefined
  }

  requireOnline(backendId: string): RelayBackendSummary {
    const summary = this.get(backendId)
    if (!summary) throw new RelayError('BACKEND_NOT_FOUND', 'Backend ID is not registered')
    if (summary.status !== 'online') throw new RelayError('BACKEND_OFFLINE', 'Backend is offline')
    return summary
  }

  acquireBrowserWebSocket(backendId: string): () => void {
    if (this.totalBrowserWebSockets >= this.config.limits.maxBrowserWebSockets) {
      throw new RelayError('CAPACITY_EXCEEDED', 'WebSocket capacity exceeded', 5)
    }
    const count = this.websocketCounts.get(backendId) ?? 0
    if (count >= this.config.limits.maxWebSocketsPerBackend) {
      throw new RelayError('CAPACITY_EXCEEDED', 'Backend WebSocket capacity exceeded', 5)
    }
    this.totalBrowserWebSockets += 1
    this.websocketCounts.set(backendId, count + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      this.totalBrowserWebSockets -= 1
      const current = this.websocketCounts.get(backendId) ?? 1
      if (current <= 1) this.websocketCounts.delete(backendId)
      else this.websocketCounts.set(backendId, current - 1)
    }
  }

  private summary(identity: KnownBackendIdentity): RelayBackendSummary {
    const active = this.active.get(identity.backendId)
    const online = Boolean(active && active.leaseExpiresAt > Date.now())
    return {
      backendId: identity.backendId,
      displayName: identity.displayName,
      status: online ? 'online' : 'offline',
      capabilities: online ? active!.capabilities : identity.capabilities,
      lastSeenAt: identity.lastSeenAt,
    }
  }
}
