import { describe, it, expect, vi, beforeEach } from "vitest";
import { RpcRouter, createRouter } from "@/service/message/router.js";
import type { HandlerContext, HandlerFn } from "@/service/message/router.js";
import {
  createRpcRequest,
  createRpcResponse,
  createRpcEvent,
  createRpcTool,
  ErrorCode,
  EventType,
} from "@/service/message/types.js";
import type { RpcRequest, RpcResponse, RpcEvent, RpcTool } from "@/service/message/types.js";

function createMockCtx(): HandlerContext {
  return {
    connectionId: "conn-1",
    sessionId: "sess-1",
    sendEvent: vi.fn(),
    setTimeout: vi.fn(),
    clearTimeout: vi.fn(),
  };
}

describe("RpcRouter", () => {
  let router: RpcRouter;

  beforeEach(() => {
    router = new RpcRouter();
  });

  // --------------------------------------------------------------------------
  // register + getMethods
  // --------------------------------------------------------------------------

  describe("register", () => {
    it("should add handler and appear in getMethods", () => {
      const handler = vi.fn(async () => ({ ok: true }));
      router.register("test.method", handler);

      expect(router.getMethods()).toContain("test.method");
    });

    it("should register with streaming flag", () => {
      async function* streamHandler(_ctx: HandlerContext, _params: unknown) {
        yield createRpcEvent(EventType.STREAM, { delta: "a" });
        return { done: true };
      }
      router.register("stream.method", streamHandler, true);

      expect(router.getMethods()).toContain("stream.method");
    });
  });

  describe("getMethods", () => {
    it("should return empty array initially", () => {
      expect(router.getMethods()).toEqual([]);
    });

    it("should return all registered method names", () => {
      router.register("a", vi.fn(async () => {}));
      router.register("b", vi.fn(async () => {}));

      const methods = router.getMethods();
      expect(methods).toHaveLength(2);
      expect(methods).toContain("a");
      expect(methods).toContain("b");
    });
  });

  // --------------------------------------------------------------------------
  // handle - Promise handler
  // --------------------------------------------------------------------------

  describe("handle with Promise handler", () => {
    it("should return success response", async () => {
      const handler = vi.fn(async () => ({ result: "ok" }));
      router.register("test.method", handler);

      const req = createRpcRequest("test.method", { x: 1 });
      const ctx = createMockCtx();
      const result = await router.handle(req, ctx);

      expect(result).toBeDefined();
      const resp = result as RpcResponse;
      expect(resp.kind).toBe("response");
      expect(resp.success).toBe(true);
      expect(resp.requestId).toBe(req.id);
      expect(resp.result).toEqual({ result: "ok" });
    });

    it("should pass ctx and params to handler", async () => {
      const handler = vi.fn(async () => null);
      router.register("check.params", handler);

      const req = createRpcRequest("check.params", { foo: "bar" });
      const ctx = createMockCtx();
      await router.handle(req, ctx);

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(ctx, { foo: "bar" });
    });
  });

  // --------------------------------------------------------------------------
  // handle - METHOD_NOT_FOUND
  // --------------------------------------------------------------------------

  describe("handle unknown method", () => {
    it("should return METHOD_NOT_FOUND error", async () => {
      const req = createRpcRequest("unknown.method", {});
      const ctx = createMockCtx();
      const result = await router.handle(req, ctx);

      const resp = result as RpcResponse;
      expect(resp.success).toBe(false);
      expect(resp.error).toBeDefined();
      expect(resp.error!.code).toBe(ErrorCode.METHOD_NOT_FOUND);
      expect(resp.error!.message).toContain("unknown.method");
    });
  });

  // --------------------------------------------------------------------------
  // handle - handler throws
  // --------------------------------------------------------------------------

  describe("handle handler error", () => {
    it("should return INTERNAL error when handler throws", async () => {
      const handler = vi.fn(async () => {
        throw new Error("handler exploded");
      });
      router.register("boom", handler);

      const req = createRpcRequest("boom", {});
      const ctx = createMockCtx();
      const result = await router.handle(req, ctx);

      const resp = result as RpcResponse;
      expect(resp.success).toBe(false);
      expect(resp.error).toBeDefined();
      expect(resp.error!.code).toBe(ErrorCode.INTERNAL);
      expect(resp.error!.message).toBe("handler exploded");
    });
  });

  // --------------------------------------------------------------------------
  // handle - streaming handler (AsyncGenerator)
  // --------------------------------------------------------------------------

  describe("handle with streaming handler", () => {
    it("should return AsyncGenerator", async () => {
      async function* streamHandler(_ctx: HandlerContext, _params: unknown) {
        yield createRpcEvent(EventType.STREAM, { delta: "hello" });
        return { result: "done" };
      }
      router.register("stream.test", streamHandler);

      const req = createRpcRequest("stream.test", {});
      const ctx = createMockCtx();
      const result = await router.handle(req, ctx);

      // handle() returns the generator (synchronously, no await needed for the generator itself)
      // but handle() is async and returns the generator directly
      const gen = result as AsyncGenerator<RpcEvent | RpcTool, RpcResponse, unknown>;
      expect(gen).toBeDefined();
      expect(typeof gen.next).toBe("function");

      // Consume the generator
      const items: (RpcEvent | RpcTool)[] = [];
      let finalResult: RpcResponse | undefined;
      while (true) {
        const { value, done } = await gen.next();
        if (done) {
          finalResult = value as RpcResponse;
          break;
        }
        items.push(value as RpcEvent | RpcTool);
      }

      // Should have yielded one event
      expect(items).toHaveLength(1);
      const yieldedEvent = items[0]! as RpcEvent;
      expect(yieldedEvent.kind).toBe("event");
      expect(yieldedEvent.event).toBe(EventType.STREAM);
      expect(yieldedEvent.data).toEqual({ delta: "hello" });

      // Final result should be a success response
      expect(finalResult).toBeDefined();
      expect(finalResult!.kind).toBe("response");
      expect(finalResult!.success).toBe(true);
      expect(finalResult!.requestId).toBe(req.id);
    });

    it("should pass ctx and params to streaming handler", async () => {
      const receivedArgs: { ctx?: HandlerContext; params?: unknown } = {};
      async function* streamHandler(ctx: HandlerContext, params: unknown) {
        receivedArgs.ctx = ctx;
        receivedArgs.params = params;
        yield createRpcEvent(EventType.DONE, null);
        return null;
      }
      router.register("args.check", streamHandler);

      const req = createRpcRequest("args.check", { key: "val" });
      const ctx = createMockCtx();
      const gen = (await router.handle(req, ctx)) as AsyncGenerator<RpcEvent | RpcTool, RpcResponse, unknown>;

      // Consume generator to trigger execution
      await gen.next();
      while (true) {
        const { done } = await gen.next();
        if (done) break;
      }

      expect(receivedArgs.ctx).toBe(ctx);
      expect(receivedArgs.params).toEqual({ key: "val" });
    });
  });

  // --------------------------------------------------------------------------
  // wrapStreamingHandler error handling
  // --------------------------------------------------------------------------

  describe("wrapStreamingHandler error", () => {
    it("should yield ERROR event and return error response when generator throws", async () => {
      async function* failingHandler(_ctx: HandlerContext, _params: unknown) {
        yield createRpcEvent(EventType.STREAM, { delta: "start" });
        throw new Error("generator broke");
      }
      router.register("fail.stream", failingHandler);

      const req = createRpcRequest("fail.stream", {});
      const ctx = createMockCtx();
      const gen = (await router.handle(req, ctx)) as AsyncGenerator<RpcEvent | RpcTool, RpcResponse, unknown>;

      const items: (RpcEvent | RpcTool)[] = [];
      let finalResult: RpcResponse | undefined;
      while (true) {
        const { value, done } = await gen.next();
        if (done) {
          finalResult = value as RpcResponse;
          break;
        }
        items.push(value as RpcEvent | RpcTool);
      }

      // Should have yielded: STREAM event + ERROR event
      expect(items).toHaveLength(2);

      const errorEvent = items[1]! as RpcEvent;
      expect(errorEvent.kind).toBe("event");
      expect(errorEvent.event).toBe(EventType.ERROR);
      expect(errorEvent.data).toEqual({ error: "generator broke" });
      expect(errorEvent.requestId).toBe(req.id);

      // Final response should be error
      expect(finalResult!.success).toBe(false);
      expect(finalResult!.error!.code).toBe(ErrorCode.INTERNAL);
      expect(finalResult!.error!.message).toBe("generator broke");
    });
  });
});

// --------------------------------------------------------------------------
// createRouter factory
// --------------------------------------------------------------------------

describe("createRouter", () => {
  it("should return RpcRouter instance", () => {
    const r = createRouter();
    expect(r).toBeInstanceOf(RpcRouter);
  });

  it("should return empty methods on new instance", () => {
    const r = createRouter();
    expect(r.getMethods()).toEqual([]);
  });
});
