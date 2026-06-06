import { describe, it, expect, vi, beforeEach } from "vitest";
import { senseMiddleware } from "@/agent/middleware/tool.js";
import { SupervisionLevel } from "@/core/config";

import type { MiddlewareContext, StreamChunk, SenseTriggerChunk, SenseCompleteChunk } from "@/core/middleware/types";
import type { SenseManager, SenseFunction } from "@/core/sense/index";
import type { LLMAdapter, MessageProviderAdapterConfig, SenseAdapter } from "@/core/index.js";

function createMockSenseManager(): SenseManager {
  return {
    add: vi.fn(),
    get: vi.fn(),
    execute: vi.fn(async () => ({ content: "sense result", hash: "test-hash" })),
    senses: new Map(),
  } as unknown as SenseManager;
}

function createMockContext(overrides?: Partial<MiddlewareContext>): MiddlewareContext {
  const senseManager = createMockSenseManager();
  return {
    soul: {
      soulId: "test-soul",
      chatId: "test-chat",
      hashCheck: new Map(),
      senseSharedData: new Map(),
      userInputs: [],
      builtSenses: [],
    },
    global: {
      thinking: false,
      supervision: SupervisionLevel.auto,
      stream: true,
      maxLoopCount: 10,
    },
    brain: {
      model: "test-model",
      provider: "test",
      url: "http://localhost",
    },
    adapters: {
      llmAdapter: {} as LLMAdapter,
      messageAdapter: {} as MessageProviderAdapterConfig,
      senseAdapter: {} as SenseAdapter<unknown, unknown>,
    },
    senseManager,
    ...overrides,
  };
}

function createStreamChunk(deltas?: { id?: string; name?: string; arguments?: string; index?: number }[]): StreamChunk {
  return {
    type: "stream",
    thinkingDelta: "",
    contentDelta: "",
    senseDelta: deltas?.map((d, i) => ({
      index: d.index ?? i,
      id: d.id ?? `tc-${i}`,
      name: d.name ?? "test_sense",
      arguments: d.arguments ?? "{}",
    })),
  };
}

const mockSenseDef = {
  definition: {
    type: "function" as const,
    function: {
      name: "test_sense",
      description: "test",
      parameters: { type: "object" as const, properties: {}, required: [] as string[], additionalProperties: false },
    },
  },
  supervisionLevel: SupervisionLevel.auto,
  executor: {},
};

