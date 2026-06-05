import WebSocket from "ws";
import { randomUUID } from "crypto";

export interface RpcClientOptions {
  url: string;
  timeout?: number;
}

export class RpcClient {
  private ws!: WebSocket;
  private pendingRequests = new Map<string, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    events: any[];
    timeout?: NodeJS.Timeout;
  }>();
  private connectPromise!: Promise<void>;

  constructor(private options: RpcClientOptions) {}

  async connect(): Promise<void> {
    this.connectPromise = new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.options.url);

      this.ws.on("open", () => resolve());
      this.ws.on("error", (err) => reject(err));

      this.ws.on("message", (data) => {
        const raw = data instanceof Buffer ? data.toString("utf-8") : String(data);
        try {
          const msg = JSON.parse(raw);
          this.handleMessage(msg);
        } catch {
          // binary frame or non-JSON, ignore for now
        }
      });

      setTimeout(() => reject(new Error("Connection timeout")), this.options.timeout ?? 5000);
    });

    return this.connectPromise;
  }

  private handleMessage(msg: any): void {
    if (msg.kind === "response" && msg.requestId) {
      const pending = this.pendingRequests.get(msg.requestId);
      if (pending) {
        if (pending.timeout) clearTimeout(pending.timeout);
        pending.resolve({ response: msg, events: pending.events });
        this.pendingRequests.delete(msg.requestId);
      }
    } else if (msg.kind === "event" || msg.kind === "tool") {
      // Find the most recent pending request and add event
      for (const [, pending] of this.pendingRequests) {
        pending.events.push(msg);
        break;
      }
    }
  }

  async request(method: string, params: any, timeoutMs?: number): Promise<{ response: any; events: any[] }> {
    const id = randomUUID();
    const request = {
      id,
      kind: "request",
      method,
      params,
      timestamp: Date.now(),
      ...(timeoutMs ? { timeout: timeoutMs } : {}),
    };

    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, events: [] as any[], timeout: undefined as NodeJS.Timeout | undefined };
      this.pendingRequests.set(id, pending);

      if (timeoutMs) {
        pending.timeout = setTimeout(() => {
          this.pendingRequests.delete(id);
          reject(new Error(`Request timeout: ${method}`));
        }, timeoutMs);
      }

      this.ws.send(JSON.stringify(request));
    });
  }

  close(): void {
    if (this.ws) {
      this.ws.close();
    }
  }

  getWebSocket(): WebSocket {
    return this.ws;
  }
}
