import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { BrowserIdentity, BrowserSession, BrowserTarget } from '@chery/protocol'

export class SessionError extends Error {
  constructor(readonly code: string, readonly status: number, readonly revision?: number) { super(code) }
}
export interface SessionRecord {
  id: string
  view: BrowserSession
  credentials?: { accessToken: string; refreshToken: string }
}
interface Operation { digest: string; result: Promise<unknown>; expires: number }
/** In-memory only. No credential is serialized into cookies, logs or operation results. */
export class BrowserSessionStore {
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly rotatedContexts = new Map<string, { previousId: string; expires: number }>()
  private readonly csrfHistory = new Map<string, { token: string; expires: number }>()
  private readonly busy = new Set<string>()
  private readonly prelogin = new Map<string, { csrf: string; expires: number }>()
  private readonly tickets = new Map<string, { sessionId: string; revision: number; target: string; expires: number }>()
  private readonly operations = new Map<string, Operation>()
  private readonly sockets = new Map<string, Set<{ close(code: number, reason: string): void }>>()
  constructor(private readonly ttlMs = 8 * 60 * 60 * 1000, private readonly capacity = 1000, private readonly now = Date.now) {}
  sweep(): void { this.prune() }
  replay(id: string, operation: string, operationId: string, digest: string, csrfToken: string): Promise<unknown> | undefined {
    this.prune()
    const previousId = this.rotatedContexts.get(id)?.previousId
    const record = this.operations.get(`${id}:${operation}:${operationId}`) ?? (previousId ? this.operations.get(`${previousId}:${operation}:${operationId}`) : undefined)
    if (!record) return undefined
    const csrf = this.sessions.get(id)?.view.csrfToken ?? this.prelogin.get(id)?.csrf ?? this.csrfHistory.get(id)?.token
    const previousCsrf = previousId ? this.csrfHistory.get(previousId)?.token : undefined
    if ((!csrf || !equal(csrf, csrfToken)) && (!previousCsrf || !equal(previousCsrf, csrfToken))) throw new SessionError('CSRF_REJECTED', 403)
    if (record.digest !== digest) throw new SessionError('OPERATION_CONFLICT', 409)
    return record.result
  }
  context(): { id: string; csrfToken: string } {
    this.prune()
    if (this.prelogin.size >= this.capacity) throw new SessionError('CAPACITY_EXCEEDED', 429)
    const id = random(); const csrfToken = random()
    this.prelogin.set(id, { csrf: csrfToken, expires: this.now() + 5 * 60 * 1000 })
    return { id, csrfToken }
  }
  checkCsrf(id: string | undefined, token: string | undefined): void {
    this.prune()
    const expected = id ? this.sessions.get(id)?.view.csrfToken ?? this.prelogin.get(id)?.csrf : undefined
    if (!expected || !token || !equal(expected, token)) throw new SessionError('CSRF_REJECTED', 403)
  }
  create(input: { identity: BrowserIdentity; target: BrowserTarget | null; mode: BrowserSession['mode']; credentials?: SessionRecord['credentials'] }, previousId?: string): SessionRecord {
    this.prune()
    if (this.sessions.size >= this.capacity) throw new SessionError('CAPACITY_EXCEEDED', 429)
    const previous = previousId ? this.sessions.get(previousId) : undefined
    const record: SessionRecord = { id: random(), view: { protocolVersion: 1, authenticated: true, revision: (previous?.view.revision ?? 0) + 1, identity: structuredClone(input.identity), target: structuredClone(input.target), mode: input.mode, expiresAt: new Date(this.now() + this.ttlMs).toISOString(), csrfToken: random() }, credentials: input.credentials }
    if (previousId) {
      const csrf = previous?.view.csrfToken ?? this.prelogin.get(previousId)?.csrf
      if (csrf) this.csrfHistory.set(previousId, { token: csrf, expires: this.now() + 300000 })
      this.rotatedContexts.set(record.id, { previousId, expires: this.now() + 300000 })
      this.revoke(previousId); this.prelogin.delete(previousId)
    }
    this.sessions.set(record.id, record)
    return record
  }
  get(id: string | undefined): SessionRecord {
    this.prune()
    const session = id ? this.sessions.get(id) : undefined
    if (!session) throw new SessionError('SESSION_EXPIRED', 401)
    return session
  }
  view(id: string): BrowserSession { return structuredClone(this.get(id).view) }
  assertRevision(id: string, revision: number): SessionRecord {
    const session = this.get(id)
    if (session.view.revision !== revision) throw new SessionError('SESSION_REVISION_CONFLICT', 409, session.view.revision)
    return session
  }
  mutate<T>(id: string, operation: string, operationId: string, digest: string, expectedRevision: number | undefined, work: (session?: SessionRecord) => Promise<T>): Promise<T> {
    this.prune()
    const key = `${id}:${operation}:${operationId}`
    const previous = this.operations.get(key)
    if (previous) {
      if (previous.digest !== digest) return Promise.reject(new SessionError('OPERATION_CONFLICT', 409))
      return previous.result as Promise<T>
    }
    if (this.operations.size >= this.capacity * 20) return Promise.reject(new SessionError('CAPACITY_EXCEEDED', 429))
    let session: SessionRecord | undefined
    if (operation === 'password' && this.sessions.has(id) && expectedRevision === undefined) return Promise.reject(new SessionError('SESSION_REVISION_CONFLICT', 409, this.sessions.get(id)?.view.revision))
    if (expectedRevision !== undefined) session = this.assertRevision(id, expectedRevision)
    // Reserve synchronously before entering async work. The second CAS happens at commit.
    if (this.busy.has(id)) return Promise.reject(new SessionError('SESSION_REVISION_CONFLICT', 409, this.sessions.get(id)?.view.revision))
    this.busy.add(id)
    const result = Promise.resolve().then(() => work(session)).finally(() => this.busy.delete(id))
    this.operations.set(key, { digest, result, expires: this.now() + 5 * 60 * 1000 })
    return result
  }
  update(id: string, revision: number, target: BrowserTarget | null, credentials?: SessionRecord['credentials']): BrowserSession {
    const session = this.assertRevision(id, revision)
    this.closeSockets(id)
    session.view.target = structuredClone(target)
    session.view.revision += 1
    session.view.expiresAt = new Date(this.now() + this.ttlMs).toISOString()
    if (credentials) session.credentials = credentials
    this.invalidateTickets(id)
    return this.view(id)
  }
  ticket(id: string, revision: number): { ticket: string; wsPath: string; expiresAt: string } {
    const session = this.assertRevision(id, revision)
    if (!session.view.target) throw new SessionError('TARGET_FORBIDDEN', 403)
    if (this.tickets.size >= this.capacity * 4) throw new SessionError('CAPACITY_EXCEEDED', 429)
    const ticket = random(); const expires = this.now() + 30_000
    this.tickets.set(ticket, { sessionId: id, revision, target: targetKey(session.view.target), expires })
    return { ticket, wsPath: session.view.target.wsPath, expiresAt: new Date(expires).toISOString() }
  }
  consume(ticket: string, target: BrowserTarget): SessionRecord {
    const value = this.tickets.get(ticket)
    this.tickets.delete(ticket)
    if (!value || value.expires <= this.now() || value.target !== targetKey(target)) throw new SessionError('WS_TICKET_INVALID', 401)
    return this.assertRevision(value.sessionId, value.revision)
  }
  attach(id: string, socket: { close(code: number, reason: string): void }): () => void {
    this.get(id)
    const set = this.sockets.get(id) ?? new Set()
    set.add(socket); this.sockets.set(id, set)
    return () => { set.delete(socket); if (!set.size) this.sockets.delete(id) }
  }
  revoke(id: string): void {
    const csrf = this.sessions.get(id)?.view.csrfToken
    if (csrf) this.csrfHistory.set(id, { token: csrf, expires: this.now() + 300000 })
    this.closeSockets(id); this.sessions.delete(id); this.invalidateTickets(id)
  }
  revokeWhere(predicate: (session: SessionRecord) => boolean): void {
    for (const session of this.sessions.values()) if (predicate(session)) this.revoke(session.id)
  }
  clear(): void {
    for (const id of this.sessions.keys()) this.revoke(id)
    this.prelogin.clear(); this.operations.clear(); this.tickets.clear(); this.csrfHistory.clear(); this.rotatedContexts.clear()
  }
  private invalidateTickets(id: string): void { for (const [key, value] of this.tickets) if (value.sessionId === id) this.tickets.delete(key) }
  private closeSockets(id: string): void {
    const sockets = this.sockets.get(id); this.sockets.delete(id)
    for (const socket of sockets ?? []) socket.close(4003, 'Session changed')
  }
  private prune(): void {
    for (const [id, value] of this.sessions) if (Date.parse(value.view.expiresAt) <= this.now()) this.revoke(id)
    for (const [id, value] of this.prelogin) if (value.expires <= this.now()) this.prelogin.delete(id)
    for (const [id, value] of this.tickets) if (value.expires <= this.now()) this.tickets.delete(id)
    for (const [id, value] of this.rotatedContexts) if (value.expires <= this.now()) this.rotatedContexts.delete(id)
    for (const [id, value] of this.csrfHistory) if (value.expires <= this.now()) this.csrfHistory.delete(id)
    for (const [key, value] of this.operations) if (value.expires <= this.now()) this.operations.delete(key)
  }
}
export function targetKey(target: BrowserTarget): string { return JSON.stringify([target.origin, target.basePath, target.backendId ?? '']) }
export function requestDigest(secretKey: string, operation: string, body: unknown): string {
  // Per-process secret prevents offline guessing of password operation digests.
  return createHmac('sha256', secretKey).update(JSON.stringify([operation, body])).digest('hex')
}
export function sessionCookie(id: string, basePath: string, secure: boolean, maxAge: number): string {
  return `chery_business_session=${id}; Path=${basePath || '/'}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`
}
export function readSessionCookie(cookie: string | undefined): string | undefined { return cookie?.split(/;\s*/).find((s) => s.startsWith('chery_business_session='))?.slice('chery_business_session='.length) }
function random(): string { return randomBytes(32).toString('base64url') }
function equal(a: string, b: string): boolean { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y) }
