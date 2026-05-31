import { describe, it, expect } from "vitest";
import { compose } from "@/core/middleware/compose";
import { createHistoryProxy } from "@/core/middleware/utils";

// Mock context - 使用类型断言绕过类型检查
function createMockContext() {
  return {
    session: {
      sessionId: "test",
      threadId: "test-thread",
      hashCheck: new Map(),
      toolSharedData: new Map(),
    },
    global: {
      thinking: false,
      supervision: 1,
      stream: true,
      maxLoopCount: 10,
    },
    config: {
      model: "test-model",
      provider: "test",
      url: "http://localhost",
      tool_group: "test",
    },
    adapters: {} as any,
    process: {
      history: createHistoryProxy(),
      contentAccumulated: "",
      thinkingAccumulated: "",
      chunkCount: 0,
      toolCallAccumulated: new Map(),
      pendingInputs: [],
    },
    tools: {} as any,
  } as any;
}

describe("compose middleware", () => {
  describe("execution order", () => {
    it("executes in onion model order", async () => {
      const order: string[] = [];

      const handler1 = async function* (ctx: any, next: any) {
        order.push("enter1");
        yield* next();
        order.push("exit1");
      };

      const handler2 = async function* (ctx: any, next: any) {
        order.push("enter2");
        yield* next();
        order.push("exit2");
      };

      const composed = compose([handler1, handler2]);
      const ctx = createMockContext();

      // Collect all chunks
      for await (const chunk of composed(ctx)) {
        // Do nothing with chunks
      }

      expect(order).toEqual(["enter1", "enter2", "exit2", "exit1"]);
    });

    it("executes with three handlers", async () => {
      const order: string[] = [];

      const handlers = [
        async function* (ctx: any, next: any) {
          order.push("a-enter");
          yield* next();
          order.push("a-exit");
        },
        async function* (ctx: any, next: any) {
          order.push("b-enter");
          yield* next();
          order.push("b-exit");
        },
        async function* (ctx: any, next: any) {
          order.push("c-enter");
          yield* next();
          order.push("c-exit");
        },
      ];

      const composed = compose(handlers);
      const ctx = createMockContext();

      for await (const chunk of composed(ctx)) {
        // Do nothing
      }

      expect(order).toEqual([
        "a-enter", "b-enter", "c-enter",
        "c-exit", "b-exit", "a-exit",
      ]);
    });
  });

  describe("yield behavior", () => {
    it("yields chunks from handlers", async () => {
      const handler = async function* (ctx: any, next: any) {
        yield "chunk1";
        yield* next();
        yield "chunk2";
      };

      const composed = compose([handler]);
      const ctx = createMockContext();

      const chunks: string[] = [];
      for await (const chunk of composed(ctx)) {
        chunks.push(chunk as string);
      }

      expect(chunks).toEqual(["chunk1", "chunk2"]);
    });

    it("yields chunks from nested handlers", async () => {
      const handler1 = async function* (ctx: any, next: any) {
        yield "outer-before";
        yield* next();
        yield "outer-after";
      };

      const handler2 = async function* (ctx: any, next: any) {
        yield "inner";
        yield* next();
      };

      const composed = compose([handler1, handler2]);
      const ctx = createMockContext();

      const chunks: string[] = [];
      for await (const chunk of composed(ctx)) {
        chunks.push(chunk as string);
      }

      expect(chunks).toEqual(["outer-before", "inner", "outer-after"]);
    });
  });

  describe("edge cases", () => {
    it("handles empty handlers array", async () => {
      const composed = compose([]);
      const ctx = createMockContext();

      const chunks: unknown[] = [];
      for await (const chunk of composed(ctx)) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(0);
    });

    it("handles single handler", async () => {
      const handler = async function* (ctx: any, next: any) {
        yield "single";
        yield* next();
      };

      const composed = compose([handler]);
      const ctx = createMockContext();

      const chunks: unknown[] = [];
      for await (const chunk of composed(ctx)) {
        chunks.push(chunk);
      }

      expect(chunks).toEqual(["single"]);
    });

    it("handler can skip next", async () => {
      const order: string[] = [];

      const handler1 = async function* (ctx: any, next: any) {
        order.push("1");
        // Skip next
      };

      const handler2 = async function* (ctx: any, next: any) {
        order.push("2");
        yield* next();
      };

      const composed = compose([handler1, handler2]);
      const ctx = createMockContext();

      for await (const chunk of composed(ctx)) {
        // Do nothing
      }

      expect(order).toEqual(["1"]);
    });
  });
});