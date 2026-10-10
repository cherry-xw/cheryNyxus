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

export class BackendWire {
  private socket?: WebSocket
  private closed = false
  private readonly listeners = new Set<Listener>()
  private readonly pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  private connecting?: Promise<void>
  constructor(private readonly url: string, private readonly token: string) {}

  onMessage(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return
    if (this.connecting) return this.connecting
    this.closed = false
    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url, { headers: { 'X-QQBot-Token': this.token } })
      this.socket = socket
      socket.once('open', () => {
        this.connecting = undefined
        resolve()
      })
      socket.once('error', (error) => {
        this.connecting = undefined
        reject(error instanceof Error ? error : new Error('backend connection failed'))
      })
      socket.on('message', (raw) => {
        try {
          const bytes = Buffer.from(raw as Buffer)
          const parsed = JSON.parse((bytes[0] === 2 ? bytes.subarray(1) : bytes).toString())
          for (const listener of this.listeners) listener(parsed)
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
        if (this.socket === socket) this.socket = undefined
        for (const request of this.pending.values()) request.reject(new Error('backend disconnected'))
        this.pending.clear()
        if (!this.closed) this.listeners.forEach((listener) => listener({ kind: 'notification', type: 'qq.connection.state', data: { state: 'disconnected' } }))
      })
    })
    return this.connecting
  }

  async request(method: string, params: unknown): Promise<WireResponse> {
    await this.connect()
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('backend disconnected')
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ kind: 'request', id, method, params }))
    })
  }

  close(): void {
    this.closed = true
    this.socket?.close()
    this.socket = undefined
    for (const request of this.pending.values()) request.reject(new Error('backend closed'))
    this.pending.clear()
  }
}
