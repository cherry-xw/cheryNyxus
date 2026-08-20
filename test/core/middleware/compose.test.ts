import { describe, it, expect } from "vitest";
import { compose } from "@/core/middleware/compose";
import { isAgentAbortError } from "@/core/middleware/errors";
import { ClassifiedError } from "@/utils/error";
import type { MiddlewareContext } from "@/core/middleware/types";

/** 最小 ctx：compose 只透传 ctx 给 handler，不读取其字段 */
function createMockContext(): MiddlewareContext {
  return {
    soul: {
      chatId: "test",
      senseSharedData: new Map(),
      userInputs: [],
      messages: [],
    },
    global: {
      thinking: false,
      supervision: 1,
      stream: true,
    },
  } as MiddlewareContext;
}

async function drain(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const chunk of gen) out.push(chunk);
  return out;
}

describe("compose middleware", () => {
  describe("return shape", () => {
    it("returns object with run and abort (not callable)", () => {
      const composed = compose([]);
      expect(composed).toBeDefined();
      expect(typeof composed.run).toBe("function");
      expect(typeof composed.abort).toBe("function");
    });

    it("run returns an async generator", () => {
      const composed = compose([]);
      const gen = composed.run(createMockContext());
      expect(typeof gen.next).toBe("function");
      expect(typeof gen[Symbol.asyncIterator]).toBe("function");
    });
  });

  describe("execution order (onion model)", () => {
    it("executes enter-before-next, exit-after-next (2 handlers)", async () => {
      const order: string[] = [];
      const handler1 = async function* (_ctx: any, next: any) {
        order.push("enter1");
        yield* next();
        order.push("exit1");
      };
      const handler2 = async function* (_ctx: any, next: any) {
        order.push("enter2");
        yield* next();
        order.push("exit2");
      };

      await drain(compose([handler1, handler2]).run(createMockContext()));

      expect(order).toEqual(["enter1", "enter2", "exit2", "exit1"]);
    });

    it("executes nested enter/exit correctly (3 handlers)", async () => {
      const order: string[] = [];
      const handlers = [
        async function* (_c: any, n: any) {
          order.push("a-enter");
          yield* n();
          order.push("a-exit");
        },
        async function* (_c: any, n: any) {
          order.push("b-enter");
          yield* n();
          order.push("b-exit");
        },
        async function* (_c: any, n: any) {
          order.push("c-enter");
          yield* n();
          order.push("c-exit");
        },
      ];

      await drain(compose(handlers).run(createMockContext()));

      expect(order).toEqual([
        "a-enter",
        "b-enter",
        "c-enter",
        "c-exit",
        "b-exit",
        "a-exit",
      ]);
    });
  });

  describe("yield behavior", () => {
    it("yields chunks emitted before and after next()", async () => {
      const handler = async function* (_c: any, next: any) {
        yield "chunk1";
        yield* next();
        yield "chunk2";
      };

      const chunks = await drain(compose([handler]).run(createMockContext()));

      expect(chunks).toEqual(["chunk1", "chunk2"]);
    });

    it("yields chunks across nested handlers", async () => {
      const handler1 = async function* (_c: any, next: any) {
        yield "outer-before";
        yield* next();
        yield "outer-after";
      };
      const handler2 = async function* (_c: any, next: any) {
        yield "inner";
        yield* next();
      };

      const chunks = await drain(
        compose([handler1, handler2]).run(createMockContext()),
      );

      expect(chunks).toEqual(["outer-before", "inner", "outer-after"]);
    });

    it("creates a fresh downstream pipeline for each next() call", async () => {
      let attempts = 0;
      const retryLike = async function* (_c: any, next: any) {
        try {
          yield* next();
        } catch {
          yield* next();
        }
      };
      const flaky = async function* () {
        attempts++;
        if (attempts === 1) throw new Error("transient");
        yield "recovered";
      };

      const chunks = await drain(compose([retryLike, flaky]).run(createMockContext()));

      expect(chunks).toEqual(["recovered"]);
      expect(attempts).toBe(2);
    });
  });

  describe("edge cases", () => {
    it("handles empty handlers array (yields nothing)", async () => {
      const chunks = await drain(compose([]).run(createMockContext()));
      expect(chunks).toHaveLength(0);
    });

    it("handles single handler", async () => {
      const handler = async function* (_c: any, next: any) {
        yield "single";
        yield* next();
      };

      const chunks = await drain(compose([handler]).run(createMockContext()));
      expect(chunks).toEqual(["single"]);
    });

    it("handler can skip next() (short-circuit)", async () => {
      const order: string[] = [];
      const handler1 = async function* () {
        order.push("1");
        // skip next
      };
      const handler2 = async function* (_c: any, next: any) {
        order.push("2");
        yield* next();
      };

      await drain(compose([handler1, handler2]).run(createMockContext()));

      expect(order).toEqual(["1"]);
    });
  });

  describe("error propagation", () => {
    it("rethrows compliant errors (开头含 [8hex] tracingId) verbatim", async () => {
      const handler = async function* () {
        throw new Error("[a1b2c3d4] glm-5 缺少 key。请在 .env 设 API_KEY 后重启");
      };

      await expect(
        drain(compose([handler]).run(createMockContext())),
      ).rejects.toThrow("[a1b2c3d4] glm-5 缺少 key。请在 .env 设 API_KEY 后重启");
    });

    it("rewraps non-compliant errors (第三方裸抛) 为友好文案 + 新 tracingId", async () => {
      const handler = async function* () {
        throw new Error("boom");
      };

      // "boom" 开头无 [8hex] tracingId → compose 兜底 classifyError('unknown') + friendlyMessage('unknown','system') = "系统出了点小问题"
      // throwUserFacing 前置 [tracingId]
      await expect(
        drain(compose([handler]).run(createMockContext())),
      ).rejects.toThrow(/^\[[0-9a-f]{8}\] 系统出了点小问题$/);
    });

    it("内层 ClassifiedError 原样上浮（保分类身份，不转用户面）", async () => {
      // 回归：内层（如 chat 层）抛出的 ClassifiedError 须原样上浮，
      // 外层 retry 才能以 instanceof 命中 category 判可重试（429/network 等）。
      // 若在此层 throwUserFacing 转换，retry 只见 unknown/不可恢复 → 不重试。
      const caught: unknown[] = [];
      const outer = async function* (_c: any, next: any) {
        try {
          yield* next();
        } catch (err) {
          caught.push(err);
          throw err;
        }
      };
      const inner = async function* () {
        throw new ClassifiedError({
          message: "upstream 429: too frequent",
          userMessage: "脑子忙不过来了，稍后再试",
          category: "provider",
          source: "brain",
        });
      };

      // outer(内层 ClassifiedError) → outer catch 收到 ClassifiedError 本体 → 再 throw → 最外层兜底转用户面
      await expect(
        drain(compose([outer, inner]).run(createMockContext())),
      ).rejects.toThrow(/^\[[0-9a-f]{8}\] 脑子忙不过来了，稍后再试$/);
      expect(caught[0]).toBeInstanceOf(ClassifiedError);
      expect((caught[0] as ClassifiedError).category).toBe("provider");
    });

    it("最外层（单 handler）ClassifiedError 兜底转用户面 + tracingId", async () => {
      // 最外层（index=0）已无任何中间件可处理 → 兜底取 userMessage 转用户面（行为不变）
      const handler = async function* () {
        throw new ClassifiedError({
          message: "upstream 429: too frequent",
          userMessage: "脑子忙不过来了，稍后再试",
          category: "provider",
          source: "brain",
        });
      };

      await expect(
        drain(compose([handler]).run(createMockContext())),
      ).rejects.toThrow(/^\[[0-9a-f]{8}\] 脑子忙不过来了，稍后再试$/);
    });
  });

  describe("abort", () => {
    it("is a no-op when no generator has run", () => {
      const composed = compose([]);
      expect(() => composed.abort()).not.toThrow();
    });

    it("is a no-op after generator already drained", async () => {
      const composed = compose([]);
      await drain(composed.run(createMockContext()));
      expect(() => composed.abort()).not.toThrow();
    });

    it("injects error into suspended generator via .throw", async () => {
      const seen: unknown[] = [];
      const handler = async function* (_c: any, next: any) {
        try {
          yield "first";
          yield "second";
          yield* next();
        } catch (err) {
          seen.push(err);
          throw err;
        }
      };

      const composed = compose([handler]);
      const gen = composed.run(createMockContext());

      const r1 = await gen.next();
      expect(r1.value).toBe("first");

      composed.abort();

      // abort → gen.throw 异步推进：handler 在 yield 处捕获并 re-throw
      await new Promise((r) => setTimeout(r, 10));
      // 严格断言：abort 注入的是 AgentAbortError，且 compose 未包装（原样上浮）
      expect(seen.some(isAgentAbortError)).toBe(true);
    });
  });
});
