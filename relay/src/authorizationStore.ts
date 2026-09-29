import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import type {
  RelayBindingRequest,
  RelayBindingStatus,
  RelayBindingSummary,
  RelayUserIdentity,
} from '@chery/protocol/relay'
import { RelayError } from './errors.js'

export interface RelayBackendPolicy {
  backendId: string
  publicDiscovery: boolean
  remotePasswordEnabled: boolean
  updatedAt: string
}

export interface RelayAuthorization {
  bindingId: string
  backendId: string
  identity: RelayUserIdentity
  status: RelayBindingStatus
  createdAt: string
  updatedAt: string
  expiresAt?: string
  revokedAt?: string
}

export interface RelayBindingRequestRecord extends RelayBindingRequest {
  authorizationExpiresAt?: string
}

interface AuthorizationFile {
  version: 1
  policies: RelayBackendPolicy[]
  requests: RelayBindingRequestRecord[]
  authorizations: RelayAuthorization[]
}

export interface AuthorizationStoreOptions {
  confirmationBaseUrl?: string
  defaultRequestTtlMs?: number
}

function nowIso(now: Date): string {
  return now.toISOString()
}

function assertIdentity(identity: RelayUserIdentity): void {
  if (!identity || typeof identity.issuer !== 'string' || !identity.issuer ||
      typeof identity.subject !== 'string' || !identity.subject) {
    throw new RelayError('INVALID_REQUEST', 'issuer and subject are required')
  }
}

function identityKey(identity: RelayUserIdentity): string {
  return `${identity.issuer}\u0000${identity.subject}`
}

