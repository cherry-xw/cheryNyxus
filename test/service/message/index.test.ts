import { describe, it, expect } from "vitest";
import * as mod from "@/service/message/index.js";
import {
  createRequest,
  createResponse,
  createError,
  createNotification,
  isRequest,
  isResponse,
  isNotification,
  isChunk,
  ErrorCode,
  Method,
  RpcRouter,
  createRouter,
} from "@/service/message/index.js";

describe("service/message/index re-exports", () => {
  it("should export types.ts factories", () => {
    expect(typeof createRequest).toBe("function");
    expect(typeof createResponse).toBe("function");
    expect(typeof createError).toBe("function");
    expect(typeof createNotification).toBe("function");
  });

  it("should export type guards", () => {
    expect(typeof isRequest).toBe("function");
    expect(typeof isResponse).toBe("function");
    expect(typeof isNotification).toBe("function");
    expect(typeof isChunk).toBe("function");
  });

  it("should export constants", () => {
    expect(ErrorCode).toBeDefined();
    expect(Method).toBeDefined();
  });

  it("should export router.ts members", () => {
    expect(typeof RpcRouter).toBe("function");
    expect(typeof createRouter).toBe("function");
  });

  it("should allow creating a request via re-exported factory", () => {
    const req = createRequest("soul.create", { brain: "test" });
    expect(req.kind).toBe("request");
    expect(isRequest(req)).toBe(true);
  });
});
