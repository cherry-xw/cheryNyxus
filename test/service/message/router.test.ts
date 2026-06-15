import { describe, it, expect, beforeEach } from "vitest";
import { RpcRouter, createRouter, type HandlerContext } from "@/service/message/router.js";
import {
  createRequest,
  createChunk,
  createNotification,
  type Chunk,
  type Notification,
  type Response,
} from "@/service/message/types.js";

const ctx: HandlerContext = { requestId: "req-1", connectionId: "conn-1" };

/** 消费流式 handler 的 generator，收集中间 item 与最终 Response。 */
async function drain(
  gen: AsyncGenerator<Chunk | Notification, Response>,
): Promise<{ items: (Chunk | Notification)[]; final: Response }> {
  const items: (Chunk | Notification)[] = [];
  let final: Response | undefined;
  while (true) {
    const { done, value } = await gen.next();
    if (done) {
      final = value;
      break;
    }
    items.push(value);
  }
  return { items, final: final! };
}

describe("service/message/RpcRouter", () => {
  let router: RpcRouter;
  beforeEach(() => {
    router = createRouter();
  });

  it("handle returns METHOD_NOT_FOUND for unregistered method", async () => {
    const req = createRequest("nope.method", {} as never);
    const result = (await router.handle(req, ctx)) as Response;
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("METHOD_NOT_FOUND");
  });

  it("handle dispatches to a promise handler and wraps result as success Response", async () => {
    router.register("echo", async (_c, data) => ({ ok: true, echo: (data as { x: number }).x }));
    const req = createRequest("echo", { x: 7 } as never);
    const result = (await router.handle(req, ctx)) as Response;
    expect(result.success).toBe(true);
    expect(result.requestId).toBe(req.id);
    expect(result.data).toEqual({ ok: true, echo: 7 });
  });

  it("handle returns INTERNAL error when handler throws", async () => {
    router.register("boom", async () => {
      throw new Error("kaboom");
    });
    const req = createRequest("boom", {} as never);
    const result = (await router.handle(req, ctx)) as Response;
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("INTERNAL");
    expect(result.error?.message).toBe("kaboom");
  });

  it("handle passes through a Response returned directly by handler", async () => {
    router.register("raw", async () => {
      return {
        id: "x",
        kind: "response",
        requestId: "req-1",
        success: false,
        error: { code: "CUSTOM", message: "m" },
      } as Response;
    });
    const req = createRequest("raw", {} as never);
    const result = (await router.handle(req, ctx)) as Response;
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("CUSTOM");
  });

  it("handle streams chunks from a generator handler and ends with success Response", async () => {
    router.register("stream", async function* (c): AsyncGenerator<Chunk | Notification, { done: true }> {
      yield createChunk("stream", c.requestId!, { content: "a" });
      yield createNotification("done", c.requestId!, null);
      return { done: true };
    });
    const req = createRequest("stream", {} as never);
    const gen = (await router.handle(req, ctx)) as AsyncGenerator<
      Chunk | Notification,
      Response
    >;
    const { items, final } = await drain(gen);
    expect(items).toHaveLength(2);
    expect((items[0] as Chunk).kind).toBe("chunk");
    expect((items[1] as Notification).type).toBe("done");
    expect(final.success).toBe(true);
    expect(final.data).toEqual({ done: true });
  });

  it("streaming handler that throws yields error notification + failure Response", async () => {
    router.register("failstream", async function* (): AsyncGenerator<Chunk | Notification, never> {
      yield createChunk("stream", "req-1", { content: "x" });
      throw new Error("stream broke");
    });
    const req = createRequest("failstream", {} as never);
    const gen = (await router.handle(req, ctx)) as AsyncGenerator<
      Chunk | Notification,
      Response
    >;
    const { items, final } = await drain(gen);
    const errN = items.find((i) => i.kind === "notification") as Notification;
    expect(errN.type).toBe("error");
    expect((errN.data as { message: string }).message).toBe("stream broke");
    expect(final.success).toBe(false);
    expect(final.error?.code).toBe("INTERNAL");
  });

  it("createRouter returns an RpcRouter instance", () => {
    expect(createRouter()).toBeInstanceOf(RpcRouter);
  });
});