function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(18).toString('base64url')}`
}

export class AuthorizationStore {
  private readonly policies = new Map<string, RelayBackendPolicy>()
  private readonly requests = new Map<string, RelayBindingRequestRecord>()
  private readonly authorizations = new Map<string, RelayAuthorization>()
  private readonly confirmationBaseUrl: string
  private readonly defaultRequestTtlMs: number

  constructor(
    private readonly file?: string,
    options: AuthorizationStoreOptions = {},
  ) {
    this.confirmationBaseUrl = options.confirmationBaseUrl ?? ''
    this.defaultRequestTtlMs = options.defaultRequestTtlMs ?? 10 * 60 * 1000
    if (!Number.isSafeInteger(this.defaultRequestTtlMs) || this.defaultRequestTtlMs <= 0) {
      throw new Error('defaultRequestTtlMs must be a positive integer')
    }
  }

  async load(): Promise<void> {
    if (!this.file) return
    const raw = await readFile(this.file, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (!raw) return
    const parsed = JSON.parse(raw) as AuthorizationFile
    if (parsed.version !== 1 || !Array.isArray(parsed.policies) ||
        !Array.isArray(parsed.requests) || !Array.isArray(parsed.authorizations)) {
      throw new Error('Unsupported relay authorization file')
    }
    for (const policy of parsed.policies) this.policies.set(policy.backendId, { ...policy })
    for (const request of parsed.requests) this.requests.set(request.requestId, { ...request })
    for (const authorization of parsed.authorizations) {
      assertIdentity(authorization.identity)
      this.authorizations.set(authorization.bindingId, {
        ...authorization,
        identity: { ...authorization.identity },
      })
    }
  }

  getBackendPolicy(backendId: string): RelayBackendPolicy {
    const policy = this.policies.get(backendId)
    return policy ? { ...policy } : {
      backendId,
      publicDiscovery: false,
      remotePasswordEnabled: false,
      updatedAt: new Date(0).toISOString(),
    }
  }

  async setBackendPolicy(input: {
    backendId: string
    publicDiscovery?: boolean
    remotePasswordEnabled?: boolean
    now?: Date
  }): Promise<RelayBackendPolicy> {
    const previous = this.getBackendPolicy(input.backendId)
    const policy: RelayBackendPolicy = {
      backendId: input.backendId,
      publicDiscovery: input.publicDiscovery ?? previous.publicDiscovery,
      remotePasswordEnabled: input.remotePasswordEnabled ?? previous.remotePasswordEnabled,
      updatedAt: nowIso(input.now ?? new Date()),
    }
    this.policies.set(input.backendId, policy)
    await this.save()
    return { ...policy }
  }

  async createBindingRequest(input: {
    backendId: string
    displayName: string
    publicKeyFingerprint: string
    expiresAt?: Date
    authorizationExpiresAt?: Date
    confirmationUrl?: string
    now?: Date
  }): Promise<RelayBindingRequestRecord> {
    if (!input.backendId || !input.publicKeyFingerprint) {
      throw new RelayError('INVALID_REQUEST', 'backendId and publicKeyFingerprint are required')
    }
    const now = input.now ?? new Date()
    const expiresAt = input.expiresAt ?? new Date(now.getTime() + this.defaultRequestTtlMs)
    if (expiresAt.getTime() <= now.getTime()) {
      throw new RelayError('INVALID_REQUEST', 'Binding request must not already be expired')
    }
    const requestId = randomId('br')
    const request: RelayBindingRequestRecord = {
      requestId,
      backendId: input.backendId,
      displayName: input.displayName,
      publicKeyFingerprint: input.publicKeyFingerprint,
      expiresAt: expiresAt.toISOString(),
      status: 'pending',
      confirmationUrl: input.confirmationUrl ?? `${this.confirmationBaseUrl.replace(/\/$/, '')}/bindings/${requestId}`,
      confirmationCode: randomBytes(5).toString('hex').toUpperCase(),
      ...(input.authorizationExpiresAt ? { authorizationExpiresAt: input.authorizationExpiresAt.toISOString() } : {}),
    }
    this.requests.set(requestId, request)
    await this.save()
    return { ...request }
  }

  getBindingRequest(requestId: string, now = new Date()): RelayBindingRequestRecord | undefined {
    const request = this.requests.get(requestId)
    if (!request) return undefined
    if (request.status === 'pending' && new Date(request.expiresAt).getTime() <= now.getTime()) {
      request.status = 'expired'
      void this.save()
    }
    return { ...request }
  }

  async confirmBindingRequest(
    requestId: string,
    identity: RelayUserIdentity,
    now = new Date(),
  ): Promise<RelayAuthorization> {
    assertIdentity(identity)
    const request = this.requests.get(requestId)
    if (!request) throw new RelayError('BINDING_NOT_FOUND', 'Binding request was not found')
    if (request.status === 'pending' && new Date(request.expiresAt).getTime() <= now.getTime()) {
      request.status = 'expired'
      await this.save()
    }
    if (request.status === 'expired') throw new RelayError('BINDING_REQUEST_EXPIRED', 'Binding request has expired')
    if (request.status !== 'pending') throw new RelayError('BINDING_REQUEST_USED', 'Binding request has already been used')

    const existing = this.findAuthorization(identity, request.backendId)
    const timestamp = nowIso(now)
    const authorization: RelayAuthorization = existing
      ? {
          ...existing,
          status: 'active',
          updatedAt: timestamp,
          revokedAt: undefined,
          ...(request.authorizationExpiresAt ? { expiresAt: request.authorizationExpiresAt } : {}),
        }
      : {
          bindingId: randomId('bind'),
          backendId: request.backendId,
          identity: { ...identity },
          status: 'active',
          createdAt: timestamp,
          updatedAt: timestamp,
          ...(request.authorizationExpiresAt ? { expiresAt: request.authorizationExpiresAt } : {}),
        }
    request.status = 'confirmed'
    this.authorizations.set(authorization.bindingId, authorization)
    await this.save()
    return { ...authorization, identity: { ...authorization.identity } }
  }

  async cancelBindingRequest(requestId: string, now = new Date()): Promise<boolean> {
    const request = this.requests.get(requestId)
    if (!request) throw new RelayError('BINDING_NOT_FOUND', 'Binding request was not found')
    if (request.status === 'pending' && new Date(request.expiresAt).getTime() <= now.getTime()) {
      request.status = 'expired'
    }
    if (request.status !== 'pending') return false
    request.status = 'cancelled'
    await this.save()
    return true
  }

  listAuthorizationsForUser(identity: RelayUserIdentity, now = new Date()): RelayAuthorization[] {
    assertIdentity(identity)
    this.expireAuthorizations(now)
    return [...this.authorizations.values()]
      .filter((value) => identityKey(value.identity) === identityKey(identity) && value.status === 'active')
      .map((value) => ({ ...value, identity: { ...value.identity } }))
  }

  listAuthorizationsForBackend(backendId: string, now = new Date()): RelayAuthorization[] {
    this.expireAuthorizations(now)
    return [...this.authorizations.values()]
      .filter((value) => value.backendId === backendId && value.status === 'active')
      .map((value) => ({ ...value, identity: { ...value.identity } }))
  }

  getAuthorization(bindingId: string, now = new Date()): RelayAuthorization | undefined {
    this.expireAuthorizations(now)
    const value = this.authorizations.get(bindingId)
    return value ? { ...value, identity: { ...value.identity } } : undefined
  }

  isAuthorized(identity: RelayUserIdentity, backendId: string, now = new Date()): boolean {
    assertIdentity(identity)
    this.expireAuthorizations(now)
    return [...this.authorizations.values()].some((value) =>
      value.backendId === backendId && value.status === 'active' && identityKey(value.identity) === identityKey(identity))
  }

  async revokeAuthorization(bindingId: string, now = new Date()): Promise<boolean> {
    const value = this.authorizations.get(bindingId)
    if (!value || value.status !== 'active') return false
    value.status = 'revoked'
    value.revokedAt = nowIso(now)
    value.updatedAt = value.revokedAt
    await this.save()
    return true
  }

  async revokeUserBackend(identity: RelayUserIdentity, backendId: string, now = new Date()): Promise<number> {
    assertIdentity(identity)
    let count = 0
    for (const value of this.authorizations.values()) {
      if (value.status === 'active' && value.backendId === backendId && identityKey(value.identity) === identityKey(identity)) {
        value.status = 'revoked'
        value.revokedAt = nowIso(now)
        value.updatedAt = value.revokedAt
        count += 1
      }
    }
    if (count) await this.save()
    return count
  }

  async expire(now = new Date()): Promise<void> {
    let changed = false
    for (const request of this.requests.values()) {
      if (request.status === 'pending' && new Date(request.expiresAt).getTime() <= now.getTime()) {
        request.status = 'expired'
        changed = true
      }
    }
    changed = this.expireAuthorizations(now) || changed
    if (changed) await this.save()
  }

  private findAuthorization(identity: RelayUserIdentity, backendId: string): RelayAuthorization | undefined {
    return [...this.authorizations.values()].find((value) =>
      value.backendId === backendId && identityKey(value.identity) === identityKey(identity) && value.status !== 'revoked')
  }

  private expireAuthorizations(now: Date): boolean {
    let changed = false
    for (const value of this.authorizations.values()) {
      if (value.status === 'active' && value.expiresAt && new Date(value.expiresAt).getTime() <= now.getTime()) {
        value.status = 'expired'
        value.updatedAt = nowIso(now)
        changed = true
      }
    }
    return changed
  }

  private async save(): Promise<void> {
    if (!this.file) return
    await mkdir(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.${process.pid}.tmp`
    const payload: AuthorizationFile = {
      version: 1,
      policies: [...this.policies.values()],
      requests: [...this.requests.values()],
      authorizations: [...this.authorizations.values()],
    }
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, this.file)
  }
}

export function bindingSummary(value: RelayAuthorization, displayName: string): RelayBindingSummary {
  return {
    backendId: value.backendId,
    displayName,
    status: value.status,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
}
