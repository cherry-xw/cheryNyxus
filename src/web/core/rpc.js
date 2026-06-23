/**
 * RPC 封装：Request/Response 关联 + 流式请求 + 超时。
 *
 * 传输层中枢：
 *   - request() → Promise<Response>（带超时）
 *   - stream()  → requestId（chat.send/resume 流式，chunk 经 onChunk 回调流入 store）
 *   - 监听连接 message：response 自行 resolve pending；chunk/notification 转发回调
 *
 * 不直接碰 store——通过 onChunk/onNotification/onSend/onRecv 回调注入（actions 绑定）。
 */

import { uuid } from "./uuid.js";

export function createRpc(conn, { onChunk, onNotification, onSend, onRecv } = {}) {
  const pending = new Map(); // requestId → { resolve, reject, method, timer }

  conn.on("message", (msg) => {
    if (!msg) return;
    onRecv?.(msg);

    if (msg.kind === "response") {
      const entry = pending.get(msg.requestId);
      if (entry) {
        pending.delete(msg.requestId);
        if (entry.timer) clearTimeout(entry.timer);
        if (msg.success) entry.resolve(msg);
        else entry.reject(makeErr(msg));
      }
      return;
    }
    if (msg.kind === "chunk") return onChunk?.(msg);
    if (msg.kind === "notification") return onNotification?.(msg);
  });

  function emitSend(msg) {
    onSend?.(msg);
    conn.send(JSON.stringify(msg));
  }

  /** 普通请求：等 Response，带超时 */
  function request(method, params, { timeout = 30000 } = {}) {
    return new Promise((resolve, reject) => {
      const id = uuid();
      const entry = { resolve, reject, method, timer: null };
      if (timeout > 0) {
        entry.timer = setTimeout(() => {
          if (pending.delete(id)) reject(new Error(`RPC timeout: ${method}`));
        }, timeout);
      }
      pending.set(id, entry);
      emitSend({ id, kind: "request", method, params });
    });
  }

  /** 流式请求（chat.send/resume）：send 后不 await，返回 requestId 供 chunk 路由 */
  function stream(method, params) {
    const id = uuid();
    emitSend({ id, kind: "request", method, params });
    return id;
  }

  /** 清空所有 pending（连接关闭时调用） */
  function clear(reason = "connection closed") {
    for (const entry of pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    pending.clear();
  }

  return {
    request,
    stream,
    clear,
    get pendingCount() { return pending.size; },
  };
}

function makeErr(res) {
  const e = new Error(res.error?.message || "RPC failed");
  e.code = res.error?.code;
  e.response = res;
  return e;
}
