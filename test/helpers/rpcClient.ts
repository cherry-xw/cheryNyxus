/**
 * Tier 2 流程测试 RPC 客户端：真实 WebSocket + binary 帧编解码 + 断连重连。
 *
 * 对齐 src/service/websocket/transport.ts 的线上格式（binary 模式）：
 * - C→S Request：纯 JSON 文本（服务端 parseMessage = toString+JSON.parse，无帧前缀）
 * - S→C Response：纯 JSON 文本（serializeMessage = JSON.stringify，以 `{` 0x7B 起首）
 * - S→C stream chunk：`[0x01][reqId_len:1][reqId][payload_json]`，payload 可为裸 StreamChunkData
 *   或 `{data,chatId?,runId?,seq?}`
 * - S→C staged/notification：`[0x02][json]`
 * （json 传输模式下全部为裸 JSON → 落入 else 分支，兼容）
 *
 * 事件归属：chunk/notification 携 requestId → 归入该 request 的 events；无 requestId 的异步事件
 * （role_created/role_reply 等）→ background。断连时 reject 所有 pending 的 response promise，
 * 但保留 events 数组与 pending 表项，使重连后同 requestId 的实时输出继续累积（供刷新重连场景）。
 */
import WebSocket from 'ws'
import { randomUUID } from 'node:crypto'
import { safeJsonParse } from '@/utils/json.js'
import type { Chunk, Notification, Response } from '@/service/message/types.js'

const FRAME_STREAM = 0x01
const FRAME_JSON = 0x02

export interface RpcClientOptions {
  url: string
  /** verifyClient 要求 Origin 在 allowedOrigins 内（harness 注入 http://127.0.0.1:<webPort>）。 */
  origin: string
  connectTimeoutMs?: number
}

export interface RequestHandle {
  id: string
  /** 该 requestId 的实时事件（chunk/notification），断连重连后继续累积。 */
  events: Array<Chunk | Notification>
  /** 终态 Response。断连时 reject（ConnectionClosedError）。 */
  response: Promise<Response>
}

export class ConnectionClosedError extends Error {
  constructor(message = 'WebSocket connection closed') {
    super(message)
    this.name = 'ConnectionClosedError'
  }
}

type S2CMessage = Response | Chunk | Notification

function isResponse(msg: S2CMessage): msg is Response {
  return (msg as Response).kind === 'response'
}

interface PendingEntry {
  id: string
  events: Array<Chunk | Notification>
  resolveResponse: (r: Response) => void
  rejectResponse: (e: Error) => void
  settled: boolean
}

export class RpcClient {
  private ws?: WebSocket
  private readonly options: RpcClientOptions
  private readonly pending = new Map<string, PendingEntry>()
  /**
   * Every inbound chunk/notification, appended exactly once before request
   * projection. Async protocol assertions must read this journal instead of
   * guessing whether an event belongs to a request handle or to background.
   */
  readonly received: Array<Chunk | Notification> = []
  /** 无 requestId 归属的异步事件（role_created / role_reply / 重连后旧 run 的实时输出）。 */
  readonly background: Array<Chunk | Notification> = []

  constructor(options: RpcClientOptions) {
    this.options = options
  }

