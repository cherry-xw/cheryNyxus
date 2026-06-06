import { describe, it, expect, beforeEach } from "vitest";
import { Transport } from "@/service/websocket/transport.js";
import {
  createChunk,
  createNotification,
} from "@/service/message/types.js";
import type { Chunk, Notification } from "@/service/message/types.js";

describe("Transport", () => {
  let transport: Transport;

  beforeEach(() => {
    transport = new Transport();
  });

  // --------------------------------------------------------------------------
  // parseMessage
  // --------------------------------------------------------------------------

  describe("parseMessage", () => {
    it("should parse JSON string", () => {
      const obj = { kind: "chunk", type: "stream", requestId: "test" };
      const result = transport.parseMessage(JSON.stringify(obj));

      expect(result).toEqual(obj);
    });

    it("should parse Buffer", () => {
      const obj = { kind: "notification", type: "done", requestId: "test" };
      const buf = Buffer.from(JSON.stringify(obj), "utf-8");
      const result = transport.parseMessage(buf);

      expect(result).toEqual(obj);
    });
  });

  // --------------------------------------------------------------------------
  // serializeMessage
  // --------------------------------------------------------------------------

  describe("serializeMessage", () => {
    it("should produce JSON string", () => {
      const msg = { kind: "chunk", requestId: "abc" };
      const result = transport.serializeMessage(msg);

      expect(result).toBe(JSON.stringify(msg));
      expect(JSON.parse(result)).toEqual(msg);
    });
  });

  // --------------------------------------------------------------------------
  // encode - binary mode (STREAM frame)
  // --------------------------------------------------------------------------

  describe("encode binary mode - chunk with seq", () => {
    beforeEach(() => {
      process.env.CHERY_TRANSPORT = "binary";
    });

    it("should produce Buffer starting with 0x01 for chunk with seq", () => {
      const chunk = createChunk("stream", "req-1", { content: "hello" }, 42);
      const result = transport.encode(chunk);

      expect(Buffer.isBuffer(result)).toBe(true);
      const buf = result as Buffer;
      expect(buf.readUInt8(0)).toBe(0x01);
    });

    it("should encode seq as 4-byte big-endian", () => {
      const chunk = createChunk("stream", "req-1", { content: "x" }, 256);
      const buf = transport.encode(chunk) as Buffer;

      // seq at offset 1, 4 bytes big-endian: 256 = 0x00000100
      expect(buf.readUInt32BE(1)).toBe(256);
    });

    it("should encode requestId and data correctly", () => {
      const chunk = createChunk("stream", "req-99", { content: "world" }, 1);
      const buf = transport.encode(chunk) as Buffer;

      const requestIdLen = buf.readUInt8(5);
      const requestId = buf.slice(6, 6 + requestIdLen).toString("utf-8");
      const data = buf.slice(6 + requestIdLen).toString("utf-8");

      expect(requestId).toBe("req-99");
      expect(data).toBe('{"content":"world"}');
    });
  });

  // --------------------------------------------------------------------------
  // encode - binary mode (JSON frame)
  // --------------------------------------------------------------------------

  describe("encode binary mode - notification", () => {
    beforeEach(() => {
      process.env.CHERY_TRANSPORT = "binary";
    });

    it("should produce Buffer starting with 0x02 for notification", () => {
      const notification = createNotification("done", "req-1", null);
      const result = transport.encode(notification);

      expect(Buffer.isBuffer(result)).toBe(true);
      const buf = result as Buffer;
      expect(buf.readUInt8(0)).toBe(0x02);
    });

    it("should encode notification as JSON after type byte", () => {
      const notification = createNotification("interrupt", "req-1", {
        approvalId: "approval-1",
        senseName: "bash",
        arguments: "{}",
        supervisionLevel: 1,
      });
      const buf = transport.encode(notification) as Buffer;

      const json = buf.slice(1).toString("utf-8");
      const parsed = JSON.parse(json);

      expect(parsed.kind).toBe("notification");
      expect(parsed.type).toBe("interrupt");
    });

    it("should produce JSON frame for chunk without seq", () => {
      const chunk = createChunk("stream", "req-1", { content: "no-seq" });
      // seq is undefined, so it falls through to JSON frame
      const buf = transport.encode(chunk) as Buffer;

      expect(buf.readUInt8(0)).toBe(0x02);
    });
  });

  // --------------------------------------------------------------------------
  // encode - json mode
  // --------------------------------------------------------------------------

  describe("encode json mode", () => {
    beforeEach(() => {
      process.env.CHERY_TRANSPORT = "json";
    });

    it("should return JSON string", () => {
      const chunk = createChunk("stream", "req-1", { content: "hi" }, 1);
      const result = transport.encode(chunk);

      expect(typeof result).toBe("string");
      const parsed = JSON.parse(result as string);
      expect(parsed.kind).toBe("chunk");
      expect(parsed.type).toBe("stream");
    });
  });

  // --------------------------------------------------------------------------
  // encode/decode round-trip - chunk with seq
  // --------------------------------------------------------------------------

  describe("round-trip chunk with seq", () => {
    beforeEach(() => {
      process.env.CHERY_TRANSPORT = "binary";
    });

    it("should preserve seq, requestId, and data after encode+decode", () => {
      const original = createChunk("stream", "req-rt", { content: "round trip" }, 100);
      const encoded = transport.encode(original);
      const decoded = transport.decode(encoded as Buffer) as Chunk;

      expect(decoded.kind).toBe("chunk");
      expect(decoded.seq).toBe(100);
      expect(decoded.requestId).toBe("req-rt");
      expect(decoded.data).toEqual({ content: "round trip" });
    });
  });

  // --------------------------------------------------------------------------
  // encode/decode round-trip - JSON frame
  // --------------------------------------------------------------------------

  describe("round-trip JSON-frame notification", () => {
    beforeEach(() => {
      process.env.CHERY_TRANSPORT = "binary";
    });

    it("should preserve notification fields after encode+decode", () => {
      const original = createNotification("done", "req-done", null);
      const encoded = transport.encode(original);
      const decoded = transport.decode(encoded as Buffer) as Notification;

      expect(decoded.kind).toBe("notification");
      expect(decoded.type).toBe("done");
      expect(decoded.requestId).toBe("req-done");
      expect(decoded.data).toBeNull();
    });

    it("should preserve interrupt notification data after encode+decode", () => {
      const original = createNotification("interrupt", "req-int", {
        approvalId: "approval-42",
        senseName: "read_file",
        arguments: '{"path":"/test"}',
        supervisionLevel: 2,
      });
      const encoded = transport.encode(original);
      const decoded = transport.decode(encoded as Buffer) as Notification;

      expect(decoded.kind).toBe("notification");
      expect(decoded.type).toBe("interrupt");
      expect(decoded.requestId).toBe("req-int");
      expect(decoded.data).toEqual({
        approvalId: "approval-42",
        senseName: "read_file",
        arguments: '{"path":"/test"}',
        supervisionLevel: 2,
      });
    });
  });
});