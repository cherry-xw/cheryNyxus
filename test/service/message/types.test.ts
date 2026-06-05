import { describe, it, expect } from "vitest";
import {
  createRpcRequest,
  createRpcResponse,
  createRpcError,
  createRpcEvent,
  createRpcTool,
  isRpcRequest,
  isRpcResponse,
  isRpcEvent,
  isRpcTool,
  ErrorCode,
  Method,
  EventType,
} from "@/service/message/types.js";
import type { RpcRequest, RpcResponse, RpcEvent, RpcTool } from "@/service/message/types.js";

// ============================================================================
// Factory functions
// ============================================================================

describe("createRpcRequest", () => {
  it("should create request with all required fields", () => {
    const req = createRpcRequest("agent.create", { model: "test" });

    expect(req.kind).toBe("request");
    expect(req.method).toBe("agent.create");
    expect(req.params).toEqual({ model: "test" });
    expect(req.id).toBeDefined();
    expect(typeof req.id).toBe("string");
    expect(req.timestamp).toBeDefined();
    expect(typeof req.timestamp).toBe("number");
  });

  it("should include timeout when provided", () => {
    const req = createRpcRequest("agent.execute", {}, 5000);

    expect(req.timeout).toBe(5000);
  });

  it("should omit timeout when not provided", () => {
    const req = createRpcRequest("agent.execute", {});

    expect(req.timeout).toBeUndefined();
  });
});

describe("createRpcResponse", () => {
  it("should create success response with result", () => {
    const resp = createRpcResponse("req-123", true, { data: "ok" });

    expect(resp.kind).toBe("response");
    expect(resp.requestId).toBe("req-123");
    expect(resp.success).toBe(true);
    expect(resp.result).toEqual({ data: "ok" });
    expect(resp.error).toBeUndefined();
    expect(resp.id).toBeDefined();
    expect(resp.timestamp).toBeDefined();
  });

  it("should create error response", () => {
    const err = createRpcError("INTERNAL", "boom");
    const resp = createRpcResponse("req-456", false, undefined, err);

    expect(resp.success).toBe(false);
    expect(resp.result).toBeUndefined();
    expect(resp.error).toEqual(err);
  });
});

describe("createRpcError", () => {
  it("should create error with code and message", () => {
    const err = createRpcError("TIMEOUT", "request timed out");

    expect(err.code).toBe("TIMEOUT");
    expect(err.message).toBe("request timed out");
    expect(err.retryable).toBe(false);
  });

  it("should set retryable to true when specified", () => {
    const err = createRpcError("TIMEOUT", "request timed out", true);

    expect(err.retryable).toBe(true);
  });
});

describe("createRpcEvent", () => {
  it("should create event with all fields", () => {
    const evt = createRpcEvent("stream", { delta: "hello" }, "req-1", 5);

    expect(evt.kind).toBe("event");
    expect(evt.event).toBe("stream");
    expect(evt.data).toEqual({ delta: "hello" });
    expect(evt.requestId).toBe("req-1");
    expect(evt.seq).toBe(5);
    expect(evt.id).toBeDefined();
    expect(evt.timestamp).toBeDefined();
  });

  it("should create event without optional fields", () => {
    const evt = createRpcEvent("done", null);

    expect(evt.requestId).toBeUndefined();
    expect(evt.seq).toBeUndefined();
  });
});

describe("createRpcTool", () => {
  it("should create tool message with all fields", () => {
    const data = { handleId: "h-1", toolName: "bash" };
    const tool = createRpcTool("req-1", "trigger", data);

    expect(tool.kind).toBe("tool");
    expect(tool.requestId).toBe("req-1");
    expect(tool.state).toBe("trigger");
    expect(tool.data).toEqual(data);
    expect(tool.id).toBeDefined();
    expect(tool.timestamp).toBeDefined();
  });
});

// ============================================================================
// Type guards
// ============================================================================

describe("isRpcRequest", () => {
  it("should return true for RpcRequest", () => {
    const req = createRpcRequest("test", {});
    expect(isRpcRequest(req)).toBe(true);
  });

  it("should return false for null", () => {
    expect(isRpcRequest(null)).toBe(false);
  });

  it("should return false for wrong kind", () => {
    const resp = createRpcResponse("r-1", true);
    expect(isRpcRequest(resp)).toBe(false);
  });

  it("should return false for non-object", () => {
    expect(isRpcRequest("string")).toBe(false);
    expect(isRpcRequest(42)).toBe(false);
    expect(isRpcRequest(undefined)).toBe(false);
  });
});

