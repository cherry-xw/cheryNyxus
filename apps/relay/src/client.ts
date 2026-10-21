import { chmod, link, mkdir, open, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { validateEncryptedTransport } from './encryptedTransport.js'
import { DeviceAuthorizationSnapshotSchema, DeviceIdentityFileSchema, RelayControlMessageSchema } from '@chery/protocol'
import { dirname } from 'node:path'
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject, createPrivateKey, createPublicKey } from 'node:crypto'
import { WebSocket, type RawData } from 'ws'
import {
  RELAY_PROTOCOL_VERSION,
  relaySignaturePayload,
  type RelayAccepted,
  type RelayChallenge,
  type RelayTunnelAddresses,
} from '@chery/protocol/relay'
import {
  servicesFromAccepted,
  renderRatholeClientConfig,
  writePrivateRatholeConfig,
  startRathole,
  type RatholeProcess,
  type RatholeProcessFactory,
} from './rathole.js'

export type RelayClientStatus = 'idle' | 'connecting' | 'online' | 'backoff' | 'stopped' | 'error'

export interface RelayClientOptions {
  url: string
  backendId: string
  displayName: string
  configVersion: number
  keyFile: string
  ratholeServerAddr: string
  ratholeConfigPath: string
  ratholeBinary?: string
  statusFile?: string
  tunnelAddresses: RelayTunnelAddresses
  tunnelBindAddresses: { httpBindAddr: string; wsBindAddr: string }
  reconnectMinMs?: number
  reconnectMaxMs?: number
  webSocketFactory?: (url: string) => WebSocket
  ratholeProcessFactory?: RatholeProcessFactory
  onStatus?: (status: RelayClientStatus, error?: string) => void
  probeToken?: () => string
  encryptedTransport?: string
  onAuthorizations?: (authorizations: Array<{ id: string; revision: number; subject: string }>) => Promise<void>
  onControlDisconnected?: () => void | Promise<void>
  desiredRevision?: string
  onAccepted?: (accepted: RelayAccepted) => void
}

interface StoredIdentity {
  version: 1
  privateKeyPem: string
}

