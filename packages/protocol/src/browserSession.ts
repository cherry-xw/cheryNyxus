import { z } from 'zod'

const backendId = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/)
const opaqueId = z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/)
const revision = z.number().int().positive().safe()
const safePath = z.string().max(512).refine((s) => s === '' || (s.startsWith('/') && !s.startsWith('//') && !/[\\?#\x00-\x20]/.test(s) && !/%(?:2f|5c|2e|00)/i.test(s) && !s.split('/').some((x) => x === '.' || x === '..')), 'Invalid path')
const origin = z.string().url().refine((s) => { try { const u = new URL(s); return ['https:', 'http:'].includes(u.protocol) && u.origin === s && !u.username && !u.password } catch { return false } }, 'Expected complete origin')
const ListenerPortsSchema = z.object({ httpPort: z.number().int().min(1).max(65535), websocketPort: z.number().int().min(1).max(65535) }).strict()
export const BACKEND_STATUS_INTERVAL_MS = 2_000
export const BACKEND_STATUS_VALID_CYCLES = 3
export const BackendStatusSchema = z.object({ protocolVersion: z.literal(2), instanceId: opaqueId, status: z.literal('running'), heartbeatIntervalMs: z.number().int().positive().safe(), addresses: z.object({ local: ListenerPortsSchema, remote: ListenerPortsSchema.optional() }).strict(), agents: z.object({ initializedChats: z.number().int().nonnegative().safe(), runningChats: z.number().int().nonnegative().safe(), activeRuns: z.number().int().nonnegative().safe() }).strict(), updatedAt: z.string().datetime() }).strict()
export const MaintenanceDiagnosticSchema = z.object({ status: z.enum(['configured', 'not_configured', 'invalid']), code: z.enum(['MACHINE_CONFIG_INVALID']).optional() }).strict()
export const RelayClientStatusSchema = z.object({ protocolVersion: z.literal(3), instanceId: opaqueId, backendId, status: z.enum(['idle', 'connecting', 'online', 'backoff', 'stopped', 'error']), configVersion: revision, desiredRevision: z.string().min(1).max(128), appliedRevision: z.string().min(1).max(128).optional(), leaseId: opaqueId.optional(), leaseExpiresAt: z.string().datetime().optional(), error: z.string().max(512).optional(), updatedAt: z.string().datetime() }).strict().refine((v) => v.status !== 'online' || (!!v.leaseId && !!v.leaseExpiresAt && !!v.appliedRevision && v.appliedRevision === v.desiredRevision), 'Online requires applied lease and confirmed expiry')
export const MachineMaintenanceSchema = z.object({ protocolVersion: z.literal(1), instanceId: z.string().min(1).max(128), protocolRange: z.object({ min: z.literal(1), max: z.literal(1) }).strict(), operations: z.array(z.enum(['relay.binding', 'relay.operation'])).max(2).refine((v) => new Set(v).size === v.length), listener: z.literal('local'), diagnostic: MaintenanceDiagnosticSchema.optional() }).strict()
export const MachineRelayOperationSchema = z.object({ type: z.enum(['binding.cancel', 'binding.status', 'authorization.list', 'authorization.revoke', 'policy.get', 'policy.set']), input: z.record(z.string(), z.unknown()).default({}) }).strict().superRefine((value, ctx) => { const allowed = value.type === 'policy.set' ? ['publicDiscovery', 'remotePasswordEnabled'] : value.type.startsWith('binding.') ? ['bindingRequestId'] : value.type === 'authorization.revoke' ? ['bindingId'] : []; if (Object.keys(value.input).some((k) => !allowed.includes(k)) || allowed.some((k) => value.type === 'policy.set' ? typeof value.input[k] !== 'boolean' : typeof value.input[k] !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(value.input[k] as string))) ctx.addIssue({ code: 'custom', message: 'Invalid device operation input' }) })
export const PublicAuthCapabilitiesSchema = z.object({ password: z.boolean(), oidc: z.boolean(), service: z.enum(['backend', 'relay']), csrfToken: opaqueId, trustedLocal: z.boolean().optional() }).strict()
export const BrowserTargetSchema = z.object({ backendId: backendId.optional(), origin, basePath: safePath, httpBasePath: safePath, wsPath: safePath }).strict()
export const BrowserIdentitySchema = z.object({ subject: z.string().min(1).max(512), provider: z.enum(['password', 'oidc', 'local']), issuer: z.string().url().optional(), displayName: z.string().max(256).optional() }).strict()
export const BrowserSessionSchema = z.object({ protocolVersion: z.literal(1), authenticated: z.literal(true), revision, mode: z.enum(['direct-password', 'relay-password', 'relay-oidc', 'trusted-local']), identity: BrowserIdentitySchema, target: BrowserTargetSchema.nullable(), expiresAt: z.string().datetime(), csrfToken: opaqueId }).strict()
export const SessionMutationSchema = z.object({ expectedRevision: revision, operationId: opaqueId }).strict()
export const PasswordSessionRequestSchema = SessionMutationSchema.extend({ expectedRevision: revision.optional(), backendId: backendId.optional(), username: z.string().min(1).max(256), password: z.string().min(1).max(1024) })
export const TargetSessionRequestSchema = SessionMutationSchema.extend({ backendId })
export const WsTicketRequestSchema = z.object({ expectedRevision: revision, backendId: backendId.optional() }).strict()
export const WsTicketSchema = z.object({ ticket: opaqueId, wsPath: safePath, expiresAt: z.string().datetime() }).strict()
export const BusinessErrorSchema = z.object({ error: z.object({ code: z.string().regex(/^[A-Z][A-Z0-9_]+$/), message: z.string().max(512), requestId: opaqueId, retryAfterSeconds: z.number().int().positive().optional(), revision: revision.optional() }).strict() }).strict()
export const UserProofHeaderSchema = z.object({ alg: z.literal('EdDSA'), typ: z.literal('JWT'), kid: opaqueId }).strict()
export const UserProofClaimsSchema = z.object({ iss: z.string().url(), sub: z.string().min(1).max(512), aud: backendId, iat: z.number().int().nonnegative(), nbf: z.number().int().nonnegative(), exp: z.number().int().positive(), jti: opaqueId, sessionId: opaqueId, authorizationId: z.string().min(1).max(128), authorizationRevision: revision, permissions: z.tuple([z.literal('business')]), requestHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict().refine((v) => v.exp > v.iat && v.exp - v.iat <= 60 && v.nbf <= v.exp, 'Invalid proof lifetime')
export const DeviceBindingRequestSchema = z.object({ type: z.literal('binding.request'), requestId: opaqueId, backendId, deviceFingerprint: z.string().min(16).max(128), requestedPermission: z.literal('business') }).strict()
export const KnownDeviceIdentitySchema = z.object({ backendId, fingerprint: z.string().regex(/^[A-Za-z0-9_-]{43}$/), displayName: z.string().min(1).max(256), createdAt: z.string().datetime(), lastSeenAt: z.string().datetime(), capabilities: z.object({ http: z.boolean(), websocket: z.boolean() }).strict() }).strict()
export const DeviceIdentityRegistrySchema = z.object({ version: z.literal(2), backends: z.array(KnownDeviceIdentitySchema).max(10000) }).strict().refine((v) => new Set(v.backends.map((a) => a.backendId)).size === v.backends.length, 'Duplicate device')
const RelayStoredIdentitySchema = z.object({ issuer: z.string().url(), subject: z.string().min(1).max(512) }).strict()
const RelayPolicyRecordSchema = z.object({ backendId, publicDiscovery: z.boolean(), remotePasswordEnabled: z.boolean(), updatedAt: z.string().datetime() }).strict()
const RelayBindingRecordSchema = z.object({ requestId: z.string().min(16).max(128), backendId, displayName: z.string().min(1).max(256), publicKeyFingerprint: z.string().regex(/^[A-Za-z0-9_-]{43}$/), expiresAt: z.string().datetime(), status: z.enum(['pending', 'confirmed', 'expired', 'cancelled']), confirmationUrl: z.string().url(), confirmationCode: z.string().regex(/^[A-F0-9]{10}$/), confirmedIdentity: RelayStoredIdentitySchema.optional(), authorizationId: z.string().min(1).max(128).optional(), authorizationExpiresAt: z.string().datetime().optional() }).strict()
const RelayAuthorizationRecordSchema = z.object({ publicKeyFingerprint: z.string().regex(/^[A-Za-z0-9_-]{43}$/), revision, bindingId: z.string().min(16).max(128), backendId, identity: RelayStoredIdentitySchema, status: z.enum(['pending', 'active', 'revoked', 'expired']), createdAt: z.string().datetime(), updatedAt: z.string().datetime(), expiresAt: z.string().datetime().optional(), revokedAt: z.string().datetime().optional() }).strict()
export const RelayAuthorizationRegistrySchema = z.object({ version: z.literal(2), policies: z.array(RelayPolicyRecordSchema).max(10000), requests: z.array(RelayBindingRecordSchema).max(10000), authorizations: z.array(RelayAuthorizationRecordSchema).max(10000) }).strict().refine((v) => new Set(v.policies.map((p) => p.backendId)).size === v.policies.length && new Set(v.requests.map((p) => p.requestId)).size === v.requests.length && new Set(v.authorizations.map((p) => p.bindingId)).size === v.authorizations.length, 'Duplicate registry record')
export const DeviceIdentityFileSchema = z.object({ version: z.literal(1), privateKeyPem: z.string().min(64).max(4096) }).strict()
export const DeviceAuthorizationSchema = z.object({ id: z.string().min(1).max(128), revision, subject: z.string().min(1).max(512) }).strict()
export const DeviceAuthorizationSnapshotSchema = z.object({ type: z.literal('authorizations.snapshot'), revision: opaqueId, authorizations: z.array(DeviceAuthorizationSchema).max(10000) }).strict().refine((v) => new Set(v.authorizations.map((a) => a.id)).size === v.authorizations.length, 'Duplicate authorization')
export const DeviceAuthorizationFileSchema = z.object({ version: z.literal(1), backendId, issuer: z.string().url().refine((s) => { const u = new URL(s); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash }), revision, authorizations: z.array(DeviceAuthorizationSchema).max(10000) }).strict().refine((v) => new Set(v.authorizations.map((a) => a.id)).size === v.authorizations.length, 'Duplicate authorization')
const privateAddress = z.string().refine((value) => /^(?:127\.0\.0\.1|\[::1\]):[1-9]\d{0,4}$/.test(value) && Number(value.slice(value.lastIndexOf(':') + 1)) <= 65535, 'Private loopback address required')
export const RelayChallengeSchema = z.object({ type: z.literal('challenge'), protocolVersion: z.literal(2), nonce: opaqueId, expiresAt: z.string().datetime() }).strict()
export const RelayHelloSchema = z.object({ type: z.literal('hello'), protocolVersion: z.literal(2), backendId, displayName: z.string().trim().min(1).max(80), publicKey: z.string().min(32).max(256).regex(/^[A-Za-z0-9_-]+$/), signature: z.string().length(86).regex(/^[A-Za-z0-9_-]+$/), configVersion: revision, capabilities: z.object({ http: z.literal(true), websocket: z.literal(true) }).strict() }).strict()
export const RelayAcceptedSchema = z.object({ type: z.literal('accepted'), protocolVersion: z.literal(2), backendId, leaseId: opaqueId, heartbeatIntervalMs: z.number().int().min(100).max(300000), leaseExpiresAt: z.string().datetime(), configVersion: revision, tunnel: z.object({ httpService: opaqueId, websocketService: opaqueId, token: opaqueId, httpBindAddr: privateAddress, websocketBindAddr: privateAddress }).strict() }).strict().refine((v) => v.tunnel.httpService !== v.tunnel.websocketService && v.tunnel.httpBindAddr !== v.tunnel.websocketBindAddr, 'Distinct services required')
export const DeviceOperationSchema = z.discriminatedUnion('type', [
  DeviceBindingRequestSchema,
  z.object({ type: z.literal('binding.cancel'), requestId: opaqueId, bindingRequestId: opaqueId }).strict(),
  z.object({ type: z.literal('binding.status'), requestId: opaqueId, bindingRequestId: opaqueId }).strict(),
  z.object({ type: z.literal('authorization.list'), requestId: opaqueId }).strict(),
  z.object({ type: z.literal('authorization.revoke'), requestId: opaqueId, bindingId: opaqueId }).strict(),
  z.object({ type: z.literal('policy.get'), requestId: opaqueId }).strict(),
  z.object({ type: z.literal('policy.set'), requestId: opaqueId, publicDiscovery: z.boolean(), remotePasswordEnabled: z.boolean() }).strict(),
])
export const DeviceControlMessageSchema = z.union([
  DeviceOperationSchema,
  z.object({ type: z.literal('authorizations.ack'), revision: opaqueId }).strict(),
  z.object({ type: z.literal('tunnel.applied'), leaseId: opaqueId, probeToken: z.string().min(16).max(4096) }).strict(),
  z.object({ type: z.literal('heartbeat'), leaseId: opaqueId }).strict(),
])
export const RelayControlMessageSchema = z.union([
  RelayChallengeSchema, RelayAcceptedSchema, DeviceAuthorizationSnapshotSchema,
  z.object({ type: z.literal('binding.result'), requestId: opaqueId, request: z.union([RelayBindingRecordSchema, RelayPolicyRecordSchema, RelayAuthorizationRecordSchema, z.object({ authorizations: z.array(RelayAuthorizationRecordSchema).max(10000) }).strict()]) }).strict(),
  z.object({ type: z.literal('tunnel.ready'), leaseId: opaqueId }).strict(),
  z.object({ type: z.literal('tunnel.pending'), leaseId: opaqueId }).strict(),
  z.object({ type: z.literal('heartbeat_ack'), leaseId: opaqueId, leaseExpiresAt: z.string().datetime() }).strict(),
  BusinessErrorSchema.extend({ type: z.literal('error') }),
])
export type BrowserSession = z.infer<typeof BrowserSessionSchema>
export type BrowserTarget = z.infer<typeof BrowserTargetSchema>
export type BrowserIdentity = z.infer<typeof BrowserIdentitySchema>
export type UserProofClaims = z.infer<typeof UserProofClaimsSchema>
