import { describe, it, expect } from "vitest";
import {
  createRequest,
  createResponse,
  createChunk,
  createNotification,
  createError,
  isRequest,
  isResponse,
  isChunk,
  isNotification,
  Method,
  ErrorCode,
} from "@/service/message/types.js";

describe("service/message/types", () => {
  describe("factories", () => {
    it("createRequest builds a request with uuid id", () => {
      const req = createRequest("chat.send", { chatId: "c1", prompt: "hi" });
      expect(req.kind).toBe("request");
      expect(req.method).toBe("chat.send");
      expect(req.params).toEqual({ chatId: "c1", prompt: "hi" });
      expect(typeof req.id).toBe("string");
      expect(req.id.length).toBeGreaterThan(0);
    });

    it("createResponse echoes requestId and carries data on success", () => {
      const res = createResponse("req-1", true, { chatId: "c1" });
      expect(res.kind).toBe("response");
      expect(res.requestId).toBe("req-1");
      expect(res.success).toBe(true);
      expect(res.data).toEqual({ chatId: "c1" });
      expect(res.error).toBeUndefined();
    });

    it("createResponse carries error on failure", () => {
      const res = createResponse("req-1", false, undefined, createError(ErrorCode.INTERNAL, "boom"));
      expect(res.success).toBe(false);
      expect(res.error).toEqual({ code: "INTERNAL", message: "boom" });
    });

    it("createChunk builds stream/staged chunk with optional seq", () => {
      const c1 = createChunk("stream", "req-1", { content: "a" }, 5);
      expect(c1.kind).toBe("chunk");
      expect(c1.type).toBe("stream");
      expect(c1.seq).toBe(5);

      const c2 = createChunk("staged", "req-1", { type: "content_end" });
      expect(c2.seq).toBeUndefined();
    });

    it("createNotification builds a notification", () => {
      const n = createNotification("done", "req-1", null);
      expect(n.kind).toBe("notification");
      expect(n.type).toBe("done");
      expect(n.data).toBeNull();
    });

    it("createError builds an rpc error", () => {
      expect(createError("CODE", "msg")).toEqual({ code: "CODE", message: "msg" });
    });
  });

  describe("type guards", () => {
    it("isRequest matches only request kind", () => {
      expect(isRequest({ kind: "request" })).toBe(true);
      expect(isRequest({ kind: "response" })).toBe(false);
      expect(isRequest(null)).toBe(false);
      expect(isRequest({})).toBe(false);
    });

    it("isResponse matches only response kind", () => {
      expect(isResponse({ kind: "response" })).toBe(true);
      expect(isResponse({ kind: "request" })).toBe(false);
    });

    it("isChunk matches only chunk kind", () => {
      expect(isChunk({ kind: "chunk" })).toBe(true);
      expect(isChunk({ kind: "notification" })).toBe(false);
    });

    it("isNotification matches only notification kind", () => {
      expect(isNotification({ kind: "notification" })).toBe(true);
      expect(isNotification({ kind: "chunk" })).toBe(false);
    });
  });

  describe("Method constants", () => {
    it("exposes expected method strings", () => {
      expect(Method.BRAIN_LIST).toBe("brain.list");
      expect(Method.SENSE_LIST).toBe("sense.list");
      expect(Method.RUNTIME_SET).toBe("runtime.set");
      expect(Method.CHAT_CREATE).toBe("chat.create");
      expect(Method.CHAT_LIST).toBe("chat.list");
      expect(Method.CHAT_GET).toBe("chat.get");
      expect(Method.CHAT_DELETE).toBe("chat.delete");
      expect(Method.CHAT_SEND).toBe("chat.send");
      expect(Method.CHAT_RESUME).toBe("chat.resume");
      expect(Method.SENSE_APPROVAL).toBe("sense.approval");
      expect(Method.CHAT_ABORT).toBe("chat.abort");
    });
  });

  describe("ErrorCode constants", () => {
    it("exposes expected error codes", () => {
      expect(ErrorCode.METHOD_NOT_FOUND).toBe("METHOD_NOT_FOUND");
      expect(ErrorCode.INTERNAL).toBe("INTERNAL");
      expect(ErrorCode.TIMEOUT).toBe("TIMEOUT");
    });
  });
});
