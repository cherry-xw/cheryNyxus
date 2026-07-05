import { encodeRequest, decodeMessage } from "./transport";

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
        const res = await fetch("/api/config");
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
    const url = `ws://${window.location.hostname}:${this.serverConfig.wsPort}`;
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
    const id = crypto.randomUUID();
    const request = { id, kind: "request" as const, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws!.send(encodeRequest(request));
    });
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
