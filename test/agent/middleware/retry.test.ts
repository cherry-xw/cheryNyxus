import { describe, it, expect, vi, beforeEach } from "vitest";
import { retryMiddleware, type ErrorChunk } from "@/agent/middleware/retry";
import { createHistoryProxy } from "@/core/middleware/utils";

// 创建完整的 Mock 上下文
function createMockContext() {
  return {
    session: {
      sessionId: "test-session",
      threadId: "test-thread",
      hashCheck: new Map(),
      toolSharedData: new Map(),
    },
    global: {
      thinking: false,
      supervision: 0,
      stream: true,
      maxLoopCount: 10,
    },
    config: {
      provider: "test",
      model: "test-model",
      url: "http://localhost",
      key: "",
      tool_group: [],
    },
    adapters: {
      llmAdapter: {
        chat: vi.fn(),
        chatStream: vi.fn(),
      },
      messageAdapter: {
        role: vi.fn(),
        content: vi.fn(),
        thinking: vi.fn(),
        extractStreamDelta: vi.fn(),
        extractStreamThinking: vi.fn(),
        buildMessages: vi.fn(),
      },
      toolAdapter: {
        buildTools: vi.fn(() => []),
        buildToolCallMessage: vi.fn(),
        buildToolResponseMessage: vi.fn(),
        extractToolCalls: vi.fn(() => []),
        assembleToolCallChunks: vi.fn(() => []),
      },
    },
    process: {
      history: createHistoryProxy(),
      contentAccumulated: "",
      thinkingAccumulated: "",
      chunkCount: 0,
      toolCallAccumulated: new Map(),
      pendingInputs: [],
    },
    tools: {
      toolManager: {
        add: vi.fn(),
        getAll: vi.fn(() => []),
        get: vi.fn(),
        execute: vi.fn(),
        getAdapter: vi.fn(),
      },
    },
  } as any;
}

describe("retryMiddleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("successful execution", () => {
    it("should pass through all chunks without retry", async () => {
      const ctx = createMockContext();
      const chunks = [
        { type: "stream", contentDelta: "chunk1" },
        { type: "stream", contentDelta: "chunk2" },
        { type: "staged", content: "final" },
      ];

      async function* mockNext() {
        for (const chunk of chunks) {
          yield chunk;
        }
      }

      const generator = retryMiddleware(ctx, mockNext);
      const results = [];

      for await (const chunk of generator) {
        results.push(chunk);
      }

      expect(results.length).toBe(3);
      expect(results[0]).toEqual(chunks[0]);
      expect(results[1]).toEqual(chunks[1]);
      expect(results[2]).toEqual(chunks[2]);
    });

    it("should return early on success", async () => {
      const ctx = createMockContext();

      async function* mockNext() {
        yield { type: "staged", content: "success" };
      }

      const generator = retryMiddleware(ctx, mockNext);
      const results = [];

      for await (const chunk of generator) {
        results.push(chunk);
      }

      expect(results.length).toBe(1);
    });
  });

  describe("retry logic", () => {
    it("should retry on first error", async () => {
      const ctx = createMockContext();
      let attemptCount = 0;

      async function* mockNext() {
        attemptCount++;
        if (attemptCount === 1) {
          throw new Error("First attempt failed");
        }
        yield { type: "staged", content: "success" };
      }

      const generator = retryMiddleware(ctx, mockNext);
      const results = [];

      for await (const chunk of generator) {
        results.push(chunk);
      }

      expect(attemptCount).toBe(2);
      expect(results.length).toBe(1);
    });

    it("should retry MAX_RETRIES times (3)", async () => {
      const ctx = createMockContext();
      let attemptCount = 0;

      async function* mockNext() {
        attemptCount++;
        throw new Error(`Attempt ${attemptCount} failed`);
      }

      const generator = retryMiddleware(ctx, mockNext);
      const results = [];

      for await (const chunk of generator) {
        results.push(chunk);
      }

      expect(attemptCount).toBe(3);
      expect(results.length).toBe(1);
    });

    it("should yield ErrorChunk after MAX_RETRIES", async () => {
      const ctx = createMockContext();

      async function* mockNext() {
        throw new Error("Always fails");
      }

      const generator = retryMiddleware(ctx, mockNext);
      const results = [];

      for await (const chunk of generator) {
        results.push(chunk);
      }

      expect(results.length).toBe(1);
      const errorChunk = results[0] as ErrorChunk;
      expect(errorChunk.type).toBe("error");
      expect(errorChunk.errors.length).toBe(3);
      expect(errorChunk.finalError).toBe(true);
    });
  });

  describe("ErrorChunk structure", () => {
    it("should include error info with attempt number", async () => {
      const ctx = createMockContext();

      async function* mockNext() {
        throw new Error("Test error");
      }

      const generator = retryMiddleware(ctx, mockNext);
      const results = [];

      for await (const chunk of generator) {
        results.push(chunk);
      }

      const errorChunk = results[0] as ErrorChunk;
      expect(errorChunk.errors[0]?.attempt).toBe(1);
      expect(errorChunk.errors[0]?.message).toBe("Test error");
      expect(errorChunk.errors[0]?.timestamp).toBeDefined();
    });

    it("should include stack trace if available", async () => {
      const ctx = createMockContext();

      async function* mockNext() {
        const error = new Error("Test error with stack");
        throw error;
      }

      const generator = retryMiddleware(ctx, mockNext);
      const results = [];

      for await (const chunk of generator) {
        results.push(chunk);
      }

      const errorChunk = results[0] as ErrorChunk;
      expect(errorChunk.errors[0]?.stack).toBeDefined();
    });

    it("should handle non-Error objects", async () => {
      const ctx = createMockContext();

      async function* mockNext() {
        throw "String error";
      }

      const generator = retryMiddleware(ctx, mockNext);
      const results = [];

      for await (const chunk of generator) {
        results.push(chunk);
      }

      const errorChunk = results[0] as ErrorChunk;
      expect(errorChunk.errors[0]?.message).toBe("String error");
      expect(errorChunk.errors[0]?.stack).toBeUndefined();
    });
  });

  describe("retry delay", () => {
    it("should delay between retries", async () => {
      const ctx = createMockContext();
      const delays: number[] = [];

      vi.spyOn(global, "setTimeout").mockImplementation((fn: any, ms?: number) => {
        if (ms) delays.push(ms);
        fn();
        return {} as any;
      });

      let attemptCount = 0;

      async function* mockNext() {
        attemptCount++;
        if (attemptCount < 3) {
          throw new Error("Retry needed");
        }
        yield { type: "staged", content: "success" };
      }

      const generator = retryMiddleware(ctx, mockNext);

      for await (const _ of generator) {
        // consume generator
      }

      // RETRY_DELAY_MS = 1000
      expect(delays.length).toBe(2);
      expect(delays[0]).toBe(1000);
      expect(delays[1]).toBe(1000);

      vi.restoreAllMocks();
    });

    it("should not delay on last attempt", async () => {
      const ctx = createMockContext();
      const delays: number[] = [];

      vi.spyOn(global, "setTimeout").mockImplementation((fn: any, ms?: number) => {
        if (ms) delays.push(ms);
        fn();
        return {} as any;
      });

      async function* mockNext() {
        throw new Error("Always fails");
      }

      const generator = retryMiddleware(ctx, mockNext);

      for await (const _ of generator) {
        // consume generator
      }

      // Only delay between attempts, not after last
      expect(delays.length).toBe(2);

      vi.restoreAllMocks();
    });
  });
});