import { describe, it, expect, vi, beforeEach } from "vitest";
import { RpcRouter, createRouter } from "@/service/message/router.js";
import type { HandlerContext, HandlerFn } from "@/service/message/router.js";
import {
  createRequest,
  createResponse,
  createNotification,
  createChunk,
  ErrorCode,
} from "@/service/message/types.js";
import type { Request, Response, Notification, Chunk } from "@/service/message/types.js";

function createMockCtx(): HandlerContext {
  return {
    connectionId: "conn-1",
    sendChunk: vi.fn(),
    sendNotification: vi.fn(),
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
        yield createChunk("stream", "req-1", { content: "a" });
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

      const req = createRequest("test.method", {} as any);
      const ctx = createMockCtx();
      const result = await router.handle(req, ctx);

      expect(result).toBeDefined();
      const resp = result as Response;
      expect(resp.kind).toBe("response");
      expect(resp.success).toBe(true);
      expect(resp.requestId).toBe(req.id);
      expect(resp.data).toEqual({ result: "ok" });
    });

    it("should pass ctx and params to handler", async () => {
      const handler = vi.fn(async () => null);
      router.register("check.params", handler);

      const req = createRequest("check.params", {} as any);
      const ctx = createMockCtx();
      await router.handle(req, ctx);

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(ctx, {} as any);
    });
  });

  // --------------------------------------------------------------------------
  // handle - METHOD_NOT_FOUND
  // --------------------------------------------------------------------------

  describe("handle unknown method", () => {
    it("should return METHOD_NOT_FOUND error", async () => {
      const req = createRequest("unknown.method", {} as any);
      const ctx = createMockCtx();
      const result = await router.handle(req, ctx);

      const resp = result as Response;
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

      const req = createRequest("boom", {} as any);
      const ctx = createMockCtx();
      const result = await router.handle(req, ctx);

      const resp = result as Response;
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
        yield createChunk("stream", "req-1", { content: "hello" });
        return { result: "done" };
      }
      router.register("stream.test", streamHandler);

      const req = createRequest("stream.test", {} as any);
      const ctx = createMockCtx();
      const result = await router.handle(req, ctx);

      // handle() returns the generator (synchronously, no await needed for the generator itself)
      // but handle() is async and returns the generator directly
      const gen = result as AsyncGenerator<Chunk | Notification, Response, unknown>;
      expect(gen).toBeDefined();
      expect(typeof gen.next).toBe("function");

      // Consume the generator
      const items: (Chunk | Notification)[] = [];
      let finalResult: Response | undefined;
      while (true) {
        const { value, done } = await gen.next();
        if (done) {
          finalResult = value as Response;
          break;
        }
        items.push(value as Chunk | Notification);
      }

      // Should have yielded one chunk
      expect(items).toHaveLength(1);
      const yieldedChunk = items[0]! as Chunk;
      expect(yieldedChunk.kind).toBe("chunk");
      expect(yieldedChunk.type).toBe("stream");
      expect(yieldedChunk.data).toEqual({ content: "hello" });

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
        yield createNotification("done", "req-1", null);
        return null;
      }
      router.register("args.check", streamHandler);

      const req = createRequest("args.check", {} as any);
      const ctx = createMockCtx();
      const gen = (await router.handle(req, ctx)) as AsyncGenerator<Chunk | Notification, Response, unknown>;

      // Consume generator to trigger execution
      await gen.next();
      while (true) {
        const { done } = await gen.next();
        if (done) break;
      }

      expect(receivedArgs.ctx).toBe(ctx);
      expect(receivedArgs.params).toEqual({} as any);
    });
  });

  // --------------------------------------------------------------------------
  // wrapStreamingHandler error handling
  // --------------------------------------------------------------------------

  describe("wrapStreamingHandler error", () => {
    it("should yield ERROR event and return error response when generator throws", async () => {
      async function* failingHandler(_ctx: HandlerContext, _params: unknown) {
        yield createChunk("stream", "req-1", { content: "start" });
        throw new Error("generator broke");
      }
      router.register("fail.stream", failingHandler);

      const req = createRequest("fail.stream", {} as any);
      const ctx = createMockCtx();
      const gen = (await router.handle(req, ctx)) as AsyncGenerator<Chunk | Notification, Response, unknown>;

      const items: (Chunk | Notification)[] = [];
      let finalResult: Response | undefined;
      while (true) {
        const { value, done } = await gen.next();
        if (done) {
          finalResult = value as Response;
          break;
        }
        items.push(value as Chunk | Notification);
      }

      // Should have yielded: STREAM chunk + ERROR notification
      expect(items).toHaveLength(2);

      const errorNotification = items[1]! as Notification;
      expect(errorNotification.kind).toBe("notification");
      expect(errorNotification.type).toBe("error");
      expect(errorNotification.data).toEqual({ message: "generator broke" });
      expect(errorNotification.requestId).toBe(req.id);

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
