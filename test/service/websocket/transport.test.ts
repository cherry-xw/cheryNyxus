import { describe, it, expect, beforeEach } from "vitest";
import { Transport } from "@/service/websocket/transport.js";
import { createChunk, createNotification } from "@/service/message/types.js";

describe("service/websocket/Transport", () => {
  let transport: Transport;

  beforeEach(() => {
    transport = new Transport();
  });

  describe("parseMessage", () => {
    it("parses JSON string", () => {
      const obj = { kind: "request", id: "r1" };
      expect(transport.parseMessage(JSON.stringify(obj))).toEqual(obj);
    });

    it("parses Buffer", () => {
      const obj = { kind: "response", id: "r1" };
      const buf = Buffer.from(JSON.stringify(obj), "utf-8");
      expect(transport.parseMessage(buf)).toEqual(obj);
    });

    it("returns empty object for invalid JSON (safeJsonParse fallback)", () => {
      expect(transport.parseMessage("not json")).toEqual({});
    });
  });

  describe("serializeMessage", () => {
    it("produces JSON string", () => {
      const msg = { kind: "response", id: "x" };
      expect(transport.serializeMessage(msg)).toBe(JSON.stringify(msg));
    });
  });

  describe("encode - json mode", () => {
    beforeEach(() => {
      process.env.CHERY_TRANSPORT = "json";
    });

    it("returns JSON string for any message", () => {
      const chunk = createChunk("stream", "req-1", { content: "hi" }, 1);
      const result = transport.encode(chunk);
      expect(typeof result).toBe("string");
      expect(JSON.parse(result as string).kind).toBe("chunk");
    });
  });

  describe("encode - binary mode", () => {
    beforeEach(() => {
      process.env.CHERY_TRANSPORT = "binary";
    });

    it("encodes stream chunk with seq as binary CHUNK frame (0x01)", () => {
      const chunk = createChunk("stream", "req-1", { content: "hello" }, 42);
      const buf = transport.encode(chunk) as Buffer;
      expect(Buffer.isBuffer(buf)).toBe(true);
      expect(buf.readUInt8(0)).toBe(0x01);
      expect(buf.readUInt32BE(1)).toBe(42); // seq big-endian
    });

    it("encodes requestId + data after header in CHUNK frame", () => {
      const chunk = createChunk("stream", "req-99", { content: "world" }, 1);
      const buf = transport.encode(chunk) as Buffer;
      const requestIdLen = buf.readUInt8(5);
      const requestId = buf.slice(6, 6 + requestIdLen).toString("utf-8");
      const data = buf.slice(6 + requestIdLen).toString("utf-8");
      expect(requestId).toBe("req-99");
      expect(data).toBe('{"content":"world"}');
    });

    it("encodes notification as JSON frame (0x02)", () => {
      const n = createNotification("done", "req-1", null);
      const buf = transport.encode(n) as Buffer;
      expect(buf.readUInt8(0)).toBe(0x02);
      const parsed = JSON.parse(buf.slice(1).toString("utf-8"));
      expect(parsed.kind).toBe("notification");
      expect(parsed.type).toBe("done");
    });

    it("encodes staged chunk (no seq) as JSON frame (0x02)", () => {
      const chunk = createChunk("staged", "req-1", { type: "content_end" });
      const buf = transport.encode(chunk) as Buffer;
      expect(buf.readUInt8(0)).toBe(0x02);
    });

    it("encodes stream chunk without seq as JSON frame (0x02)", () => {
      const chunk = createChunk("stream", "req-1", { content: "x" });
      const buf = transport.encode(chunk) as Buffer;
      expect(buf.readUInt8(0)).toBe(0x02);
    });
  });
});
