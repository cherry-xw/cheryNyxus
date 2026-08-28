import { encodeRequest, decodeMessage } from './transport'
import { getServerConfig, wsUrl, type ServerConfig } from './platform'
import { serviceAuth } from './authContext'
import type { ProtocolError } from '@chery/protocol'

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected'

/** Public RPC failures use the same structured contract on both sides of the socket. */
export type RpcError = ProtocolError

export interface RpcResponse {
  id: string
  kind: 'response'
  requestId: string
  success: boolean
  data?: unknown
  error?: RpcError
}

type ChunkHandler = (chunk: unknown) => void
type NotificationHandler = (notification: unknown) => void
/** V2 session/timeline event handler. Kept separate from legacy chunk/notification subscriptions. */
type EventHandler = (event: unknown) => void
type StatusHandler = (
  status: ConnectionStatus,
  detail?: { closeCode?: number; closeReason?: string },
) => void

interface PendingRequest {
  request: { id: string; kind: 'request'; method: string; params: unknown }
  resolve: (response: RpcResponse) => void
  reject: (error: Error) => void
  /** 非流式 rpc 超时计时器；response 到达 / 断连 / 重连重置时清除。防 WS 半开时永久挂起。 */
  timer?: ReturnType<typeof setTimeout>
  timeoutMs?: number
}

const RECONNECT_DELAY = 2000
/**
 * 心跳间隔（ms）。浏览器/Electron 渲染进程的 WebSocket API 无法主动发协议层 ping 帧，
 * 只能定时发应用层纯 JSON `{kind:'ping'}` 探测（后端原样回 `{kind:'pong'}`，见
 * src/service/websocket/index.ts handleMessage）。用于检测 worker 重启时的半开连接。
 */
const HEARTBEAT_INTERVAL_MS = 30000
/** 心跳探测超时（ms）：发出 ping 后 PONG_TIMEOUT 内无 pong → 下次心跳判定半开、主动 close 走重连。 */
const HEARTBEAT_TIMEOUT_MS = 10000
/**
 * 非流式 rpc 超时（ms）。WS 半开时 response 永不到达，rpc Promise 既不 resolve 也不 reject
 * → ApprovalCard pending 永不复位 → 后续点击静默无效、卡片不关（"点审批无反应+卡住"根因之一）。
 * 超时 reject 让 UI fail-loud（显「请求超时」+复位 pending 允许重试）。仅 rpc() 非流式用；
 * rpcTrack() 仅用于需要暴露 requestId 的长耗时请求，不施加普通 RPC 超时。
 */
const RPC_TIMEOUT_MS = 15000

/**
 * 生成 requestId（rpc 请求关联用）。
 * crypto.randomUUID 仅 secure context（localhost/https）可用；跨机器 http 访问等
 * 非 secure context 下 crypto.randomUUID 缺失 → fallback Math.random 拼 RFC4122 v4。
 */
function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

/**
 * WebSocket 客户端：
 * - `ServerConfig` 类型与 `getServerConfig` / `wsUrl` 由 [./platform.ts](./platform.ts) 提供；
 *   本文件不再直读 `window.__*`，不重复 `declare global`。
 * - rpc(method, params) → Promise<RpcResponse>，按 Request.id 匹配 Response
 * - onChunk / onNotification / onStatus 回调订阅
 * - 断线自动重连
 */
export class WsClient {
  private ws: WebSocket | null = null
  private serverConfig: ServerConfig | null = null
  /** 附加 URL 查询参数（lite 实例专用，见 connect()）。 */
  private extraQuery: Record<string, string> | null = null
  private pending = new Map<string, PendingRequest>()
  private status: ConnectionStatus = 'disconnected'
  private chunkHandlers = new Set<ChunkHandler>()
  private notificationHandlers = new Set<NotificationHandler>()
  private eventHandlers = new Set<EventHandler>()
  private statusHandlers = new Set<StatusHandler>()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private shouldReconnect = false
  private connectionGeneration = 0
  private reconnectWaiters: Array<{ generation: number; resolve: () => void }> = []
  /** 心跳：连接级定时器 + 单次探测超时（pong 到达时清除）。 */
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null
  private heartbeatPending: ReturnType<typeof setTimeout> | null = null
  /** Highest consumed recoverable event sequence per chat for this page lifetime. */
  private chatSeq = new Map<string, number>()
  /** Events that arrived ahead of a missing sequence while a sync is in flight. */
  private pendingChatEvents = new Map<string, Map<number, unknown>>()

  getStatus(): ConnectionStatus {
    return this.status
  }

