import { describe, it, expect, beforeEach } from "vitest";
import { Transport } from "@/service/websocket/transport.js";
import {
  createRpcEvent,
  createRpcTool,
  EventType,
} from "@/service/message/types.js";
import type { RpcEvent, RpcTool } from "@/service/message/types.js";

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
      const obj = { kind: "request", method: "test" };
      const result = transport.parseMessage(JSON.stringify(obj));

      expect(result).toEqual(obj);
    });

    it("should parse Buffer", () => {
      const obj = { kind: "response", success: true };
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
      const msg = { kind: "request", id: "abc" };
      const result = transport.serializeMessage(msg);

      expect(result).toBe(JSON.stringify(msg));
      expect(JSON.parse(result)).toEqual(msg);
    });
  });

  // --------------------------------------------------------------------------
  // encode - binary mode (STREAM frame)
  // --------------------------------------------------------------------------

  describe("encode binary mode - STREAM event", () => {
    beforeEach(() => {
      process.env.CHERY_TRANSPORT = "binary";
    });

    it("should produce Buffer starting with 0x01 for STREAM event with seq", () => {
      const evt = createRpcEvent(EventType.STREAM, { delta: "hello" }, "req-1", 42);
      const result = transport.encode(evt);

      expect(Buffer.isBuffer(result)).toBe(true);
      const buf = result as Buffer;
      expect(buf.readUInt8(0)).toBe(0x01);
    });

    it("should encode seq as 4-byte big-endian", () => {
      const evt = createRpcEvent(EventType.STREAM, { delta: "x" }, "req-1", 256);
      const buf = transport.encode(evt) as Buffer;

      // seq at offset 1, 4 bytes big-endian: 256 = 0x00000100
      expect(buf.readUInt32BE(1)).toBe(256);
    });

    it("should encode requestId and delta correctly", () => {
      const evt = createRpcEvent(EventType.STREAM, { delta: "world" }, "req-99", 1);
      const buf = transport.encode(evt) as Buffer;

      const requestIdLen = buf.readUInt8(5);
      const requestId = buf.slice(6, 6 + requestIdLen).toString("utf-8");
      const delta = buf.slice(6 + requestIdLen).toString("utf-8");

      expect(requestId).toBe("req-99");
      expect(delta).toBe('{"delta":"world"}');
    });

    it("should handle string data directly as delta", () => {
      // data is { delta: "hello" }, which is an object -> JSON.stringify
      const evt = createRpcEvent(EventType.STREAM, "raw text", "req-1", 0);
      const buf = transport.encode(evt) as Buffer;

      const requestIdLen = buf.readUInt8(5);
      const delta = buf.slice(6 + requestIdLen).toString("utf-8");

      expect(delta).toBe("raw text");
    });
  });

  // --------------------------------------------------------------------------
  // encode - binary mode (JSON frame)
  // --------------------------------------------------------------------------

  describe("encode binary mode - non-STREAM event", () => {
    beforeEach(() => {
      process.env.CHERY_TRANSPORT = "binary";
    });

    it("should produce Buffer starting with 0x02 for non-STREAM event", () => {
      const evt = createRpcEvent(EventType.DONE, null, "req-1");
      const result = transport.encode(evt);

      expect(Buffer.isBuffer(result)).toBe(true);
      const buf = result as Buffer;
      expect(buf.readUInt8(0)).toBe(0x02);
    });

    it("should encode event as JSON after type byte", () => {
      const evt = createRpcEvent(EventType.INTERRUPT, { handles: [] }, "req-1");
      const buf = transport.encode(evt) as Buffer;

      const json = buf.slice(1).toString("utf-8");
      const parsed = JSON.parse(json);

      expect(parsed.kind).toBe("event");
      expect(parsed.event).toBe(EventType.INTERRUPT);
    });

    it("should produce JSON frame for RpcTool", () => {
      const tool = createRpcTool("req-1", "trigger", { handleId: "h-1", toolName: "bash" });
      const buf = transport.encode(tool) as Buffer;

      expect(buf.readUInt8(0)).toBe(0x02);
      const json = buf.slice(1).toString("utf-8");
      const parsed = JSON.parse(json);

      expect(parsed.kind).toBe("tool");
      expect(parsed.state).toBe("trigger");
    });

    it("should produce JSON frame for STREAM event without seq", () => {
      const evt = createRpcEvent(EventType.STREAM, { delta: "no-seq" }, "req-1");
      // seq is undefined, so it falls through to JSON frame
      const buf = transport.encode(evt) as Buffer;

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
      const evt = createRpcEvent(EventType.STREAM, { delta: "hi" }, "req-1", 1);
      const result = transport.encode(evt);

      expect(typeof result).toBe("string");
      const parsed = JSON.parse(result as string);
      expect(parsed.kind).toBe("event");
      expect(parsed.event).toBe(EventType.STREAM);
    });
  });

  // --------------------------------------------------------------------------
  // encode/decode round-trip - STREAM
  // --------------------------------------------------------------------------

  describe("round-trip STREAM event", () => {
    beforeEach(() => {
      process.env.CHERY_TRANSPORT = "binary";
    });

    it("should preserve seq, requestId, and delta after encode+decode", () => {
      // encodeStreamFrame: data is stringified if not string → delta = JSON.stringify(data)
      // decodeStreamFrame: delta is read as raw string → data = { delta: <stringified data> }
      const original = createRpcEvent(EventType.STREAM, { delta: "round trip" }, "req-rt", 100);
      const encoded = transport.encode(original);
      const decoded = transport.decode(encoded as Buffer) as RpcEvent;

      expect(decoded.event).toBe(EventType.STREAM);
      expect(decoded.seq).toBe(100);
      expect(decoded.requestId).toBe("req-rt");
      // delta in data gets double-stringified: { delta: "round trip" } → '{"delta":"round trip"}'
      expect(decoded.data).toEqual({ delta: '{"delta":"round trip"}' });
    });
  });

  // --------------------------------------------------------------------------
  // encode/decode round-trip - JSON frame
  // --------------------------------------------------------------------------

  describe("round-trip JSON-frame event", () => {
    beforeEach(() => {
      process.env.CHERY_TRANSPORT = "binary";
    });

    it("should preserve event fields after encode+decode", () => {
      const original = createRpcEvent(EventType.DONE, { reason: "complete" }, "req-done");
      const encoded = transport.encode(original);
      const decoded = transport.decode(encoded as Buffer) as RpcEvent;

      expect(decoded.kind).toBe("event");
      expect(decoded.event).toBe(EventType.DONE);
      expect(decoded.requestId).toBe("req-done");
      expect(decoded.data).toEqual({ reason: "complete" });
    });

    it("should preserve RpcTool fields after encode+decode", () => {
      const original = createRpcTool("req-tool", "complete", {
        handleId: "h-42",
        toolName: "read_file",
        result: "file contents",
      });
      const encoded = transport.encode(original);
      const decoded = transport.decode(encoded as Buffer) as RpcTool;

      expect(decoded.kind).toBe("tool");
      expect(decoded.requestId).toBe("req-tool");
      expect(decoded.state).toBe("complete");
      expect(decoded.data.handleId).toBe("h-42");
      expect(decoded.data.toolName).toBe("read_file");
    });
  });
});
