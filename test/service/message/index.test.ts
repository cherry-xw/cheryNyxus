import { describe, it, expect } from "vitest";
import * as messageIndex from "@/service/message/index.js";
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
  RpcRouter,
  createRouter,
} from "@/service/message/index.js";

describe("service/message/index re-exports", () => {
  it("re-exports type factory functions", () => {
    expect(typeof createRequest).toBe("function");
    expect(typeof createResponse).toBe("function");
    expect(typeof createChunk).toBe("function");
    expect(typeof createNotification).toBe("function");
    expect(typeof createError).toBe("function");
  });

  it("re-exports type guards", () => {
    expect(typeof isRequest).toBe("function");
    expect(typeof isResponse).toBe("function");
    expect(typeof isChunk).toBe("function");
    expect(typeof isNotification).toBe("function");
  });

  it("re-exports Method and ErrorCode constants", () => {
    expect(Method.CHAT_SEND).toBe("chat.send");
    expect(ErrorCode.INTERNAL).toBe("INTERNAL");
  });

  it("re-exports router (RpcRouter class + createRouter)", () => {
    expect(typeof RpcRouter).toBe("function");
    expect(typeof createRouter).toBe("function");
    expect(createRouter()).toBeInstanceOf(RpcRouter);
  });

  it("namespace exposes both types and router members", () => {
    expect(messageIndex.createRequest).toBe(createRequest);
    expect(messageIndex.createRouter).toBe(createRouter);
    expect(messageIndex.RpcRouter).toBe(RpcRouter);
  });
});