  getLastSeq(chatId: string): number {
    return this.chatSeq.get(chatId) ?? 0
  }

  /** Highest observed sequence, including events deliberately held by a replay fence. */
  getHighestSeenSeq(chatId: string): number {
    let highest = this.getLastSeq(chatId)
    const pending = this.pendingChatEvents.get(chatId)
    if (!pending) return highest
    for (const seq of pending.keys()) highest = Math.max(highest, seq)
    return highest
  }

  /** A reset snapshot supersedes all retained events at or before latestSeq. */
  resetChatSeq(chatId: string, latestSeq: number): void {
    this.chatSeq.set(chatId, latestSeq)
    const pending = this.pendingChatEvents.get(chatId)
    if (!pending) return
    for (const seq of pending.keys()) {
      if (seq <= latestSeq) pending.delete(seq)
    }
    this.drainChatEvents(chatId)
  }

  onChunk(handler: ChunkHandler): () => void {
    this.chunkHandlers.add(handler)
    return () => this.chunkHandlers.delete(handler)
  }

  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.add(handler)
    return () => this.notificationHandlers.delete(handler)
  }

  /** Subscribe to every non-RPC event, including V2 session and timeline events. */
  onEvent(handler: EventHandler): () => void {
    this.eventHandlers.add(handler)
    return () => this.eventHandlers.delete(handler)
  }

  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler)
    return () => this.statusHandlers.delete(handler)
  }

  /**
   * 建立连接。serverConfig 缓存后默认复用（Electron preload 注入快照）；
   * `refresh: true` 强制重新拉取最新配置——worker 重启会轮换本地 sessionToken，
   * **任何「重启后重连/手动重连」必须传 refresh**，否则缓存旧 token 会被服务端
   * verifyClient 401 拒绝。Electron 下刷新经 main 进程 IPC（渲染进程直接 fetch
   * /api/config 会被 CORS 拦截），浏览器走同源 fetch，见 [./platform.ts](./platform.ts)。
   */
  async connect(
    options: { refresh?: boolean; query?: Record<string, string> } = {},
  ): Promise<void> {
    // query（T33 lite）：附加 URL 查询参数，随实例持久、重连自动携带。仅供独立 lite
    // 实例使用——主 UI 单例不得传（lite 连接信封最小化会破坏主 UI gap-buffer/replay 协议）。
    if (options.query) this.extraQuery = options.query
    if (!this.serverConfig || options.refresh) {
      this.serverConfig = await getServerConfig({ refresh: options.refresh ?? false })
    }
    this.shouldReconnect = true
    this.open()
  }

  /** 注册一次性重连观察；非即时重启的调用方可 cancel，避免无用等待者累积。 */
  watchNextReconnect(): { promise: Promise<void>; cancel: () => void } {
    const generation = this.connectionGeneration + 1
    let waiter: { generation: number; resolve: () => void }
    const promise = new Promise<void>((resolve) => {
      waiter = { generation, resolve }
      this.reconnectWaiters.push(waiter)
    })
    return {
      promise,
      cancel: () => {
        this.reconnectWaiters = this.reconnectWaiters.filter((item) => item !== waiter)
      },
    }
  }

  /** 在当前连接下一次完成“断线 → 成功连接”后 resolve，供一般调用方等待。 */
  waitForNextReconnect(): Promise<void> {
    return this.watchNextReconnect().promise
  }

  // ---- 心跳（半开连接检测）---------------------------------------------------
  /**
   * 启动心跳定时器（ws open 后）。每 HEARTBEAT_INTERVAL_MS 发一次探测：
   * - 若上一次 ping 的 pong 尚未到达（heartbeatPending 还挂着）→ 判定半开，主动 close() 走重连；
   * - 否则发 `{kind:'ping'}` 并设 HEARTBEAT_TIMEOUT_MS 期待 pong（到达时清除）。
   */
  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatInterval = setInterval(() => {
      const ws = this.ws
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      if (this.heartbeatPending) {
        console.warn('[ws] 心跳无响应，判定连接半开，主动断开触发重连')
        ws.close()
        return
      }
      ws.send(JSON.stringify({ kind: 'ping' }))
      this.heartbeatPending = setTimeout(() => {
        // 超时只清标记：不立即 close，等下一次心跳检查（避免正常抖动的误杀）。
        this.heartbeatPending = null
      }, HEARTBEAT_TIMEOUT_MS)
    }, HEARTBEAT_INTERVAL_MS)
  }

  /** 停止心跳（ws close 后）。 */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }
    this.clearHeartbeatPending()
  }

  /** pong 到达：清掉本次探测超时标记。 */
  private clearHeartbeatPending(): void {
    if (this.heartbeatPending) {
      clearTimeout(this.heartbeatPending)
      this.heartbeatPending = null
    }
  }

  private open(): void {
    if (!this.serverConfig) return
    this.setStatus('connecting')
    const baseUrl = wsUrl(this.serverConfig)
    // 远端走 access token（browser WS 无法设 Authorization 头 → URL ?token=）；本地走进程 sessionToken。
    const auth = serviceAuth()
    const token = auth.isRemote() ? auth.accessToken() : this.serverConfig.sessionToken
    const extra = this.extraQuery
      ? Object.entries(this.extraQuery)
          .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
          .join('&')
      : ''
    const url = token
      ? `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}${extra ? `&${extra}` : ''}`
      : extra
        ? `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}${extra}`
        : baseUrl
    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    ws.onopen = () => {
      this.setStatus('connected')
      this.startHeartbeat()
      // Reuse the original Request.id after a disconnect. The server either
      // joins the in-flight execution or returns its stored terminal response.
      // 非流式 rpc 重连重发：重置超时窗口（断连期已耗去部分时间，给重发请求新窗口）。
      for (const pending of this.pending.values()) {
        this.armRpcTimeout(pending)
        ws.send(encodeRequest(pending.request))
      }
    }
    ws.onclose = (ev: CloseEvent) => {
      // 旧 socket 的迟到 close 不能覆盖新连接或重复安排重连。
      if (this.ws !== ws) return
      this.ws = null
      this.stopHeartbeat()
      this.setStatus('disconnected', { closeCode: ev.code, closeReason: ev.reason })
      if (this.shouldReconnect) {
        this.scheduleReconnect()
      } else {
        this.rejectAll(new Error('连接关闭'))
      }
    }
    ws.onerror = () => {
      // 出错后 onclose 会触发，不在此重复处理
      ws.close()
    }
    ws.onmessage = (ev: MessageEvent) => this.handleMessage(ev)
  }

  private handleMessage(ev: MessageEvent): void {
    const msg = decodeMessage(ev.data as ArrayBuffer | string)
    if (!msg || typeof msg !== 'object') return

    const kind = (msg as { kind?: string }).kind
    // 心跳 pong（后端对 {kind:'ping'} 原样回）：仅清除探测超时标记，不入事件流。
    if (kind === 'pong') {
      this.clearHeartbeatPending()
      return
    }
    const envelope = msg as {
      requestId?: unknown
      chatId?: unknown
      seq?: unknown
      eventSeq?: unknown
      rootChatId?: unknown
      rootEventSeq?: unknown
      subscriptionId?: unknown
    }
    if (kind === 'response') {
      const response = msg as RpcResponse
      const pending = this.pending.get(response.requestId)
      if (pending) {
        if (pending.timer) clearTimeout(pending.timer)
        this.pending.delete(response.requestId)
        pending.resolve(response)
      }
      return
    }
    // Root subscriptions have their own root-wide cursor. They must not enter
    // the per-chat gap buffer below: opening an existing root can legitimately
    // deliver source seq 3000 while this page has never consumed source seq 1.
    // The root timeline store validates rootEventSeq against the atomic
    // chat.open boundary and performs an authoritative resync on a real gap.
    if (
      typeof envelope.rootChatId === 'string' &&
      typeof envelope.rootEventSeq === 'number' &&
      typeof envelope.subscriptionId === 'string'
    ) {
      this.dispatchEvent(msg, kind)
      return
    }
    // V2 renames the per-chat cursor to eventSeq. The same ordered gap buffer
    // is deliberately reused; both protocols remain safe during migration.
    const sequence =
      typeof envelope.seq === 'number'
        ? envelope.seq
        : typeof envelope.eventSeq === 'number'
          ? envelope.eventSeq
          : undefined
    if (typeof envelope.chatId === 'string' && sequence !== undefined) {
      const consumed = this.chatSeq.get(envelope.chatId) ?? 0
      if (sequence <= consumed) return
      let pending = this.pendingChatEvents.get(envelope.chatId)
      if (!pending) {
        pending = new Map()
        this.pendingChatEvents.set(envelope.chatId, pending)
      }
      pending.set(sequence, msg)
      this.drainChatEvents(envelope.chatId)
      return
    }
    this.dispatchEvent(msg, kind)
  }

  private drainChatEvents(chatId: string): void {
    const pending = this.pendingChatEvents.get(chatId)
    if (!pending) return
    let consumed = this.chatSeq.get(chatId) ?? 0
    while (true) {
      const next = pending.get(consumed + 1)
      if (!next) break
      pending.delete(consumed + 1)
      consumed += 1
      this.chatSeq.set(chatId, consumed)
      this.dispatchEvent(next, (next as { kind?: string }).kind)
    }
    if (pending.size === 0) this.pendingChatEvents.delete(chatId)
  }

  private dispatchEvent(msg: unknown, kind: unknown): void {
    this.eventHandlers.forEach((h) => h(msg))
    if (kind === 'chunk') {
      this.chunkHandlers.forEach((h) => h(msg))
    } else if (kind === 'notification') {
      this.notificationHandlers.forEach((h) => h(msg))
    }
  }

  rpc(
    method: string,
    params: unknown = {},
    options?: { timeoutMs?: number },
  ): Promise<RpcResponse> {
    if (!this.ws || this.status !== 'connected') {
      return Promise.reject(new Error('还没连上服务器'))
    }
    const id = uuid()
    const request = { id, kind: 'request' as const, method, params }
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = { request, resolve, reject, timeoutMs: options?.timeoutMs }
      this.pending.set(id, pending)
      this.armRpcTimeout(pending)
      this.ws!.send(encodeRequest(request))
    })
  }

  /**
   * 非流式 rpc 超时武装：RPC_TIMEOUT_MS 内无 response → reject + 清 pending。
   * 幂等：重连重置时先清旧 timer 再武装新窗口。
   */
  private armRpcTimeout(pending: PendingRequest): void {
    if (pending.timer) clearTimeout(pending.timer)
    pending.timer = setTimeout(() => {
      if (this.pending.delete(pending.request.id)) {
        pending.reject(new Error('请求超时，连接可能已断开，请重试'))
      }
    }, pending.timeoutMs ?? RPC_TIMEOUT_MS)
  }

  /**
   * 与 rpc 相同，但额外暴露 requestId，供调用方关联流式 chunk（chat.send/chat.get）。
   * chunk 按 requestId 路由 → 调用方需记录 requestId→chatId 映射（见 agents store）。
   */
  rpcTrack(
    method: string,
    params: unknown = {},
  ): { requestId: string; response: Promise<RpcResponse> } {
    if (!this.ws || this.status !== 'connected') {
      return { requestId: '', response: Promise.reject(new Error('还没连上服务器')) }
    }
    const requestId = uuid()
    const request = { id: requestId, kind: 'request' as const, method, params }
    const response = new Promise<RpcResponse>((resolve, reject) => {
      this.pending.set(requestId, { request, resolve, reject })
      this.ws!.send(encodeRequest(request))
    })
    return { requestId, response }
  }

  disconnect(): void {
    this.shouldReconnect = false
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.ws?.close()
    this.ws = null
  }

  private setStatus(
    status: ConnectionStatus,
    detail?: { closeCode?: number; closeReason?: string },
  ): void {
    const previous = this.status
    this.status = status
    if (status === 'connected' && previous !== 'connected') {
      this.connectionGeneration += 1
      const ready = this.reconnectWaiters.filter(
        (waiter) => waiter.generation <= this.connectionGeneration,
      )
      this.reconnectWaiters = this.reconnectWaiters.filter(
        (waiter) => waiter.generation > this.connectionGeneration,
      )
      ready.forEach((waiter) => waiter.resolve())
    }
    this.statusHandlers.forEach((h) => h(status, detail))
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.shouldReconnect) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.reconnect()
    }, RECONNECT_DELAY)
  }

  private async reconnect(): Promise<void> {
    try {
      // 每次重连刷新 token/端口/transport；worker 重启后旧 token 必然失效。
      this.serverConfig = await getServerConfig({ refresh: true })
      // 远端：重连前用 refresh token 续期 access（过期则自动重新登录；失败登出）。
      // 仅当已登录（有 access token）才续期，未登录连接不触发。
      const auth = serviceAuth()
      if (auth.isRemote() && auth.accessToken()) {
        await auth.refresh()
      }
      if (this.shouldReconnect) this.open()
    } catch (e) {
      // 重连准备失败显性化：worker 重启/网络抖动时 fetch（getServerConfig）或
      // refresh 抛错。静默吞错会让「重连卡住」无任何日志，难以排查。
      console.warn('[ws] 重连准备失败，2s 后重试:', e instanceof Error ? e.message : e)
      this.setStatus('disconnected')
      this.scheduleReconnect()
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}

export const wsClient = new WsClient()