describe("isRpcResponse", () => {
  it("should return true for RpcResponse", () => {
    const resp = createRpcResponse("r-1", true);
    expect(isRpcResponse(resp)).toBe(true);
  });

  it("should return false for null", () => {
    expect(isRpcResponse(null)).toBe(false);
  });

  it("should return false for wrong kind", () => {
    const req = createRpcRequest("test", {});
    expect(isRpcResponse(req)).toBe(false);
  });

  it("should return false for non-object", () => {
    expect(isRpcResponse("string")).toBe(false);
  });
});

describe("isRpcEvent", () => {
  it("should return true for RpcEvent", () => {
    const evt = createRpcEvent("stream", {});
    expect(isRpcEvent(evt)).toBe(true);
  });

  it("should return false for null", () => {
    expect(isRpcEvent(null)).toBe(false);
  });

  it("should return false for wrong kind", () => {
    const tool = createRpcTool("r-1", "trigger", { handleId: "h-1" });
    expect(isRpcEvent(tool)).toBe(false);
  });

  it("should return false for non-object", () => {
    expect(isRpcEvent(123)).toBe(false);
  });
});

describe("isRpcTool", () => {
  it("should return true for RpcTool", () => {
    const tool = createRpcTool("r-1", "complete", { handleId: "h-1" });
    expect(isRpcTool(tool)).toBe(true);
  });

  it("should return false for null", () => {
    expect(isRpcTool(null)).toBe(false);
  });

  it("should return false for wrong kind", () => {
    const evt = createRpcEvent("stream", {});
    expect(isRpcTool(evt)).toBe(false);
  });

  it("should return false for non-object", () => {
    expect(isRpcTool(undefined)).toBe(false);
  });
});

// ============================================================================
// Constants
// ============================================================================

describe("ErrorCode", () => {
  it("should have client error codes", () => {
    expect(ErrorCode.INVALID_PARAMS).toBe("INVALID_PARAMS");
    expect(ErrorCode.NOT_FOUND).toBe("NOT_FOUND");
    expect(ErrorCode.METHOD_NOT_FOUND).toBe("METHOD_NOT_FOUND");
    expect(ErrorCode.UNAUTHORIZED).toBe("UNAUTHORIZED");
    expect(ErrorCode.CANCELLED).toBe("CANCELLED");
    expect(ErrorCode.CONFIG_MISMATCH).toBe("CONFIG_MISMATCH");
  });

  it("should have server error codes", () => {
    expect(ErrorCode.INTERNAL).toBe("INTERNAL");
    expect(ErrorCode.TIMEOUT).toBe("TIMEOUT");
    expect(ErrorCode.CONNECTION_CLOSED).toBe("CONNECTION_CLOSED");
  });

  it("should have business error codes", () => {
    expect(ErrorCode.SESSION_NOT_FOUND).toBe("SESSION_NOT_FOUND");
    expect(ErrorCode.INTERRUPT_NOT_FOUND).toBe("INTERRUPT_NOT_FOUND");
    expect(ErrorCode.HANDLE_NOT_FOUND).toBe("HANDLE_NOT_FOUND");
  });
});

describe("Method", () => {
  it("should have agent methods", () => {
    expect(Method.AGENT_CREATE).toBe("agent.create");
    expect(Method.AGENT_DELETE).toBe("agent.delete");
    expect(Method.AGENT_LIST).toBe("agent.list");
    expect(Method.AGENT_EXECUTE).toBe("agent.execute");
  });

  it("should have thread methods", () => {
    expect(Method.THREAD_CREATE).toBe("thread.create");
    expect(Method.THREAD_DELETE).toBe("thread.delete");
    expect(Method.THREAD_GET).toBe("thread.get");
    expect(Method.THREAD_LIST).toBe("thread.list");
    expect(Method.THREAD_HISTORY).toBe("thread.history");
    expect(Method.THREAD_CLEAR).toBe("thread.clear");
  });

  it("should have tool methods", () => {
    expect(Method.TOOL_COMPILE).toBe("tool.compile");
    expect(Method.TOOL_LIST).toBe("tool.list");
  });

  it("should have approval and interrupt methods", () => {
    expect(Method.APPROVAL_TOOL).toBe("agent.approval_tool");
    expect(Method.INTERRUPT_LIST).toBe("interrupt.list");
    expect(Method.INTERRUPT_RESUME).toBe("interrupt.resume");
  });
});

describe("EventType", () => {
  it("should have all event types", () => {
    expect(EventType.STREAM).toBe("stream");
    expect(EventType.INTERRUPT).toBe("interrupt");
    expect(EventType.STAGED).toBe("staged");
    expect(EventType.DONE).toBe("done");
    expect(EventType.ERROR).toBe("error");
  });
});
