import { describe, it, expect } from "vitest";
import * as mod from "@/service/message/index.js";
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
  RpcRouter,
  createRouter,
} from "@/service/message/index.js";

describe("service/message/index re-exports", () => {
  it("should export types.ts factories", () => {
    expect(typeof createRpcRequest).toBe("function");
    expect(typeof createRpcResponse).toBe("function");
    expect(typeof createRpcError).toBe("function");
    expect(typeof createRpcEvent).toBe("function");
    expect(typeof createRpcTool).toBe("function");
  });

  it("should export type guards", () => {
    expect(typeof isRpcRequest).toBe("function");
    expect(typeof isRpcResponse).toBe("function");
    expect(typeof isRpcEvent).toBe("function");
    expect(typeof isRpcTool).toBe("function");
  });

  it("should export constants", () => {
    expect(ErrorCode).toBeDefined();
    expect(Method).toBeDefined();
    expect(EventType).toBeDefined();
  });

  it("should export router.ts members", () => {
    expect(typeof RpcRouter).toBe("function");
    expect(typeof createRouter).toBe("function");
  });

  it("should allow creating a request via re-exported factory", () => {
    const req = createRpcRequest("agent.create", { model: "test" });
    expect(req.kind).toBe("request");
    expect(isRpcRequest(req)).toBe(true);
  });
});
