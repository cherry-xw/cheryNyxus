import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { retryMiddleware } from "@/agent/middleware/retry";
import type { ErrorChunk } from "@/core/middleware/types";


// 创建完整的 Mock 上下文
function createMockContext() {
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
      senseAdapter: {
        buildSenses: vi.fn(() => []),
        extractSenseCallDeltas: vi.fn(() => []),
        senseCalls: vi.fn(() => []),
      },
    },
    senseManager: {
      add: vi.fn(),
      getAll: vi.fn(() => []),
      get: vi.fn(),
      execute: vi.fn(),
    },
  } as any;
}

describe("retryMiddleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
    it("should retry on recoverable error (network)", async () => {
      const ctx = createMockContext();
      let attemptCount = 0;

      async function* mockNext() {
        attemptCount++;
        if (attemptCount === 1) {
          throw new Error("Network connection failed");
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

    it("should retry on timeout error", async () => {
      const ctx = createMockContext();
      let attemptCount = 0;

      async function* mockNext() {
        attemptCount++;
        if (attemptCount === 1) {
          throw new Error("Request timed out");
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

    it("should not retry on validation error (non-recoverable)", async () => {
      const ctx = createMockContext();
      let attemptCount = 0;

      async function* mockNext() {
        attemptCount++;
        throw new Error("Invalid schema validation");
      }

      const generator = retryMiddleware(ctx, mockNext);
      const results = [];

      for await (const chunk of generator) {
        results.push(chunk);
      }

      // Non-recoverable error should not retry
      expect(attemptCount).toBe(1);
      expect(results.length).toBe(1);
      const errorChunk = results[0] as ErrorChunk;
      expect(errorChunk.type).toBe("error");
      expect(errorChunk.errors.length).toBe(1);
    });

    it("should retry MAX_RETRIES times for recoverable errors", async () => {
      const ctx = createMockContext();
      let attemptCount = 0;

      async function* mockNext() {
        attemptCount++;
        throw new Error(`Network connection attempt ${attemptCount} failed`);
      }

      const generator = retryMiddleware(ctx, mockNext);
      const results = [];

      for await (const chunk of generator) {
        results.push(chunk);
      }

      expect(attemptCount).toBe(3);
      expect(results.length).toBe(1);
    });

    it("should yield ErrorChunk after MAX_RETRIES exhausted", async () => {
      const ctx = createMockContext();

      async function* mockNext() {
        throw new Error("Network timeout always fails");
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
    });
  });

  describe("ErrorChunk structure", () => {
    it("should include error info with attempt number", async () => {
      const ctx = createMockContext();

      async function* mockNext() {
        throw new Error("Test network error");
      }

      const generator = retryMiddleware(ctx, mockNext);
      const results = [];

      for await (const chunk of generator) {
        results.push(chunk);
      }

      const errorChunk = results[0] as ErrorChunk;
      expect(errorChunk.errors[0]?.attempt).toBe(1);
      expect(errorChunk.errors[0]?.message).toBe("Test network error");
      expect(errorChunk.errors[0]?.timestamp).toBeDefined();
    });

    it("should include stack trace if available", async () => {
      const ctx = createMockContext();

      async function* mockNext() {
        const error = new Error("Network error with stack");
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
        throw "String network error";
      }

      const generator = retryMiddleware(ctx, mockNext);
      const results = [];

      for await (const chunk of generator) {
        results.push(chunk);
      }

      const errorChunk = results[0] as ErrorChunk;
      expect(errorChunk.errors[0]?.message).toBe("String network error");
      expect(errorChunk.errors[0]?.stack).toBeUndefined();
    });

    it("should classify error category correctly", async () => {
      const ctx = createMockContext();

      async function* mockNext() {
        throw new Error("ECONNREFUSED connection refused");
      }

      const generator = retryMiddleware(ctx, mockNext);
      const results = [];

      for await (const chunk of generator) {
        results.push(chunk);
      }

      const errorChunk = results[0] as ErrorChunk;
      expect(errorChunk.errors[0]?.category).toBe("network");
      expect(errorChunk.errors[0]?.recoverable).toBe(true);
    });
  });

  describe("retry delay", () => {
    it("should delay between retries for recoverable errors", async () => {
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
          throw new Error("Network retry needed");
        }
        yield { type: "staged", content: "success" };
      }

      const generator = retryMiddleware(ctx, mockNext);

      for await (const _ of generator) {
        // consume generator
      }

      // RETRY_DELAY_MS = 1000, only delay between attempts (not before first)
      expect(delays.length).toBe(2);
      expect(delays[0]).toBe(1000);
      expect(delays[1]).toBe(1000);

      vi.restoreAllMocks();
    });

    it("should not delay for non-recoverable errors", async () => {
      const ctx = createMockContext();
      const delays: number[] = [];

      vi.spyOn(global, "setTimeout").mockImplementation((fn: any, ms?: number) => {
        if (ms) delays.push(ms);
        fn();
        return {} as any;
      });

      async function* mockNext() {
        throw new Error("Validation error invalid schema");
      }

      const generator = retryMiddleware(ctx, mockNext);

      for await (const _ of generator) {
        // consume generator
      }

      // Non-recoverable errors don't trigger retry delay
      expect(delays.length).toBe(0);

      vi.restoreAllMocks();
    });
  });
});