import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { generateKeyPairSync, sign, type KeyObject, createPrivateKey, createPublicKey } from 'node:crypto'
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
  private ratholeProcess?: RatholeProcess

  constructor(private readonly options: RelayClientOptions) {
    this.retryMs = options.reconnectMinMs ?? 500
  }

  getStatus(): RelayClientStatus {
    return this.status
  }

  async start(): Promise<void> {
    this.stopped = false
    this.privateKey = await loadOrCreatePrivateKey(this.options.keyFile)
    this.connect()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.reconnect) clearTimeout(this.reconnect)
    if (this.heartbeat) clearInterval(this.heartbeat)
    await this.ratholeProcess?.stop()
    this.ratholeProcess = undefined
    this.socket?.close(1000, 'Client stopped')
    this.socket = undefined
    this.setStatus('stopped')
  }

  updateConfigVersion(configVersion: number): void {
    if (!Number.isSafeInteger(configVersion) || configVersion < 1) throw new Error('configVersion must be a positive integer')
    this.options.configVersion = configVersion
    if (this.status === 'online' || this.status === 'connecting' || this.status === 'backoff') {
      this.socket?.close(1000, 'Configuration version changed')
    }
  }

  private connect(): void {
    if (this.stopped) return
    this.setStatus('connecting')
    const factory = this.options.webSocketFactory ?? ((url: string) => new WebSocket(url))
    const socket = factory(this.options.url)
    this.socket = socket
    socket.once('open', () => this.retryMs = this.options.reconnectMinMs ?? 500)
    socket.on('message', (data, isBinary) => void this.handleMessage(data, isBinary))
    socket.once('close', () => this.handleClose())
    socket.once('error', (error) => this.setStatus('error', error.message))
  }

  private async handleMessage(data: RawData, isBinary: boolean): Promise<void> {
    if (isBinary) return this.fail('Relay control messages must be text')
    let message: Record<string, unknown>
    try {
      message = JSON.parse(data.toString()) as Record<string, unknown>
    } catch {
      return this.fail('Relay control message is invalid JSON')
    }
    if (message.type === 'challenge') {
      await this.answerChallenge(message as unknown as RelayChallenge)
      return
    }
    if (message.type === 'accepted') {
      await this.accept(message as unknown as RelayAccepted)
      return
    }
    if (message.type === 'heartbeat_ack') {
      this.setStatus('online')
      return
    }
    if (message.type === 'error') {
      const errorCode = (message.error as { code?: unknown } | undefined)?.code
      if (errorCode === 'BACKEND_AUTH_FAILED' || errorCode === 'BACKEND_ID_CONFLICT' || errorCode === 'PROTOCOL_VERSION_UNSUPPORTED') {
        this.stopped = true
      }
      return this.fail('Relay rejected the backend connection')
    }
  }

  private async answerChallenge(challenge: RelayChallenge): Promise<void> {
    if (challenge.protocolVersion !== RELAY_PROTOCOL_VERSION || Date.parse(challenge.expiresAt) <= Date.now()) {
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

  private async accept(accepted: RelayAccepted): Promise<void> {
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
    const services = servicesFromAccepted({
      accepted,
      addresses: this.options.tunnelAddresses,
      bindAddresses: this.options.tunnelBindAddresses,
    })
    await writePrivateRatholeConfig(
      this.options.ratholeConfigPath,
      renderRatholeClientConfig({ serverAddr: this.options.ratholeServerAddr, services }),
    )
    await this.ratholeProcess?.stop()
    const start = this.options.ratholeProcessFactory ?? ((binary: string, path: string) => startRathole(binary, path))
    this.ratholeProcess = start(this.options.ratholeBinary ?? 'rathole', this.options.ratholeConfigPath)
    this.ratholeProcess.process.once('exit', (code) => {
      if (this.stopped || this.ratholeProcess?.process.exitCode !== code) return
      this.setStatus('error', `rathole exited with code ${code ?? 'null'}`)
      this.socket?.close(1011, 'rathole exited')
    })
    this.startHeartbeat(accepted)
    this.setStatus('online')
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
      void writeRelayStatus(this.options.statusFile, {
        status,
        backendId: this.options.backendId,
        ...(error ? { error } : {}),
        updatedAt: new Date().toISOString(),
      })
    }
    this.options.onStatus?.(status, error)
  }
}

async function writeRelayStatus(file: string, status: {
  status: RelayClientStatus
  backendId: string
  error?: string
  updatedAt: string
}): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(status)}\n`, { mode: 0o600 })
  if (process.platform !== 'win32') await chmod(file, 0o600)
}

async function loadOrCreatePrivateKey(file: string): Promise<KeyObject> {
  const raw = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return undefined
  })
  if (raw) {
    const stored = JSON.parse(raw) as StoredIdentity
    if (stored.version !== 1 || typeof stored.privateKeyPem !== 'string') throw new Error('Unsupported relay identity file')
    return createPrivateKey(stored.privateKeyPem)
  }
  const { privateKey } = generateKeyPairSync('ed25519')
  await mkdir(dirname(file), { recursive: true })
  const stored: StoredIdentity = { version: 1, privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() }
  await writeFile(file, `${JSON.stringify(stored)}\n`, { mode: 0o600 })
  if (process.platform !== 'win32') await chmod(file, 0o600)
  return privateKey
}
