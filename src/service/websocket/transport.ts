import type { Chunk, Notification } from "../message/types.js";
import { safeJsonParse } from "@/utils/json.js";

/**
 * 二进制帧类型
 */
const FRAME_TYPE = {
  CHUNK: 0x01,
  JSON: 0x02,
} as const;

/**
 * 传输层 - 编码/解码消息
 *
 * 通过 CHERY_TRANSPORT 环境变量控制编码模式：
 * - "binary"（默认）：Chunk/Notification 编码为二进制帧，低开销
 * - "json"：所有消息编码为 JSON 字符串，便于调试
 */
export class Transport {
  private _binary?: boolean;

  private get binary(): boolean {
    if (this._binary === undefined) {
      this._binary = (process.env.CHERY_TRANSPORT ?? "binary") === "binary";
    }
    return this._binary;
  }

  /**
   * 编码 Chunk 或 Notification
   * - binary 模式：二进制帧（Buffer）
   * - json 模式：JSON 字符串（string）
   */
  encode(msg: Chunk | Notification): Buffer | string {
    if (!this.binary) {
      return JSON.stringify(msg);
    }
    // stream chunk 使用二进制帧
    if (msg.kind === "chunk" && msg.type === "stream" && msg.seq !== undefined) {
      return this.encodeStreamFrame(msg as Chunk);
    }
    return this.encodeJsonFrame(msg);
  }

  /**
   * 编码流式二进制帧
   * 格式：[type:1byte][seq:4bytes][requestId_len:1byte][requestId:varies][data:varies]
   */
  private encodeStreamFrame(chunk: Chunk): Buffer {
    const data = typeof chunk.data === "string"
      ? chunk.data
      : JSON.stringify(chunk.data);

    const requestId = chunk.requestId || "";
    const requestIdBuffer = Buffer.from(requestId, "utf-8");
    const seq = chunk.seq ?? 0;

    // 头部：type(1) + seq(4) + requestId_len(1) + requestId
    const headerLength = 6 + requestIdBuffer.length;
    const header = Buffer.alloc(headerLength);

    header.writeUInt8(FRAME_TYPE.CHUNK, 0);
    header.writeUInt32BE(seq, 1);
    header.writeUInt8(requestIdBuffer.length, 5);
    requestIdBuffer.copy(header, 6);

    const payload = Buffer.from(data, "utf-8");
    return Buffer.concat([header, payload]);
  }

  /**
   * 编码 JSON 帧
   * 格式：[type:1byte][json:varies]
   */
  private encodeJsonFrame(msg: Chunk | Notification): Buffer {
    const json = JSON.stringify(msg);
    const jsonBuffer = Buffer.from(json, "utf-8");

    const header = Buffer.alloc(1);
    header.writeUInt8(FRAME_TYPE.JSON, 0);

    return Buffer.concat([header, jsonBuffer]);
  }

  /**
   * 解析原始消息（JSON格式，用于 Request/Response）
   */
  parseMessage(data: Buffer | string): unknown {
    const str = typeof data === "string" ? data : data.toString("utf-8");
    return safeJsonParse(str, {});
  }

  /**
   * 序列化消息（JSON格式，用于 Request/Response）
   */
  serializeMessage(msg: unknown): string {
    return JSON.stringify(msg);
  }
}

/**
 * 导出传输实例
 */
export const transport = new Transport();