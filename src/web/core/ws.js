/**
 * WebSocket 连接 + 二进制帧解码
 *
 * 逆向 src/service/websocket/transport.ts：
 *   - Request/Response = 纯 JSON 字符串帧 → JSON.parse
 *   - Chunk/Notification = 二进制帧（binaryType='arraybuffer'），首字节分流：
 *     0x01 CHUNK帧 [type:1][seq:4 BE][ridLen:1][rid][data json] → stream chunk
 *     0x02 JSON帧 [type:1][json] → staged chunk / notification
 *
 * 帧类型判定（transport.ts:39）：仅 stream chunk 且 seq≠undefined 用 0x01；
 * 其余 chunk（staged）和所有 notification 走 0x02 JSON 帧。
 */

const FRAME_CHUNK = 0x01;
const FRAME_JSON = 0x02;

/**
 * 解码一帧消息。string → Request/Response；ArrayBuffer → chunk/notification。
 * 解析失败返回 null。
 */
export function decodeFrame(data) {
  if (typeof data === "string") {
    try { return JSON.parse(data); } catch { return null; }
  }
  if (!(data instanceof ArrayBuffer)) return null; // binaryType=arraybuffer 保证非 string 即 ArrayBuffer

  const bytes = new Uint8Array(data);
  if (bytes.length === 0) return null;
  const type = bytes[0];
  const dec = new TextDecoder();

  if (type === FRAME_CHUNK) {
    const view = new DataView(data);
    const seq = view.getUint32(1); // BE
    const ridLen = bytes[5];
    const requestId = dec.decode(bytes.slice(6, 6 + ridLen));
    const jsonStr = dec.decode(bytes.slice(6 + ridLen));
    let parsed;
    try { parsed = JSON.parse(jsonStr); } catch { parsed = {}; }
    return { kind: "chunk", type: "stream", requestId, seq, data: parsed };
  }

  if (type === FRAME_JSON) {
    const jsonStr = dec.decode(bytes.slice(1));
    try { return JSON.parse(jsonStr); } catch { return null; }
  }

  return null;
}

/**
 * 建立 WS 连接。binaryType 强制 arraybuffer。
 * on(evt, cb)：open/close/error/message。message 回调收 decodeFrame 后的对象（可能 null）。
 */
export function createConnection(url) {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";

  const listeners = { open: [], close: [], error: [], message: [] };

  ws.addEventListener("open", (e) => emit("open", e));
  ws.addEventListener("close", (e) => emit("close", e));
  ws.addEventListener("error", (e) => emit("error", e));
  ws.addEventListener("message", (e) => {
    const msg = decodeFrame(e.data);
    emit("message", msg, e);
  });

  function emit(evt, ...args) {
    for (const cb of listeners[evt]) {
      try { cb(...args); } catch (err) { console.error("[ws] listener error", err); }
    }
  }

  return {
    ws,
    on(evt, cb) {
      (listeners[evt] ??= []).push(cb);
      return () => {
        listeners[evt] = (listeners[evt] || []).filter((x) => x !== cb);
      };
    },
    send(str) { ws.send(str); },
    close() { ws.close(); },
    get readyState() { return ws.readyState; },
  };
}
