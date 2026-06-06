import { describe, it, expect, vi, beforeEach } from "vitest";
import { createLoopHandler } from "@/agent/middleware/loop";
import type { MiddlewareContext, MiddlewareChunk } from "@/core/middleware/types";

// 创建 Mock 上下文
function createMockContext(overrides: Partial<MiddlewareContext> = {}): MiddlewareContext {
  return {
    soul: {
      soulId: "test-soul",
      chatId: "test-chat",
      hashCheck: new Map(),
      senseSharedData: new Map(),
      userInputs: [],
      builtSenses: [],
      messages: [],
    },
    global: {
      thinking: false,
      supervision: 0,
      stream: true,
      maxLoopCount: 10,
    },
    brain: {
      provider: "test",
      model: "test-model",
      url: "http://localhost",
      key: "",
      sense_group: [],
    },
    adapters: {
      llmAdapter: {} as any,
      messageAdapter: {} as any,
      senseAdapter: {} as any,
    },
    senseManager: {
      add: vi.fn(),
      getAll: vi.fn(() => []),
      get: vi.fn(),
      execute: vi.fn(),
    } as any,
    ...overrides,
  } as MiddlewareContext;
}

describe("createLoopHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("停止条件", () => {
    it("should stop when messages is empty", async () => {
      const handler = createLoopHandler(10);
      const ctx = createMockContext({
        soul: {
          ...createMockContext().soul,
          messages: [],
        },
      });

      let runCount = 0;
      async function* runChain() {
        runCount++;
        yield { type: "done" } as MiddlewareChunk;
      }

      const results: MiddlewareChunk[] = [];
      for await (const chunk of handler(ctx, runChain)) {
        results.push(chunk);
      }

      expect(runCount).toBe(1);
      expect(results).toHaveLength(1);
    });

    it("should stop when last message is assistant without senseCalls", async () => {
      const handler = createLoopHandler(10);
      const ctx = createMockContext({
        soul: {
          ...createMockContext().soul,
          messages: [
            { id: "1", role: "user", content: "Hello", createdAt: 0, updateAt: 0 },
            { id: "2", role: "assistant", content: "Hi there", createdAt: 0, updateAt: 0 },
          ],
        },
      });

      let runCount = 0;
      async function* runChain() {
        runCount++;
        yield { type: "done" } as MiddlewareChunk;
      }

      const results: MiddlewareChunk[] = [];
      for await (const chunk of handler(ctx, runChain)) {
        results.push(chunk);
      }

      expect(runCount).toBe(1);
    });

    it("should stop when last message is user", async () => {
      const handler = createLoopHandler(10);
      const ctx = createMockContext({
        soul: {
          ...createMockContext().soul,
          messages: [{ id: "1", role: "user", content: "Hello", createdAt: 0, updateAt: 0 }],
        },
      });

      let runCount = 0;
      async function* runChain() {
        runCount++;
        yield { type: "done" } as MiddlewareChunk;
      }

      const results: MiddlewareChunk[] = [];
      for await (const chunk of handler(ctx, runChain)) {
        results.push(chunk);
      }

      expect(runCount).toBe(1);
    });

    it("should stop when last message is system", async () => {
      const handler = createLoopHandler(10);
      const ctx = createMockContext({
        soul: {
          ...createMockContext().soul,
          messages: [{ id: "1", role: "system", content: "System prompt", createdAt: 0, updateAt: 0 }],
        },
      });

      let runCount = 0;
      async function* runChain() {
        runCount++;
        yield { type: "done" } as MiddlewareChunk;
      }

      const results: MiddlewareChunk[] = [];
      for await (const chunk of handler(ctx, runChain)) {
        results.push(chunk);
      }

      expect(runCount).toBe(1);
    });
  });

  describe("继续循环条件", () => {
    it("should continue when last message is sense", async () => {
      const handler = createLoopHandler(10);
      const ctx = createMockContext({
        soul: {
          ...createMockContext().soul,
          messages: [],
        },
      });

      let runCount = 0;
      async function* runChain() {
        runCount++;
        if (runCount === 1) {
          // First run: add sense message
          ctx.soul.messages?.push({
            id: "sense-1",
            role: "sense",
            content: "result",
            createdAt: Date.now(),
            updateAt: Date.now(),
          });
        } else {
          // Second run: add assistant message without senseCalls
          ctx.soul.messages?.push({
            id: "asst-1",
            role: "assistant",
            content: "Done",
            createdAt: Date.now(),
            updateAt: Date.now(),
          });
        }
        yield { type: "done" } as MiddlewareChunk;
      }

      const results: MiddlewareChunk[] = [];
      for await (const chunk of handler(ctx, runChain)) {
        results.push(chunk);
      }

      expect(runCount).toBe(2);
    });

    it("should continue when last message is assistant with senseCalls", async () => {
      const handler = createLoopHandler(10);
      const ctx = createMockContext({
        soul: {
          ...createMockContext().soul,
          messages: [],
        },
      });

      let runCount = 0;
      async function* runChain() {
        runCount++;
        if (runCount === 1) {
          // First run: add assistant message with senseCalls
          ctx.soul.messages?.push({
            id: "asst-1",
            role: "assistant",
            content: "I will run a command",
            senseCalls: [{ id: "sc-1", name: "execute_command", arguments: '{"cmd":"ls"}' }],
            createdAt: Date.now(),
            updateAt: Date.now(),
          });
        } else {
          // Second run: add assistant message without senseCalls
          ctx.soul.messages?.push({
            id: "asst-2",
            role: "assistant",
            content: "Done",
            createdAt: Date.now(),
            updateAt: Date.now(),
          });
        }
        yield { type: "done" } as MiddlewareChunk;
      }

      const results: MiddlewareChunk[] = [];
      for await (const chunk of handler(ctx, runChain)) {
        results.push(chunk);
      }

      expect(runCount).toBe(2);
    });
  });

  describe("maxLoop 限制", () => {
    it("should yield error chunk when maxLoop exceeded", async () => {
      const maxLoop = 3;
      const handler = createLoopHandler(maxLoop);
      const ctx = createMockContext({
        soul: {
          ...createMockContext().soul,
          messages: [],
        },
      });

      let runCount = 0;
      async function* runChain() {
        runCount++;
        // Always add sense message to keep looping
        ctx.soul.messages?.push({
          id: `sense-${runCount}`,
          role: "sense",
          content: `result ${runCount}`,
          createdAt: Date.now(),
          updateAt: Date.now(),
        });
        yield { type: "done" } as MiddlewareChunk;
      }

      const results: MiddlewareChunk[] = [];
      for await (const chunk of handler(ctx, runChain)) {
        results.push(chunk);
      }

      expect(runCount).toBe(maxLoop);
      const errorChunk = results.find((c) => c.type === "error");
      expect(errorChunk).toBeDefined();
      expect((errorChunk as any).errors[0].message).toContain("最大循环次数限制");
      expect((errorChunk as any).errors[0].recoverable).toBe(false);
    });

    it("should use default maxLoop of 30", async () => {
      const handler = createLoopHandler(); // Default 30
      const ctx = createMockContext({
        soul: {
          ...createMockContext().soul,
          messages: [],
        },
      });

      let runCount = 0;
      async function* runChain() {
        runCount++;
        // Always add sense message to keep looping until stopped by maxLoop
        ctx.soul.messages?.push({
          id: `sense-${runCount}`,
          role: "sense",
          content: `result ${runCount}`,
          createdAt: Date.now(),
          updateAt: Date.now(),
        });
        yield { type: "done" } as MiddlewareChunk;
      }

      const results: MiddlewareChunk[] = [];
      for await (const chunk of handler(ctx, runChain)) {
        results.push(chunk);
      }

      // Should stop at default maxLoop (30)
      expect(runCount).toBe(30);
      // Should have error chunk
      expect(results.find((c) => c.type === "error")).toBeDefined();
    });
  });

  describe("chunk 传递", () => {
    it("should yield all chunks from runChain", async () => {
      const handler = createLoopHandler(10);
      const ctx = createMockContext({
        soul: {
          ...createMockContext().soul,
          messages: [{ id: "1", role: "assistant", content: "Done", createdAt: 0, updateAt: 0 }],
        },
      });

      async function* runChain() {
        yield { type: "stream", thinkingDelta: "thinking", contentDelta: "" } as MiddlewareChunk;
        yield { type: "stream", thinkingDelta: "", contentDelta: "Hello" } as MiddlewareChunk;
        yield { type: "staged", content: "Hello", thinking: "thinking" } as MiddlewareChunk;
        yield { type: "done" } as MiddlewareChunk;
      }

      const results: MiddlewareChunk[] = [];
      for await (const chunk of handler(ctx, runChain)) {
        results.push(chunk);
      }

      expect(results).toHaveLength(4);
      expect(results[0].type).toBe("stream");
      expect(results[3].type).toBe("done");
    });

    it("should yield chunks from multiple loop iterations", async () => {
      const handler = createLoopHandler(10);
      const ctx = createMockContext({
        soul: {
          ...createMockContext().soul,
          messages: [],
        },
      });

      let runCount = 0;
      async function* runChain() {
        runCount++;
        yield { type: "done", iteration: runCount } as any;
        if (runCount === 1) {
          ctx.soul.messages?.push({
            id: "sense-1",
            role: "sense",
            content: "result",
            createdAt: Date.now(),
            updateAt: Date.now(),
          });
        } else {
          ctx.soul.messages?.push({
            id: "asst-1",
            role: "assistant",
            content: "Done",
            createdAt: Date.now(),
            updateAt: Date.now(),
          });
        }
      }

      const results: MiddlewareChunk[] = [];
      for await (const chunk of handler(ctx, runChain)) {
        results.push(chunk);
      }

      // Should have chunks from both iterations
      expect(results).toHaveLength(2);
    });
  });

  describe("边界情况", () => {
    it("should handle messages becoming undefined", async () => {
      const handler = createLoopHandler(10);
      const ctx = createMockContext({
        soul: {
          ...createMockContext().soul,
          messages: undefined as any,
        },
      });

      let runCount = 0;
      async function* runChain() {
        runCount++;
        yield { type: "done" } as MiddlewareChunk;
      }

      const results: MiddlewareChunk[] = [];
      for await (const chunk of handler(ctx, runChain)) {
        results.push(chunk);
      }

      expect(runCount).toBe(1);
    });

    it("should handle single iteration when stop condition met immediately", async () => {
      const handler = createLoopHandler(10);
      const ctx = createMockContext({
        soul: {
          ...createMockContext().soul,
          messages: [{ id: "1", role: "assistant", content: "Done", createdAt: 0, updateAt: 0 }],
        },
      });

      let runCount = 0;
      async function* runChain() {
        runCount++;
        yield { type: "done" } as MiddlewareChunk;
      }

      const results: MiddlewareChunk[] = [];
      for await (const chunk of handler(ctx, runChain)) {
        results.push(chunk);
      }

      expect(runCount).toBe(1);
    });
  });
});