export class RelayBackendClient {
  private socket?: WebSocket
  private heartbeat?: NodeJS.Timeout
  private reconnect?: NodeJS.Timeout
  private stopped = false
  private retryMs: number
  private status: RelayClientStatus = 'idle'
  private privateKey?: KeyObject
  private readonly instanceId = randomBytes(24).toString('base64url')
  private appliedRevision?: string
  private activeLeaseId?: string
  private ratholeProcess?: RatholeProcess
  private tunnelQueue: Promise<void> = Promise.resolve()
  private statusWrites: Promise<void> = Promise.resolve()
  private readonly bindingWaiters = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
  deviceOperation(type: 'binding.cancel' | 'binding.status' | 'authorization.list' | 'authorization.revoke' | 'policy.get' | 'policy.set', input: Record<string, unknown> = {}): Promise<unknown> {
    if (this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Device control is offline'))
    const requestId = randomBytes(24).toString('base64url')
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.bindingWaiters.delete(requestId); reject(new Error('Device operation result unknown')) }, 10000)
      this.bindingWaiters.set(requestId, { resolve, reject, timer })
      this.socket!.send(JSON.stringify({ ...input, type, requestId }))
    })
  }
  requestBinding(): Promise<unknown> {
    if (!this.privateKey || this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Device control is offline'))
    const requestId = randomBytes(24).toString('base64url')
    const publicKey = createPublicKey(this.privateKey).export({ format: 'der', type: 'spki' })
    const deviceFingerprint = createHash('sha256').update(publicKey).digest('base64url')
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.bindingWaiters.delete(requestId); reject(new Error('Binding request result unknown')) }, 10000)
      this.bindingWaiters.set(requestId, { resolve, reject, timer })
      this.socket!.send(JSON.stringify({ type: 'binding.request', requestId, backendId: this.options.backendId, deviceFingerprint, requestedPermission: 'business' }))
    })
  }

  constructor(private readonly options: RelayClientOptions) {
    this.retryMs = options.reconnectMinMs ?? 500
  }

  getStatus(): RelayClientStatus {
    return this.status
  }

  async start(): Promise<void> {
    if (!this.options.probeToken) throw new Error('Authenticated tunnel probe required')
    this.stopped = false
    this.privateKey = await loadOrCreatePrivateKey(this.options.keyFile)
    if (this.privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Ed25519 device identity required')
    this.connect()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.disconnectAuthorization()
    if (this.reconnect) clearTimeout(this.reconnect)
    if (this.heartbeat) clearInterval(this.heartbeat)
    for (const waiter of this.bindingWaiters.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('Device control stopped; request result unknown')) }
    this.bindingWaiters.clear()
    this.socket?.close(1000, 'Client stopped')
    this.socket = undefined
    this.activeLeaseId = undefined
    this.appliedRevision = undefined
    await this.tunnelQueue.catch(() => {})
    await this.ratholeProcess?.stop()
    this.ratholeProcess = undefined
    this.socket = undefined
    this.setStatus('stopped')
  }

  updateConfigVersion(configVersion: number): void {
    if (!Number.isSafeInteger(configVersion) || configVersion < 1) throw new Error('configVersion must be a positive integer')
    this.options.configVersion = configVersion
    this.appliedRevision = undefined
    if (this.status === 'online' || this.status === 'connecting' || this.status === 'backoff') {
      this.socket?.close(1000, 'Configuration version changed')
    }
  }

  private disconnectAuthorization(): void {
    try { void Promise.resolve(this.options.onControlDisconnected?.()).catch(() => console.warn('Relay authorization cleanup failed')) } catch { console.warn('Relay authorization cleanup failed') }
  }

  private connect(): void {
    if (this.stopped) return
    this.setStatus('connecting')
    const factory = this.options.webSocketFactory ?? ((url: string) => new WebSocket(url))
    const socket = factory(this.options.url)
    this.socket = socket
    socket.once('open', () => this.retryMs = this.options.reconnectMinMs ?? 500)
    let messages = Promise.resolve()
    socket.on('message', (data, isBinary) => {
      messages = messages.then(async () => { if (this.socket === socket) await this.handleMessage(data, isBinary) }).catch(() => { if (this.socket === socket) this.fail('Invalid control message or failed application') })
    })
    socket.once('close', () => { if (this.socket === socket) this.handleClose() })
    socket.once('error', (error) => { if (this.socket === socket) this.setStatus('error', error.message) })
  }

  private async handleMessage(data: RawData, isBinary: boolean): Promise<void> {
    if (isBinary) return this.fail('Relay control messages must be text')
    let message: Record<string, unknown>
    try {
      message = RelayControlMessageSchema.parse(JSON.parse(data.toString())) as Record<string, unknown>
    } catch {
      return this.fail('Relay control message is invalid JSON')
    }
    if (message.type === 'authorizations.snapshot' && Array.isArray(message.authorizations)) {
      if (!this.options.onAuthorizations) return this.fail('Authorization receiver unavailable')
      const snapshot = DeviceAuthorizationSnapshotSchema.parse(message)
      const socket = this.socket
      await this.options.onAuthorizations(snapshot.authorizations)
      if (this.stopped || this.socket !== socket || socket?.readyState !== WebSocket.OPEN) return
      socket.send(JSON.stringify({ type: 'authorizations.ack', revision: message.revision }))
      return
    }
    if (message.type === 'binding.result' && typeof message.requestId === 'string') {
      const waiter = this.bindingWaiters.get(message.requestId)
      if (waiter) { clearTimeout(waiter.timer); this.bindingWaiters.delete(message.requestId); waiter.resolve(message.request) }
      return
    }
    if (message.type === 'challenge') {
      await this.answerChallenge(message as unknown as RelayChallenge)
      return
    }
    if (message.type === 'accepted') {
      const socket = this.socket
      const work = this.tunnelQueue.then(() => this.accept(message as unknown as RelayAccepted, socket))
      this.tunnelQueue = work.catch(() => { if (this.socket === socket && !this.stopped) this.fail('Tunnel application failed') })
      return
    }
    if (message.type === 'tunnel.ready') { if (message.leaseId !== this.activeLeaseId) return; this.appliedRevision = this.options.desiredRevision ?? 'unknown'; this.setStatus('online'); return }
    if (message.type === 'heartbeat_ack') {
      if (message.leaseId === this.activeLeaseId && this.status === 'online') this.setStatus('online')
      return
    }
    if (message.type === 'error') {
      const errorCode = (message.error as { code?: unknown } | undefined)?.code
      if (errorCode === 'BACKEND_AUTH_FAILED' || errorCode === 'BACKEND_ID_CONFLICT' || errorCode === 'PROTOCOL_VERSION_UNSUPPORTED') {
        this.stopped = true
      }
      return this.fail(typeof errorCode === 'string' && /^[A-Z_]+$/.test(errorCode) ? `Relay rejected: ${errorCode}` : 'Relay rejected the backend connection')
    }
  }

  private async answerChallenge(challenge: RelayChallenge): Promise<void> {
    if (challenge.protocolVersion !== RELAY_PROTOCOL_VERSION || !Number.isFinite(Date.parse(challenge.expiresAt)) || Date.parse(challenge.expiresAt) <= Date.now()) {
      return this.fail('Relay challenge is unsupported or expired')
    }
    if (!this.privateKey) return this.fail('Relay device key is unavailable')
    const publicKey = createPublicKey(this.privateKey).export({ format: 'der', type: 'spki' }).toString('base64url')
    const signature = sign(
      null,
      Buffer.from(relaySignaturePayload({
        nonce: challenge.nonce,
        backendId: this.options.backendId,
        protocolVersion: RELAY_PROTOCOL_VERSION,
        configVersion: this.options.configVersion,
      })),
      this.privateKey,
    ).toString('base64url')
    this.socket?.send(JSON.stringify({
      type: 'hello',
      protocolVersion: RELAY_PROTOCOL_VERSION,
      backendId: this.options.backendId,
      displayName: this.options.displayName,
      publicKey,
      signature,
      configVersion: this.options.configVersion,
      capabilities: { http: true, websocket: true },
    }))
  }

  private async accept(accepted: RelayAccepted, acceptedSocket: WebSocket | undefined): Promise<void> {
    if (this.stopped || this.socket !== acceptedSocket || acceptedSocket?.readyState !== WebSocket.OPEN) return
    if (
      accepted.type !== 'accepted' ||
      accepted.protocolVersion !== RELAY_PROTOCOL_VERSION ||
      accepted.backendId !== this.options.backendId ||
      !accepted.leaseId ||
      !Number.isSafeInteger(accepted.heartbeatIntervalMs) ||
      accepted.heartbeatIntervalMs <= 0 ||
      !Number.isSafeInteger(accepted.configVersion) ||
      accepted.configVersion !== this.options.configVersion
    ) {
      return this.fail('Relay accepted message is invalid')
    }
    this.activeLeaseId = accepted.leaseId
    const services = servicesFromAccepted({
      accepted,
      addresses: this.options.tunnelAddresses,
      bindAddresses: this.options.tunnelBindAddresses,
    })
    await writePrivateRatholeConfig(
      this.options.ratholeConfigPath,
      renderRatholeClientConfig({ serverAddr: this.options.ratholeServerAddr, services }) + validateEncryptedTransport(this.options.encryptedTransport ?? '', 'client'),
    )
    if (this.stopped || this.socket !== acceptedSocket || acceptedSocket?.readyState !== WebSocket.OPEN) return
    const previousProcess = this.ratholeProcess
    await previousProcess?.stop()
    if (this.stopped || this.socket !== acceptedSocket || acceptedSocket?.readyState !== WebSocket.OPEN) return
    const start = this.options.ratholeProcessFactory ?? ((binary: string, path: string) => startRathole(binary, path))
    this.ratholeProcess = start(this.options.ratholeBinary ?? 'rathole', this.options.ratholeConfigPath)
    const startedProcess = this.ratholeProcess
    this.ratholeProcess.process.once('error', () => { if (this.ratholeProcess === startedProcess && this.socket === acceptedSocket) this.fail('Rathole process could not start') })
    this.ratholeProcess.process.once('exit', (code) => {
      if (this.stopped || this.ratholeProcess !== startedProcess || this.socket !== acceptedSocket) return
      this.setStatus('error', `rathole exited with code ${code ?? 'null'}`)
      this.socket?.close(1011, 'rathole exited')
    })
    this.startHeartbeat(accepted)
    this.setStatus('connecting')
    if (this.options.probeToken) {
      for (let attempt = 0; attempt < 10 && this.socket === acceptedSocket && this.socket?.readyState === WebSocket.OPEN && !this.stopped; attempt++) {
        this.socket.send(JSON.stringify({ type: 'tunnel.applied', leaseId: accepted.leaseId, probeToken: this.options.probeToken() }))
        await new Promise((resolve) => setTimeout(resolve, 1000))
        if (this.status === 'online') break
      }
    }
    if (this.socket !== acceptedSocket || this.stopped) return
    if (this.status !== 'online' && this.options.probeToken) { this.fail('Authenticated tunnel did not become ready'); return }
    this.options.onAccepted?.(accepted)
  }

  private startHeartbeat(accepted: RelayAccepted): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = setInterval(() => {
      if (this.socket?.readyState !== WebSocket.OPEN) return
      this.socket.send(JSON.stringify({ type: 'heartbeat', leaseId: accepted.leaseId }))
    }, accepted.heartbeatIntervalMs)
    this.heartbeat.unref()
  }

  private handleClose(): void {
    this.activeLeaseId = undefined
    this.appliedRevision = undefined
    this.disconnectAuthorization()
    for (const waiter of this.bindingWaiters.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('Device control disconnected; request result unknown')) }
    this.bindingWaiters.clear()
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = undefined
    void this.ratholeProcess?.stop()
    this.ratholeProcess = undefined
    if (this.stopped) return
    this.setStatus('backoff')
    const delay = this.retryMs
    this.retryMs = Math.min(this.retryMs * 2, this.options.reconnectMaxMs ?? 10_000)
    this.reconnect = setTimeout(() => this.connect(), delay)
    this.reconnect.unref()
  }

  private fail(message: string): void {
    this.setStatus('error', message)
    this.socket?.close(4003, 'Backend relay protocol error')
  }

  private setStatus(status: RelayClientStatus, error?: string): void {
    this.status = status
    if (this.options.statusFile) {
      const file = this.options.statusFile
      this.statusWrites = this.statusWrites.catch(() => {}).then(() => writeRelayStatus(file, {
        protocolVersion: 2, instanceId: this.instanceId, configVersion: this.options.configVersion,
        desiredRevision: this.options.desiredRevision ?? 'unknown',
        ...(this.appliedRevision ? { appliedRevision: this.appliedRevision } : {}),
        ...(this.activeLeaseId ? { leaseId: this.activeLeaseId } : {}),
        status,
        backendId: this.options.backendId,
        ...(error ? { error } : {}),
        updatedAt: new Date().toISOString(),
      })).catch(() => this.options.onStatus?.('error', 'Device status file unavailable'))
    }
    this.options.onStatus?.(status, error)
  }
}

