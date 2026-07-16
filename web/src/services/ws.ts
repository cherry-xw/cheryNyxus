import { encodeRequest, decodeMessage } from "./transport";
import { getServerConfig, wsUrl, type ServerConfig } from "./platform";

export type ConnectionStatus = "disconnected" | "connecting" | "connected";

export interface RpcError {
  code: string;
  message: string;
}

export interface RpcResponse {
  id: string;
  kind: "response";
  requestId: string;
  success: boolean;
  data?: unknown;
  error?: RpcError;
}

type ChunkHandler = (chunk: unknown) => void;
type NotificationHandler = (notification: unknown) => void;
type StatusHandler = (status: ConnectionStatus) => void;

interface PendingRequest {
  request: { id: string; kind: "request"; method: string; params: unknown };
  resolve: (response: RpcResponse) => void;
  reject: (error: Error) => void;
}

const RECONNECT_DELAY = 2000;

/**
 * 生成 requestId（rpc 请求关联用）。
 * crypto.randomUUID 仅 secure context（localhost/https）可用；跨机器 http 访问等
 * 非 secure context 下 crypto.randomUUID 缺失 → fallback Math.random 拼 RFC4122 v4。
 */
function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
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
  private ws: WebSocket | null = null;
  private serverConfig: ServerConfig | null = null;
  private pending = new Map<string, PendingRequest>();
  private status: ConnectionStatus = "disconnected";
  private chunkHandlers = new Set<ChunkHandler>();
  private notificationHandlers = new Set<NotificationHandler>();
  private statusHandlers = new Set<StatusHandler>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = false;
  private connectionGeneration = 0;
  private reconnectWaiters: Array<{ generation: number; resolve: () => void }> = [];
  /** Highest consumed recoverable event sequence per chat for this page lifetime. */
  private chatSeq = new Map<string, number>();
  /** Events that arrived ahead of a missing sequence while a sync is in flight. */
  private pendingChatEvents = new Map<string, Map<number, unknown>>();

  getStatus(): ConnectionStatus {
    return this.status;
  }

  getLastSeq(chatId: string): number {
    return this.chatSeq.get(chatId) ?? 0;
  }

  /** A reset snapshot supersedes all retained events at or before latestSeq. */
  resetChatSeq(chatId: string, latestSeq: number): void {
    this.chatSeq.set(chatId, latestSeq);
    const pending = this.pendingChatEvents.get(chatId);
    if (!pending) return;
    for (const seq of pending.keys()) {
      if (seq <= latestSeq) pending.delete(seq);
    }
    this.drainChatEvents(chatId);
  }

  onChunk(handler: ChunkHandler): () => void {
    this.chunkHandlers.add(handler);
    return () => this.chunkHandlers.delete(handler);
  }

  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  async connect(): Promise<void> {
    if (!this.serverConfig) {
      this.serverConfig = await getServerConfig();
    }
    this.shouldReconnect = true;
    this.open();
  }

  /** 注册一次性重连观察；非即时重启的调用方可 cancel，避免无用等待者累积。 */
  watchNextReconnect(): { promise: Promise<void>; cancel: () => void } {
    const generation = this.connectionGeneration + 1;
    let waiter: { generation: number; resolve: () => void };
    const promise = new Promise<void>((resolve) => {
      waiter = { generation, resolve };
      this.reconnectWaiters.push(waiter);
    });
    return {
      promise,
      cancel: () => {
        this.reconnectWaiters = this.reconnectWaiters.filter((item) => item !== waiter);
      },
    };
  }

  /** 在当前连接下一次完成“断线 → 成功连接”后 resolve，供一般调用方等待。 */
  waitForNextReconnect(): Promise<void> {
    return this.watchNextReconnect().promise;
  }

  private open(): void {
    if (!this.serverConfig) return;
    this.setStatus("connecting");
    const baseUrl = wsUrl(this.serverConfig);
    const url = this.serverConfig.sessionToken
      ? `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}token=${encodeURIComponent(this.serverConfig.sessionToken)}`
      : baseUrl;
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      this.setStatus("connected");
      // Reuse the original Request.id after a disconnect. The server either
      // joins the in-flight execution or returns its stored terminal response.
      for (const pending of this.pending.values()) {
        ws.send(encodeRequest(pending.request));
      }
    };
    ws.onclose = () => {
      // 旧 socket 的迟到 close 不能覆盖新连接或重复安排重连。
      if (this.ws !== ws) return;
      this.ws = null;
      this.setStatus("disconnected");
      if (this.shouldReconnect) {
        this.scheduleReconnect();
      } else {
        this.rejectAll(new Error("连接关闭"));
      }
    };
    ws.onerror = () => {
      // 出错后 onclose 会触发，不在此重复处理
      ws.close();
    };
    ws.onmessage = (ev: MessageEvent) => this.handleMessage(ev);
  }

  private handleMessage(ev: MessageEvent): void {
    const msg = decodeMessage(ev.data as ArrayBuffer | string);
    if (!msg || typeof msg !== "object") return;

    const kind = (msg as { kind?: string }).kind;
    const envelope = msg as { chatId?: unknown; seq?: unknown };
    if (kind === "response") {
      const response = msg as RpcResponse;
      const pending = this.pending.get(response.requestId);
      if (pending) {
        this.pending.delete(response.requestId);
        pending.resolve(response);
      }
      return;
    }
    if (typeof envelope.chatId === "string" && typeof envelope.seq === "number") {
      const consumed = this.chatSeq.get(envelope.chatId) ?? 0;
      if (envelope.seq <= consumed) return;
      let pending = this.pendingChatEvents.get(envelope.chatId);
      if (!pending) {
        pending = new Map();
        this.pendingChatEvents.set(envelope.chatId, pending);
      }
      pending.set(envelope.seq, msg);
      this.drainChatEvents(envelope.chatId);
      return;
    }
    this.dispatchEvent(msg, kind);
  }

  private drainChatEvents(chatId: string): void {
    const pending = this.pendingChatEvents.get(chatId);
    if (!pending) return;
    let consumed = this.chatSeq.get(chatId) ?? 0;
    while (true) {
      const next = pending.get(consumed + 1);
      if (!next) break;
      pending.delete(consumed + 1);
      consumed += 1;
      this.chatSeq.set(chatId, consumed);
      this.dispatchEvent(next, (next as { kind?: string }).kind);
    }
    if (pending.size === 0) this.pendingChatEvents.delete(chatId);
  }

  private dispatchEvent(msg: unknown, kind: unknown): void {
    if (kind === "chunk") {
      this.chunkHandlers.forEach((h) => h(msg));
    } else if (kind === "notification") {
      this.notificationHandlers.forEach((h) => h(msg));
    }
  }

  rpc(method: string, params: unknown = {}): Promise<RpcResponse> {
    if (!this.ws || this.status !== "connected") {
      return Promise.reject(new Error("WebSocket 未连接"));
    }
    const id = uuid();
    const request = { id, kind: "request" as const, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { request, resolve, reject });
      this.ws!.send(encodeRequest(request));
    });
  }

  /**
   * 与 rpc 相同，但额外暴露 requestId，供调用方关联流式 chunk（chat.send/chat.get）。
   * chunk 按 requestId 路由 → 调用方需记录 requestId→chatId 映射（见 agents store）。
   */
  rpcTrack(method: string, params: unknown = {}): { requestId: string; response: Promise<RpcResponse> } {
    if (!this.ws || this.status !== "connected") {
      return { requestId: "", response: Promise.reject(new Error("WebSocket 未连接")) };
    }
    const requestId = uuid();
    const request = { id: requestId, kind: "request" as const, method, params };
    const response = new Promise<RpcResponse>((resolve, reject) => {
      this.pending.set(requestId, { request, resolve, reject });
      this.ws!.send(encodeRequest(request));
    });
    return { requestId, response };
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  private setStatus(status: ConnectionStatus): void {
    const previous = this.status;
    this.status = status;
    if (status === "connected" && previous !== "connected") {
      this.connectionGeneration += 1;
      const ready = this.reconnectWaiters.filter((waiter) => waiter.generation <= this.connectionGeneration);
      this.reconnectWaiters = this.reconnectWaiters.filter((waiter) => waiter.generation > this.connectionGeneration);
      ready.forEach((waiter) => waiter.resolve());
    }
    this.statusHandlers.forEach((h) => h(status));
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.shouldReconnect) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnect();
    }, RECONNECT_DELAY);
  }

  private async reconnect(): Promise<void> {
    try {
      // 每次重连刷新 token/端口/transport；worker 重启后旧 token 必然失效。
      this.serverConfig = await getServerConfig({ refresh: true });
      if (this.shouldReconnect) this.open();
    } catch {
      this.setStatus("disconnected");
      this.scheduleReconnect();
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export const wsClient = new WsClient();
