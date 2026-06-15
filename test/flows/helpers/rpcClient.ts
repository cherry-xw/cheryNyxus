/**
 * 集成测试 RPC 客户端：连接 WS 服务，解析二进制帧，按 requestId 路由流式消息。
 *
 * 二进制帧协议（见 docs/websocket.md）：
 * - 纯 JSON 字符串（无前缀）→ Response（Request/Response 不走帧编码）
 * - [0x01][seq:4][ridLen:1][rid][json] → stream chunk
 * - [0x02][json] → staged chunk / notification
 *
 * Flow 模型：beginStream 返回 controller，events 为独立引用（response 到达后仍可查），
 * waitFor 先查已收集事件，避免快流程（auto）的竞态。
 */
import WebSocket from "ws";
import { randomUUID } from "crypto";
import type {
  Response as RpcResponse,
  Chunk,
  Notification,
} from "@/service/message/types.js";

export type S2CEvent = Chunk | Notification;

interface FlowState {
  events: S2CEvent[];
  waiters: Array<{ predicate: (e: S2CEvent) => boolean; resolve: (e: S2CEvent) => void }>;
  done: boolean;
  resolveResponse: (r: RpcResponse) => void;
}

export interface StreamFlow {
  /** 已收集事件（实时追加，response 后仍有效） */
  events: S2CEvent[];
  /** 等待首个满足谓词的事件 */
  waitFor(predicate: (e: S2CEvent) => boolean, timeoutMs?: number): Promise<S2CEvent>;
  /** 等待最终 Response */
  done(): Promise<{ response: RpcResponse; events: S2CEvent[] }>;
}

export class FlowRpcClient {
  private ws: WebSocket;
  private pending = new Map<string, FlowState>();
  private openPromise: Promise<void>;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.openPromise = new Promise((resolve, reject) => {
      this.ws.on("open", () => resolve());
      this.ws.on("error", (err) => reject(err));
    });
    this.ws.on("message", (data) => this.handleRaw(data));
  }

  async connect(): Promise<void> {
    await this.openPromise;
  }

  /**
   * 请求 id：chat.* 方法 server 端 staged/loaded 用 chatId 作为 requestId
   * （见 handler.ts handleChatGet），故含 chatId 的请求用 chatId 作为 id 以匹配。
   * 其余（sense.approval 等）用 randomUUID。
   */
  private makeRequestId(params: unknown): string {
    if (params && typeof params === "object" && "chatId" in params) {
      return (params as { chatId: string }).chatId;
    }
    return randomUUID();
  }

  /** 发起流式请求（chat.send / chat.resume / chat.get） */
  beginStream(method: string, params: unknown, idOverride?: string): StreamFlow {
    const id = idOverride ?? this.makeRequestId(params);
    const state: FlowState = {
      events: [],
      waiters: [],
      done: false,
      resolveResponse: () => {},
    };
    const responsePromise = new Promise<{ response: RpcResponse; events: S2CEvent[] }>((resolve) => {
      state.resolveResponse = (response) => {
        state.done = true;
        resolve({ response, events: state.events });
      };
    });
    this.pending.set(id, state);
    this.ws.send(JSON.stringify({ id, kind: "request", method, params }));

    return {
      events: state.events,
      waitFor: (predicate, timeoutMs = 5000) => this.waitFor(state, predicate, timeoutMs),
      done: () => responsePromise,
    };
  }

  /** 非流式请求（sense.approval / chat.create / brain.list 等）。
   *  idOverride：含 chatId 的并发请求（如运行中第二条 chat.send）需用 UUID，
   *  避免与已 beginStream 的流式 flow（id=chatId）pending state 冲突。 */
  async call(method: string, params: unknown, idOverride?: string): Promise<RpcResponse> {
    const id = idOverride ?? this.makeRequestId(params);
    const state: FlowState = {
      events: [],
      waiters: [],
      done: false,
      resolveResponse: () => {},
    };
    const responsePromise = new Promise<RpcResponse>((resolve) => {
      state.resolveResponse = (response) => {
        state.done = true;
        resolve(response);
      };
    });
    this.pending.set(id, state);
    this.ws.send(JSON.stringify({ id, kind: "request", method, params }));
    return responsePromise;
  }

  /** 便捷：感官审批 */
  approval(
    approvalId: string,
    action: "accept" | "reject",
    reason?: string,
  ): Promise<RpcResponse> {
    const params: Record<string, unknown> = { approvalId, action };
    if (reason !== undefined) params.reason = reason;
    return this.call("sense.approval", params);
  }

  private waitFor(
    state: FlowState,
    predicate: (e: S2CEvent) => boolean,
    timeoutMs: number,
  ): Promise<S2CEvent> {
    // 先查已收集的（解决快流程竞态）
    const existing = state.events.find(predicate);
    if (existing) return Promise.resolve(existing);

    // 轮询：直接查 events，避免 waiter 注册/唤醒的时序竞态
    return new Promise<S2CEvent>((resolve, reject) => {
      const start = Date.now();
      const tick = (): void => {
        const found = state.events.find(predicate);
        if (found) {
          resolve(found);
          return;
        }
        if (state.done) {
          reject(new Error("Flow ended before event arrived"));
          return;
        }
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`waitFor timeout (${timeoutMs}ms)`));
          return;
        }
        setTimeout(tick, 5);
      };
      tick();
    });
  }

  private handleRaw(data: WebSocket.RawData): void {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    let msg: unknown;

    if (buf[0] === 0x01) {
      const seq = buf.readUInt32BE(1);
      const ridLen = buf.readUInt8(5);
      const requestId = buf.slice(6, 6 + ridLen).toString("utf-8");
      const chunkData = JSON.parse(buf.slice(6 + ridLen).toString("utf-8"));
      msg = { kind: "chunk", type: "stream", requestId, seq, data: chunkData } as Chunk;
    } else if (buf[0] === 0x02) {
      msg = JSON.parse(buf.slice(1).toString("utf-8"));
    } else {
      msg = JSON.parse(buf.toString("utf-8"));
    }

    this.dispatch(msg);
  }

  private dispatch(msg: unknown): void {
    const m = msg as { kind?: string; requestId?: string };
    const requestId = m.requestId ?? "";
    const state = requestId ? this.pending.get(requestId) : undefined;
    if (!state) return;

    if (m.kind === "response") {
      state.resolveResponse(msg as RpcResponse);
      this.pending.delete(requestId);
      return;
    }

    // chunk / notification
    const event = msg as S2CEvent;
    state.events.push(event);
    for (let i = 0; i < state.waiters.length; i++) {
      if (state.waiters[i]!.predicate(event)) {
        state.waiters.splice(i, 1);
        break;
      }
    }
  }

  close(): void {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close();
    }
  }
}
