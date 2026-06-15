import { describe, it, expect } from "vitest";
import { compose } from "@/core/middleware/compose";
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
    it("wraps thrown handler errors with index prefix", async () => {
      const handler = async function* () {
        throw new Error("boom");
      };

      await expect(
        drain(compose([handler]).run(createMockContext())),
      ).rejects.toThrow("[compose] handler at index 0 threw: boom");
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
      const seen: string[] = [];
      const handler = async function* (_c: any, next: any) {
        try {
          yield "first";
          yield "second";
          yield* next();
        } catch (err) {
          seen.push((err as Error).message);
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
      expect(seen.some((m) => m.includes("approval aborted"))).toBe(true);
    });
  });
});
