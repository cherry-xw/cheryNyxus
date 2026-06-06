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
  ErrorCode,
  Method,
} from "@/service/message/types.js";
import type { Request, Response, Chunk, Notification } from "@/service/message/types.js";

// ============================================================================
// Factory functions
// ============================================================================

describe("createRequest", () => {
  it("should create request with all required fields", () => {
    const req = createRequest("soul.create", { brain: "test" });

    expect(req.kind).toBe("request");
    expect(req.method).toBe("soul.create");
    expect(req.params).toEqual({ brain: "test" });
    expect(req.id).toBeDefined();
    expect(typeof req.id).toBe("string");
  });
});

describe("createResponse", () => {
  it("should create success response with data", () => {
    const resp = createResponse("req-123", true, { soulId: "test-soul" } as any);

    expect(resp.kind).toBe("response");
    expect(resp.requestId).toBe("req-123");
    expect(resp.success).toBe(true);
    expect(resp.data).toEqual({ soulId: "test-soul" });
    expect(resp.error).toBeUndefined();
    expect(resp.id).toBeDefined();
  });

  it("should create error response", () => {
    const err = createError("INTERNAL", "boom");
    const resp = createResponse("req-456", false, undefined, err);

    expect(resp.success).toBe(false);
    expect(resp.data).toBeUndefined();
    expect(resp.error).toEqual(err);
  });
});

describe("createError", () => {
  it("should create error with code and message", () => {
    const err = createError("TIMEOUT", "request timed out");

    expect(err.code).toBe("TIMEOUT");
    expect(err.message).toBe("request timed out");
  });
});

describe("createChunk", () => {
  it("should create chunk with all fields", () => {
    const chunk = createChunk("stream", "req-1", { content: "hello" }, 5);

    expect(chunk.kind).toBe("chunk");
    expect(chunk.type).toBe("stream");
    expect(chunk.data).toEqual({ content: "hello" });
    expect(chunk.requestId).toBe("req-1");
    expect(chunk.seq).toBe(5);
  });

  it("should create chunk without seq", () => {
    const chunk = createChunk("staged", "req-1", { type: "content_end", content: "done" });

    expect(chunk.seq).toBeUndefined();
  });
});

describe("createNotification", () => {
  it("should create notification with all fields", () => {
    const notification = createNotification("interrupt", "req-1", {
      approvalId: "approval-1",
      senseName: "bash",
      arguments: "{}",
      supervisionLevel: 1,
    });

    expect(notification.kind).toBe("notification");
    expect(notification.type).toBe("interrupt");
    expect(notification.requestId).toBe("req-1");
    expect(notification.data).toEqual({
      approvalId: "approval-1",
      senseName: "bash",
      arguments: "{}",
      supervisionLevel: 1,
    });
  });

  it("should create notification with null data", () => {
    const notification = createNotification("done", "req-1", null);

    expect(notification.data).toBeNull();
  });
});

// ============================================================================
// Type guards
// ============================================================================

describe("isRequest", () => {
  it("should return true for Request", () => {
    const req = createRequest("test", { brain: "test" } as any);
    expect(isRequest(req)).toBe(true);
  });

  it("should return false for null", () => {
    expect(isRequest(null)).toBe(false);
  });

  it("should return false for wrong kind", () => {
    const resp = createResponse("r-1", true);
    expect(isRequest(resp)).toBe(false);
  });

  it("should return false for non-object", () => {
    expect(isRequest("string")).toBe(false);
    expect(isRequest(42)).toBe(false);
    expect(isRequest(undefined)).toBe(false);
  });
});

describe("isResponse", () => {
  it("should return true for Response", () => {
    const resp = createResponse("r-1", true);
    expect(isResponse(resp)).toBe(true);
  });

  it("should return false for null", () => {
    expect(isResponse(null)).toBe(false);
  });

  it("should return false for wrong kind", () => {
    const req = createRequest("test", { brain: "test" } as any);
    expect(isResponse(req)).toBe(false);
  });

  it("should return false for non-object", () => {
    expect(isResponse("string")).toBe(false);
  });
});

describe("isChunk", () => {
  it("should return true for Chunk", () => {
    const chunk = createChunk("stream", "req-1", { content: "test" });
    expect(isChunk(chunk)).toBe(true);
  });

  it("should return false for null", () => {
    expect(isChunk(null)).toBe(false);
  });

  it("should return false for wrong kind", () => {
    const notification = createNotification("done", "req-1", null);
    expect(isChunk(notification)).toBe(false);
  });

  it("should return false for non-object", () => {
    expect(isChunk(123)).toBe(false);
  });
});

describe("isNotification", () => {
  it("should return true for Notification", () => {
    const notification = createNotification("done", "req-1", null);
    expect(isNotification(notification)).toBe(true);
  });

  it("should return false for null", () => {
    expect(isNotification(null)).toBe(false);
  });

  it("should return false for wrong kind", () => {
    const chunk = createChunk("stream", "req-1", { content: "test" });
    expect(isNotification(chunk)).toBe(false);
  });

  it("should return false for non-object", () => {
    expect(isNotification(undefined)).toBe(false);
  });
});

// ============================================================================
// Constants
// ============================================================================

describe("ErrorCode", () => {
  it("should have error codes", () => {
    expect(ErrorCode.INVALID_PARAMS).toBe("INVALID_PARAMS");
    expect(ErrorCode.NOT_FOUND).toBe("NOT_FOUND");
    expect(ErrorCode.METHOD_NOT_FOUND).toBe("METHOD_NOT_FOUND");
    expect(ErrorCode.INTERNAL).toBe("INTERNAL");
    expect(ErrorCode.TIMEOUT).toBe("TIMEOUT");
  });
});

describe("Method", () => {
  it("should have soul methods", () => {
    expect(Method.SOUL_CREATE).toBe("soul.create");
    expect(Method.SOUL_DELETE).toBe("soul.delete");
    expect(Method.SOUL_LIST).toBe("soul.list");
    expect(Method.SOUL_LOAD).toBe("soul.load");
  });

  it("should have chat methods", () => {
    expect(Method.CHAT_LIST).toBe("chat.list");
    expect(Method.CHAT_GET).toBe("chat.get");
    expect(Method.CHAT_DELETE).toBe("chat.delete");
    expect(Method.CHAT_SEND).toBe("chat.send");
  });

  it("should have sense/approval methods", () => {
    expect(Method.SENSE_APPROVAL).toBe("sense.approval");
    expect(Method.SENSE_COMPILE).toBe("sense.compile");
    expect(Method.SENSE_LIST).toBe("sense.list");
  });
});