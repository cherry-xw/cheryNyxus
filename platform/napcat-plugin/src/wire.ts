import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'

export type WireNotification = {
  kind: 'notification'
  type: string
  data: Record<string, unknown>
}
export type WireResponse = {
  requestId?: string
  id?: string
  success: boolean
  data?: unknown
  error?: { code?: string; message?: string }
}

type Listener = (message: WireResponse | WireNotification) => void

export interface BackendChannel {
  connect(): Promise<void>
  onMessage(listener: Listener): () => void
  request(method: string, params: unknown): Promise<WireResponse>
  close(): void
}

export class BackendWire {
  private socket?: WebSocket
  private closed = false
  private readonly listeners = new Set<Listener>()
  private readonly pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  private connecting?: Promise<void>
  private reconnect?: ReturnType<typeof setTimeout>
  constructor(private readonly url: string, private readonly token: string, private readonly handshakeTimeoutMs = 10000) {}

  onMessage(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async connect(): Promise<void> {
    if (this.closed) throw Object.assign(new Error('backend closed'), { code: 'DISCONNECTED' })
    if (this.socket?.readyState === WebSocket.OPEN) return
    if (this.connecting) return this.connecting
    this.closed = false
    if (this.reconnect) clearTimeout(this.reconnect)
    this.reconnect = undefined
    this.connecting = new Promise<void>((resolve, reject) => {
      const origin = new URL(this.url)
      origin.protocol = origin.protocol === 'wss:' ? 'https:' : 'http:'
      const socket = new WebSocket(this.url, { headers: { 'X-QQBot-Token': this.token, Origin: origin.origin }, handshakeTimeout: this.handshakeTimeoutMs })
      this.socket = socket
      let opened = false
      socket.once('open', () => {
        if (this.closed || this.socket !== socket) { socket.terminate(); reject(new Error('backend closed')); return }
        opened = true
        this.connecting = undefined
        resolve()
        for (const listener of this.listeners) listener({ kind: 'notification', type: 'qq.connection.state', data: { state: 'connected' } })
      })
      socket.once('error', (error) => {
        this.connecting = undefined
        reject(error instanceof Error ? error : new Error('backend connection failed'))
      })
      socket.on('message', (raw) => {
        try {
          const bytes = Buffer.from(raw as Buffer)
          const parsed = JSON.parse((bytes[0] === 2 ? bytes.subarray(1) : bytes).toString())
          if (parsed.kind === 'ping') { socket.send(JSON.stringify({ kind: 'pong' })); return }
          for (const listener of this.listeners) listener(parsed)
          if (parsed.kind !== 'response') return
          const id = parsed.requestId ?? parsed.id
          const request = id ? this.pending.get(id) : undefined
          if (request) {
            this.pending.delete(id)
            request.resolve(parsed)
          }
        } catch {
          // A malformed frame is ignored; it must not crash NapCat.
        }
      })
      socket.once('close', () => {
        if (!opened) reject(new Error('backend disconnected'))
        if (this.socket !== socket) return
        this.connecting = undefined
        if (this.socket === socket) this.socket = undefined
        for (const request of this.pending.values()) request.reject(Object.assign(new Error('backend disconnected'), { code: 'DISCONNECTED' }))
        this.pending.clear()
        if (!this.closed) this.listeners.forEach((listener) => listener({ kind: 'notification', type: 'qq.connection.state', data: { state: 'disconnected' } }))
        if (!this.closed) this.reconnect = setTimeout(() => { this.reconnect = undefined; void this.connect().catch(() => undefined) }, 250)
      })
    })
    return this.connecting
  }

  async request(method: string, params: unknown): Promise<WireResponse> {
    await this.connect()
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) throw Object.assign(new Error('backend disconnected'), { code: 'DISCONNECTED' })
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      // Transport failure rejects pending RPCs; elapsed time is not a business result.
      this.pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ kind: 'request', id, method, params }), error => {
        if (error) { const request = this.pending.get(id); this.pending.delete(id); request?.reject(new Error('backend send failed')) }
      })
    })
  }

  close(): void {
    this.closed = true
    if (this.reconnect) clearTimeout(this.reconnect)
    this.reconnect = undefined
    this.socket?.close()
    this.socket = undefined
    for (const request of this.pending.values()) request.reject(Object.assign(new Error('backend closed'), { code: 'DISCONNECTED' }))
    this.pending.clear()
  }
}
