/**
 * 前端传输层 —— 镜像后端 src/service/websocket/transport.ts 编解码。
 *
 * 协议（docs/protocol.md）：
 * - Request/Response：纯 JSON 字符串
 * - Chunk/Notification：
 *   - binary 模式：stream chunk 二进制帧 0x01，staged/notification JSON 帧 0x02
 *   - json 模式：纯 JSON 字符串
 *
 * 二进制帧格式（与后端 transport.encodeStreamFrame 一致）：
 *   [0x01][seq:4 bytes BE][requestId_len:1 byte][requestId:n bytes][payload_json]
 *
 * JSON 帧格式：
 *   [0x02][full_json]
 */

const FRAME_TYPE = {
  CHUNK: 0x01,
  JSON: 0x02,
} as const;

function safeParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * 解码服务端消息（Chunk/Notification，可能为 Response 的 json 模式字符串）。
 */
export function decodeMessage(data: ArrayBuffer | string): unknown {
  if (typeof data === "string") {
    return safeParse(data, null);
  }

  const view = new Uint8Array(data);
  if (view.length === 0) return null;

  const frameType = view[0];
  if (frameType === FRAME_TYPE.CHUNK) {
    return decodeStreamFrame(data, view);
  }
  if (frameType === FRAME_TYPE.JSON) {
    const json = new TextDecoder().decode(view.slice(1));
    return safeParse(json, null);
  }
  // 兜底：整体当 JSON
  return safeParse(new TextDecoder().decode(view), null);
}

function decodeStreamFrame(buf: ArrayBuffer, view: Uint8Array): unknown {
  const dv = new DataView(buf);
  const seq = dv.getUint32(1, false); // BE
  const reqIdLen = view[5] ?? 0;
  const reqId = new TextDecoder().decode(view.slice(6, 6 + reqIdLen));
  const payloadJson = new TextDecoder().decode(view.slice(6 + reqIdLen));
  return {
    kind: "chunk" as const,
    type: "stream" as const,
    requestId: reqId,
    seq,
    data: safeParse(payloadJson, {}),
  };
}

/**
 * 编码 Request（C→S，纯 JSON 字符串）
 */
export function encodeRequest(req: unknown): string {
  return JSON.stringify(req);
}