describe("senseMiddleware", () => {
  describe("middleware execution", () => {
    it("should pass through non-stream chunks", async () => {
      const ctx = createMockContext();
      const next = vi.fn(async function* () {
        yield { type: "done" };
      });

      const generator = senseMiddleware(ctx, next);
      const chunks: unknown[] = [];
      for await (const chunk of generator) {
        chunks.push(chunk);
      }

      expect(next).toHaveBeenCalled();
      expect(chunks).toContainEqual({ type: "done" });
    });

    it("should pass through stream chunks without senseDelta", async () => {
      const ctx = createMockContext();
      const next = vi.fn(async function* () {
        yield { type: "stream", thinkingDelta: "think", contentDelta: "content" };
        yield { type: "done" };
      });

      const generator = senseMiddleware(ctx, next);
      const chunks: unknown[] = [];
      for await (const chunk of generator) {
        chunks.push(chunk);
      }

      expect(chunks.length).toBe(2);
      expect((chunks[0] as StreamChunk).contentDelta).toBe("content");
    });

    it("should execute sense call when senseDelta is complete", async () => {
      const ctx = createMockContext();
      ctx.senseManager.get = vi.fn(() => mockSenseDef as unknown as SenseFunction);

      const next = vi.fn(async function* () {
        yield createStreamChunk([{ id: "tc-1", name: "test_sense", arguments: "{}" }]);
        yield { type: "done" };
      });

      const generator = senseMiddleware(ctx, next);
      const chunks: unknown[] = [];
      for await (const chunk of generator) {
        chunks.push(chunk);
      }

      // Should yield: stream, sense_trigger, sense_complete, done
      const triggerChunks = chunks.filter((c) => (c as SenseTriggerChunk).type === "sense_trigger");
      const completeChunks = chunks.filter((c) => (c as SenseCompleteChunk).type === "sense_complete");

      expect(triggerChunks.length).toBe(1);
      expect(completeChunks.length).toBe(1);
      expect(ctx.senseManager.execute).toHaveBeenCalled();
    });

    it("should accumulate senseDelta across multiple chunks", async () => {
      const ctx = createMockContext();
      ctx.senseManager.get = vi.fn(() => mockSenseDef as unknown as SenseFunction);

      const next = vi.fn(async function* () {
        // First chunk with partial arguments
        yield {
          type: "stream",
          thinkingDelta: "",
          contentDelta: "",
          senseDelta: [{ index: 0, id: "tc-1", name: "test_sense", arguments: '{"a":' }],
        };
        // Second chunk completing the arguments
        yield {
          type: "stream",
          thinkingDelta: "",
          contentDelta: "",
          senseDelta: [{ index: 0, arguments: '1}' }],
        };
        yield { type: "done" };
      });

      const generator = senseMiddleware(ctx, next);
      const chunks: unknown[] = [];
      for await (const chunk of generator) {
        chunks.push(chunk);
      }

      const completeChunks = chunks.filter((c) => (c as SenseCompleteChunk).type === "sense_complete");
      expect(completeChunks.length).toBe(1);
    });

    it("should handle multiple sense calls", async () => {
      const ctx = createMockContext();
      ctx.senseManager.get = vi.fn(() => mockSenseDef as unknown as SenseFunction);

      const next = vi.fn(async function* () {
        yield createStreamChunk([
          { id: "tc-1", name: "sense_a", arguments: "{}", index: 0 },
          { id: "tc-2", name: "sense_b", arguments: "{}", index: 1 },
        ]);
        yield { type: "done" };
      });

      const generator = senseMiddleware(ctx, next);
      const chunks: unknown[] = [];
      for await (const chunk of generator) {
        chunks.push(chunk);
      }

      const triggerChunks = chunks.filter((c) => (c as SenseTriggerChunk).type === "sense_trigger");
      const completeChunks = chunks.filter((c) => (c as SenseCompleteChunk).type === "sense_complete");

      expect(triggerChunks.length).toBe(2);
      expect(completeChunks.length).toBe(2);
    });
  });

  describe("supervision level behavior", () => {
    it("should auto execute when supervisionLevel is auto", async () => {
      const ctx = createMockContext();
      ctx.senseManager.get = vi.fn(() => ({
        ...mockSenseDef,
        supervisionLevel: SupervisionLevel.auto,
      }) as unknown as SenseFunction);

      const next = vi.fn(async function* () {
        yield createStreamChunk([{ id: "tc-1", name: "test_sense", arguments: "{}" }]);
        yield { type: "done" };
      });

      const generator = senseMiddleware(ctx, next);
      const chunks: unknown[] = [];
      for await (const chunk of generator) {
        chunks.push(chunk);
      }

      expect(ctx.senseManager.execute).toHaveBeenCalled();
      const completeChunks = chunks.filter((c) => (c as SenseCompleteChunk).type === "sense_complete");
      expect(completeChunks.length).toBe(1);
    });

    it("should yield sense_trigger with approvalResolve for confirm level", async () => {
      const ctx = createMockContext();
      ctx.senseManager.get = vi.fn(() => ({
        ...mockSenseDef,
        supervisionLevel: SupervisionLevel.confirm,
      }) as unknown as SenseFunction);

      const next = vi.fn(async function* () {
        yield createStreamChunk([{ id: "tc-1", name: "test_sense", arguments: "{}" }]);
        yield { type: "done" };
      });

      // Start the generator
      const generator = senseMiddleware(ctx, next);
      const chunks: unknown[] = [];

      // Iterate and collect chunks until we hit the sense_trigger (which blocks on approval)
      const iterator = generator[Symbol.asyncIterator]();
      let trigger: SenseTriggerChunk | null = null;

      // Collect all chunks - will block after sense_trigger until approval
      // Use Promise.race to detect when we're blocked
      const collectChunks = async () => {
        let result = await iterator.next();
        while (!result.done) {
          const chunk = result.value as { type: string };
          chunks.push(chunk);

          if (chunk.type === "sense_trigger") {
            trigger = chunk as SenseTriggerChunk;
            // Simulate approval to unblock the generator
            trigger.approvalResolve!("accept");
          }

          result = await iterator.next();
        }
      };

      await collectChunks();

      // Verify trigger was yielded with correct properties
      expect(trigger).not.toBeNull();
      expect(trigger!.supervisionLevel).toBe(SupervisionLevel.confirm);
      expect(trigger!.approvalResolve).toBeDefined();

      // Should have: stream, sense_trigger, sense_complete, done
      const completeChunks = chunks.filter((c) => (c as SenseCompleteChunk).type === "sense_complete");
      expect(completeChunks.length).toBe(1);
    });

    it("should handle reject action", async () => {
      const ctx = createMockContext();
      ctx.senseManager.get = vi.fn(() => ({
        ...mockSenseDef,
        supervisionLevel: SupervisionLevel.confirm,
      }) as unknown as SenseFunction);

      const next = vi.fn(async function* () {
        yield createStreamChunk([{ id: "tc-1", name: "test_sense", arguments: "{}" }]);
        yield { type: "done" };
      });

      const generator = senseMiddleware(ctx, next);
      const chunks: unknown[] = [];
      const iterator = generator[Symbol.asyncIterator]();

      // Iterate and handle trigger
      let result = await iterator.next();
      while (!result.done) {
        const chunk = result.value as { type: string };
        chunks.push(chunk);

        if (chunk.type === "sense_trigger") {
          const trigger = chunk as SenseTriggerChunk;
          // Reject the execution
          trigger.approvalResolve!("reject", "User rejected");
        }

        result = await iterator.next();
      }

      const completeChunks = chunks.filter((c) => (c as SenseCompleteChunk).type === "sense_complete");
      const complete = completeChunks[0] as SenseCompleteChunk;
      expect(complete.type).toBe("sense_complete");
      expect(complete.result).toBe("User rejected");
    });
  });

  describe("sense execution", () => {
    it("should skip duplicate hash", async () => {
      const ctx = createMockContext();
      ctx.soul.hashCheck.set("test-hash", "previous_sense");
      ctx.senseManager.get = vi.fn(() => mockSenseDef as unknown as SenseFunction);
      ctx.senseManager.execute = vi.fn(async () => ({ content: "result", hash: "test-hash" }));

      const next = vi.fn(async function* () {
        yield createStreamChunk([{ id: "tc-1", name: "test_sense", arguments: "{}" }]);
        yield { type: "done" };
      });

      const generator = senseMiddleware(ctx, next);
      const chunks: unknown[] = [];
      for await (const chunk of generator) {
        chunks.push(chunk);
      }

      const completeChunks = chunks.filter((c) => (c as SenseCompleteChunk).type === "sense_complete");
      const complete = completeChunks[0] as SenseCompleteChunk;
      expect(complete.result).toContain("已跳过");
    });

    it("should handle execution error", async () => {
      const ctx = createMockContext();
      ctx.senseManager.get = vi.fn(() => mockSenseDef as unknown as SenseFunction);
      ctx.senseManager.execute = vi.fn(async () => {
        throw new Error("execution failed");
      });

      const next = vi.fn(async function* () {
        yield createStreamChunk([{ id: "tc-1", name: "test_sense", arguments: "{}" }]);
        yield { type: "done" };
      });

      const generator = senseMiddleware(ctx, next);
      const chunks: unknown[] = [];
      for await (const chunk of generator) {
        chunks.push(chunk);
      }

      const completeChunks = chunks.filter((c) => (c as SenseCompleteChunk).type === "sense_complete");
      const complete = completeChunks[0] as SenseCompleteChunk;
      expect(complete.result).toContain("failed");
    });

    it("should store hash after successful execution", async () => {
      const ctx = createMockContext();
      ctx.senseManager.get = vi.fn(() => mockSenseDef as unknown as SenseFunction);
      ctx.senseManager.execute = vi.fn(async () => ({ content: "result", hash: "new-hash" }));

      const next = vi.fn(async function* () {
        yield createStreamChunk([{ id: "tc-1", name: "test_sense", arguments: "{}" }]);
        yield { type: "done" };
      });

      const generator = senseMiddleware(ctx, next);
      for await (const _ of generator) {
        // consume
      }

      expect(ctx.soul.hashCheck.has("new-hash")).toBe(true);
    });

    it("should handle empty hash (no dedup)", async () => {
      const ctx = createMockContext();
      ctx.senseManager.get = vi.fn(() => mockSenseDef as unknown as SenseFunction);
      ctx.senseManager.execute = vi.fn(async () => ({ content: "result", hash: "" }));

      const next = vi.fn(async function* () {
        yield createStreamChunk([{ id: "tc-1", name: "test_sense", arguments: "{}" }]);
        yield { type: "done" };
      });

      const generator = senseMiddleware(ctx, next);
      for await (const _ of generator) {
        // consume
      }

      expect(ctx.soul.hashCheck.size).toBe(0);
    });
  });
});