async function writeRelayStatus(file: string, status: import('zod').infer<typeof import('@chery/protocol').RelayClientStatusSchema>): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(status)}\n`, { mode: 0o600 })
  if (process.platform !== 'win32') await chmod(file, 0o600)
}

export async function loadOrCreatePrivateKey(file: string): Promise<KeyObject> {
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size > 8192 || (process.platform !== 'win32' && ((info.mode & 0o777) !== 0o600 || info.uid !== process.getuid?.()))) throw new Error('Device identity requires an owned 0600 regular file')
      const stored = DeviceIdentityFileSchema.parse(JSON.parse(await handle.readFile('utf8')))
      const key = createPrivateKey(stored.privateKeyPem)
      if (key.asymmetricKeyType !== 'ed25519') throw new Error('Ed25519 identity required')
      return key
    } finally { await handle.close() }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await mkdir(dirname(file), { recursive: true })
  const { privateKey } = generateKeyPairSync('ed25519')
  const stored: StoredIdentity = { version: 1, privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() }
  const temporary = `${file}.${randomBytes(16).toString('hex')}.tmp`
  try {
    const writer = await open(temporary, 'wx', 0o600)
    try { await writer.writeFile(`${JSON.stringify(stored)}\n`); await writer.sync() } finally { await writer.close() }
    try { await link(temporary, file) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  } finally { await rm(temporary, { force: true }) }
  return loadOrCreatePrivateKey(file)
}
