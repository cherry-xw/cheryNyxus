import { encodeRequest, decodeMessage } from "./transport";
import { httpUrl } from "./http";

declare global {
  interface Window {
    /** Electron 模式由 preload 注入；浏览器模式无 */
    __BACKEND_CONFIG__?: ServerConfig;
  }
}

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

export interface ServerConfig {
  wsPort: number;
  webPort: number;
  transport: "binary" | "json";
  /** Ephemeral local capability required by the backend WebSocket control plane. */
  sessionToken?: string;
}

type ChunkHandler = (chunk: unknown) => void;
type NotificationHandler = (notification: unknown) => void;
type StatusHandler = (status: ConnectionStatus) => void;

interface PendingRequest {
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
 * - Electron 模式：读 window.__BACKEND_CONFIG__（preload 注入）
 * - 浏览器模式：fetch('/api/config') 获取 wsPort + transport
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

  getStatus(): ConnectionStatus {
    return this.status;
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
      // Electron 模式：preload 注入配置；浏览器模式：fetch /api/config
      const injected = window.__BACKEND_CONFIG__;
      if (injected) {
        this.serverConfig = injected;
      } else {
        const res = await fetch(httpUrl("/api/config"));
        if (!res.ok) {
          throw new Error(`获取 /api/config 失败: ${res.status}`);
        }
        this.serverConfig = (await res.json()) as ServerConfig;
      }
    }
    this.shouldReconnect = true;
    this.open();
  }

  private open(): void {
    if (!this.serverConfig) return;
    this.setStatus("connecting");
    // Electron（preload 注入 __BACKEND_CONFIG__）：直连 wsPort
    // dev:web（vite）：走同源 /ws（vite proxy 转 wsPort；跨机器访问只需暴露单端口 5173，无需开放 8182）
    // 生产（后端静态 serve）：直连 wsPort（8182 需对客户端开放）
    const socketScheme = window.location.protocol === "https:" ? "wss" : "ws";
    const baseUrl = window.__BACKEND_CONFIG__
      ? `ws://localhost:${this.serverConfig.wsPort}`
      : import.meta.env.DEV
        ? `${socketScheme}://${window.location.host}/ws`
        : `${socketScheme}://${window.location.hostname}:${this.serverConfig.wsPort}`;
    const url = this.serverConfig.sessionToken
      ? `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}token=${encodeURIComponent(this.serverConfig.sessionToken)}`
      : baseUrl;
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => this.setStatus("connected");
    ws.onclose = () => {
      this.setStatus("disconnected");
      this.rejectAll(new Error("连接关闭"));
      if (this.shouldReconnect) {
        this.reconnectTimer = setTimeout(() => this.open(), RECONNECT_DELAY);
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
    if (kind === "response") {
      const response = msg as RpcResponse;
      const pending = this.pending.get(response.requestId);
      if (pending) {
        this.pending.delete(response.requestId);
        pending.resolve(response);
      }
    } else if (kind === "chunk") {
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
      this.pending.set(id, { resolve, reject });
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
      this.pending.set(requestId, { resolve, reject });
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
    this.status = status;
    this.statusHandlers.forEach((h) => h(status));
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export const wsClient = new WsClient();
