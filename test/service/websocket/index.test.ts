import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocket } from "ws";
import { createWebSocketServer } from "@/service/websocket/index.js";
import { createRouter } from "@/service/message/router.js";
import {
  createRequest,
  createChunk,
  createNotification,
  type Chunk,
  type Notification,
  type Response,
} from "@/service/message/types.js";

let wss: ReturnType<typeof createWebSocketServer>;
let port: number;

/**
 * 缓冲式 ws 客户端：消息进队列，recv 顺序消费。
 * 避免 ws.once("message") 在 streaming 快速连发时丢失无 listener 期间到达的消息。
 */
class TestClient {
  private ws: WebSocket;
  private queue: unknown[] = [];
  private waiters: Array<(m: unknown) => void> = [];

  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
    this.ws.on("message", (d) => {
      const msg = JSON.parse(d.toString());
      const waiter = this.waiters.shift();
      if (waiter) waiter(msg);
      else this.queue.push(msg);
    });
  }

  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) return resolve();
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
    });
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  recv(timeoutMs = 3000): Promise<unknown> {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("recv timeout")), timeoutMs);
      this.waiters.push((m) => {
        clearTimeout(timer);
        resolve(m);
      });
    });
  }

  close(): void {
    this.ws.close();
  }
}

describe("service/websocket/index createWebSocketServer", () => {
  beforeEach(() => {
    // json 模式简化客户端解码（server encode 全 JSON string）
    process.env.CHERY_TRANSPORT = "json";
    const router = createRouter();
    router.register("echo", async (_c, data) => ({ ok: true, echo: data }));
    router.register(
      "stream",
      async function* (c): AsyncGenerator<Chunk | Notification, { done: true }> {
        yield createChunk("stream", c.requestId!, { content: "a" });
        yield createNotification("done", c.requestId!, null);
        return { done: true };
      },
    );
    wss = createWebSocketServer({ port: 0, router });
    port = (wss.address() as { port: number }).port;
  });

  afterEach(async () => {
    process.env.CHERY_TRANSPORT = "binary";
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  it("handles a normal request and returns success response", async () => {
    const client = new TestClient(port);
    await client.opened();
    const req = createRequest("echo", { x: 1 } as never);
    client.send(req);
    const res = (await client.recv()) as Response;
    expect(res.kind).toBe("response");
    expect(res.success).toBe(true);
    expect(res.requestId).toBe(req.id);
    expect(res.data).toEqual({ ok: true, echo: { x: 1 } });
    client.close();
  });

  it("returns METHOD_NOT_FOUND for unregistered method", async () => {
    const client = new TestClient(port);
    await client.opened();
    const req = createRequest("nope.method", {} as never);
    client.send(req);
    const res = (await client.recv()) as Response;
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe("METHOD_NOT_FOUND");
    client.close();
  });

  it("streams chunks then final response for generator handler", async () => {
    const client = new TestClient(port);
    await client.opened();
    const req = createRequest("stream", {} as never);
    client.send(req);
    const chunk = (await client.recv()) as Chunk;
    const notif = (await client.recv()) as Notification;
    const res = (await client.recv()) as Response;
    expect(chunk.kind).toBe("chunk");
    expect(notif.kind).toBe("notification");
    expect(notif.type).toBe("done");
    expect(res.kind).toBe("response");
    expect(res.success).toBe(true);
    client.close();
  });
});