  async connect(): Promise<void> {
    const ws = new WebSocket(this.options.url, {
      headers: { Origin: this.options.origin },
    })
    this.ws = ws
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`connect timeout: ${this.options.url}`))
      }, this.options.connectTimeoutMs ?? 5000)
      const onOpen = () => {
        clearTimeout(timer)
        ws.off('error', onError)
        resolve()
      }
      const onError = (err: Error) => {
        clearTimeout(timer)
        ws.off('open', onOpen)
        reject(err)
      }
      ws.once('open', onOpen)
      ws.once('error', onError)
    })
    ws.on('message', (data) =>
      this.onMessage(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)),
    )
    ws.on('close', () => this.onClose())
  }

  /** 断连后重连：复用同一 client，pending 表项与 events 数组保留。 */
  async reconnect(): Promise<void> {
    this.detachSocket()
    await this.connect()
  }

  /** 主动关闭：reject 所有未结算 pending，但保留表项以便重连续传。 */
  close(): void {
    this.detachSocket()
  }

  private detachSocket(): void {
    // 先 reject in-flight（removeAllListeners 后 ws 'close' 不再触发 onClose）
    this.onClose()
    if (this.ws) {
      this.ws.removeAllListeners()
      if (this.ws.readyState === WebSocket.OPEN) this.ws.close()
      this.ws = undefined
    }
  }

  private onClose(): void {
    for (const entry of this.pending.values()) {
      if (!entry.settled) {
        entry.settled = true
        entry.rejectResponse(new ConnectionClosedError())
      }
    }
  }

  /**
   * 发起请求，立即返回 handle（不阻塞）。调用方据 handle.events 观察实时事件，
   * 适当时机 await handle.response 拿终态。支持运行中发起 abort / 断连重连。
   */
  request(method: string, params: unknown): RequestHandle {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new ConnectionClosedError('cannot request: socket not open')
    }
    const id = randomUUID()
    const events: Array<Chunk | Notification> = []
    const response = new Promise<Response>((resolve, reject) => {
      this.pending.set(id, {
        id,
        events,
        resolveResponse: resolve,
        rejectResponse: reject,
        settled: false,
      })
    })
    // 断连时 onClose reject 此 promise；若无消费者 await（如重连场景只看 events），
    // 挂吞 catch 标记已处理，避免 unhandledRejection。后续 await 仍能拿到 rejection。
    response.catch(() => {})
    this.ws.send(JSON.stringify({ id, kind: 'request', method, params }))
    return { id, events, response }
  }

  /** 便捷：发起请求并 await 终态 Response（适用于短请求 / 无需观察流中事件）。 */
  async call(method: string, params: unknown, timeoutMs = 10000): Promise<Response> {
    const handle = this.request(method, params)
    try {
      return await this.awaitResponse(handle, timeoutMs)
    } finally {
      // call() is for unary RPCs. Streaming/ACK-then-events callers use
      // request() and release the handle after observing a terminal event.
      this.release(handle)
    }
  }

  async awaitResponse(handle: RequestHandle, timeoutMs = 10000): Promise<Response> {
    const timer = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`response timeout: ${handle.id}`)), timeoutMs),
    )
    return Promise.race([handle.response, timer])
  }

  /** Release request correlation while retaining events in the global journal. */
  release(handle: RequestHandle | string): void {
    this.pending.delete(typeof handle === 'string' ? handle : handle.id)
  }

  /** Test diagnostics: number of request handles still retaining correlation. */
  get pendingCount(): number {
    return this.pending.size
  }

  private onMessage(data: Buffer): void {
    const msg = decodeFrame(data)
    if (!msg || typeof msg !== 'object') return
    if (isResponse(msg)) {
      const entry = this.pending.get(msg.requestId)
      if (entry && !entry.settled) {
        entry.settled = true
        entry.resolveResponse(msg)
      }
      return
    }
    this.received.push(msg)
    const requestId = (msg as Chunk | Notification).requestId
    const entry = requestId ? this.pending.get(requestId) : undefined
    if (entry) entry.events.push(msg)
    else this.background.push(msg)
  }
}

/**
 * 解码 S→C 帧。byte0 = 0x01 stream 帧 / 0x02 json 帧 / 否则裸 JSON（response 或 json 模式消息）。
 */
function decodeFrame(data: Buffer): S2CMessage | null {
  const first = data[0]
  if (first === FRAME_STREAM) {
    const len = data[1] ?? 0
    const requestId = data.subarray(2, 2 + len).toString('utf-8')
    const payloadRaw = data.subarray(2 + len).toString('utf-8')
    const payload = safeJsonParse<Record<string, unknown>>(payloadRaw, {})
    if (payload && typeof payload === 'object' && 'data' in payload) {
      const p = payload as { data: unknown; chatId?: string; runId?: string; seq?: number }
      return {
        kind: 'chunk',
        type: 'stream',
        requestId,
        ...(p.chatId ? { chatId: p.chatId } : {}),
        ...(p.runId ? { runId: p.runId } : {}),
        ...(p.seq !== undefined ? { seq: p.seq } : {}),
        data: p.data as Chunk['data'],
      }
    }
    return { kind: 'chunk', type: 'stream', requestId, data: payload as Chunk['data'] }
  }
  if (first === FRAME_JSON) {
    return safeJsonParse<S2CMessage>(data.subarray(1).toString('utf-8'), null)
  }
  return safeJsonParse<S2CMessage>(data.toString('utf-8'), null)
}
