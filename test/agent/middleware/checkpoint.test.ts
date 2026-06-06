import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkpointMiddleware } from "@/agent/middleware/checkpoint";
import type { MiddlewareContext, MiddlewareChunk, StreamChunk, SenseTriggerChunk, SenseCompleteChunk } from "@/core/middleware/types";

// Mock checkpointRepo
vi.mock("@/db/checkpoint.js", () => ({
  checkpointRepo: {
    create: vi.fn(async () => {}),
    findLatest: vi.fn(async () => null),
    findBySoulId: vi.fn(async () => []),
    delete: vi.fn(async () => {}),
    cleanup: vi.fn(async () => {}),
  },
}));

// Mock randomUUID for consistent testing
vi.mock("crypto", () => ({
  randomUUID: vi.fn(() => "test-uuid-1234"),
}));

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

describe("checkpointMiddleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("userInputs 处理", () => {
    it("should convert userInputs to messages and yield consumed notification", async () => {
      const ctx = createMockContext({
        soul: {
          soulId: "test-soul",
          chatId: "test-chat",
          hashCheck: new Map(),
          senseSharedData: new Map(),
          userInputs: [{ content: "Hello", time: 1000 }],
          builtSenses: [],
          messages: [],
        },
      });

      async function* mockNext() {
        // No chunks
      }

      const results: MiddlewareChunk[] = [];
      for await (const chunk of checkpointMiddleware(ctx, mockNext)) {
        results.push(chunk);
      }

      // First chunk should be consumed notification
      expect(results[0]).toEqual({ type: "consumed", count: 1 });
      expect(ctx.soul.messages).toHaveLength(1);
      expect(ctx.soul.messages?.[0]).toMatchObject({
        role: "user",
        content: "Hello",
      });
    });

    it("should handle multiple userInputs", async () => {
      const ctx = createMockContext({
        soul: {
          soulId: "test-soul",
          chatId: "test-chat",
          hashCheck: new Map(),
          senseSharedData: new Map(),
          userInputs: [
            { content: "Hello", time: 1000 },
            { content: "World", time: 2000 },
          ],
          builtSenses: [],
          messages: [],
        },
      });

      async function* mockNext() {
        // No chunks
      }

      const results: MiddlewareChunk[] = [];
      for await (const chunk of checkpointMiddleware(ctx, mockNext)) {
        results.push(chunk);
      }

      expect(results[0]).toEqual({ type: "consumed", count: 2 });
      expect(ctx.soul.messages).toHaveLength(2);
    });

    it("should clear userInputs after processing", async () => {
      const ctx = createMockContext({
        soul: {
          soulId: "test-soul",
          chatId: "test-chat",
          hashCheck: new Map(),
          senseSharedData: new Map(),
          userInputs: [{ content: "Hello", time: 1000 }],
          builtSenses: [],
          messages: [],
        },
      });

      async function* mockNext() {
        // No chunks
      }

      for await (const _ of checkpointMiddleware(ctx, mockNext)) {
        // consume
      }

      expect(ctx.soul.userInputs).toHaveLength(0);
    });
  });

  describe("stream chunk 处理", () => {
    it("should yield stream chunks from inner handlers", async () => {
      const ctx = createMockContext();

      async function* mockNext() {
        yield { type: "stream", thinkingDelta: "thinking...", contentDelta: "" } as StreamChunk;
        yield { type: "stream", thinkingDelta: "", contentDelta: "response" } as StreamChunk;
      }

      const results: MiddlewareChunk[] = [];
      for await (const chunk of checkpointMiddleware(ctx, mockNext)) {
        results.push(chunk);
      }

      const streamChunks = results.filter((c) => c.type === "stream");
      expect(streamChunks).toHaveLength(2);
    });

    it("should accumulate thinking and content deltas", async () => {
      const ctx = createMockContext();

      async function* mockNext() {
        yield { type: "stream", thinkingDelta: "think", contentDelta: "" } as StreamChunk;
        yield { type: "stream", thinkingDelta: "ing", contentDelta: "" } as StreamChunk;
        yield { type: "stream", thinkingDelta: "", contentDelta: "hello" } as StreamChunk;
        yield { type: "stream", thinkingDelta: "", contentDelta: " world" } as StreamChunk;
      }

      const results: MiddlewareChunk[] = [];
      for await (const chunk of checkpointMiddleware(ctx, mockNext)) {
        results.push(chunk);
      }

      // Check staged chunks have accumulated content
      const stagedChunks = results.filter((c) => c.type === "staged");
      expect(stagedChunks.length).toBeGreaterThan(0);
    });
  });

  describe("thinking/content 边界检测", () => {
    it("should yield thinking staged when contentDelta appears after thinking", async () => {
      const ctx = createMockContext();

      async function* mockNext() {
        yield { type: "stream", thinkingDelta: "thinking", contentDelta: "" } as StreamChunk;
        yield { type: "stream", thinkingDelta: "", contentDelta: "content" } as StreamChunk;
      }

      const results: MiddlewareChunk[] = [];
      for await (const chunk of checkpointMiddleware(ctx, mockNext)) {
        results.push(chunk);
      }

      // Should have thinking staged
      const thinkingStaged = results.find(
        (c) => c.type === "staged" && "thinking" in c && c.thinking === "thinking"
      );
      expect(thinkingStaged).toBeDefined();
    });

    it("should not yield thinking staged when no thinking accumulated", async () => {
      const ctx = createMockContext();

      async function* mockNext() {
        yield { type: "stream", thinkingDelta: "", contentDelta: "content" } as StreamChunk;
      }

      const results: MiddlewareChunk[] = [];
      for await (const chunk of checkpointMiddleware(ctx, mockNext)) {
        results.push(chunk);
      }

      // Should have only one staged at end (content staged)
      const stagedChunks = results.filter((c) => c.type === "staged");
      expect(stagedChunks).toHaveLength(1);
      expect((stagedChunks[0] as any).content).toBe("content");
    });

    it("should yield content staged at the end", async () => {
      const ctx = createMockContext();

      async function* mockNext() {
        yield { type: "stream", thinkingDelta: "thinking", contentDelta: "" } as StreamChunk;
        yield { type: "stream", thinkingDelta: "", contentDelta: "content" } as StreamChunk;
      }

      const results: MiddlewareChunk[] = [];
      for await (const chunk of checkpointMiddleware(ctx, mockNext)) {
        results.push(chunk);
      }

      // Last staged should have content
      const stagedChunks = results.filter((c) => c.type === "staged");
      const lastStaged = stagedChunks[stagedChunks.length - 1];
      expect((lastStaged as any).content).toBe("content");
    });
  });

  describe("sense_trigger 和 sense_complete 处理", () => {
    it("should pass through sense_trigger chunks", async () => {
      const ctx = createMockContext();

      async function* mockNext() {
        yield {
          type: "sense_trigger",
          id: "sense-1",
          name: "execute_command",
          arguments: '{"cmd": "ls"}',
          supervisionLevel: 0,
        } as SenseTriggerChunk;
      }

      const results: MiddlewareChunk[] = [];
      for await (const chunk of checkpointMiddleware(ctx, mockNext)) {
        results.push(chunk);
      }

      const triggerChunks = results.filter((c) => c.type === "sense_trigger");
      expect(triggerChunks).toHaveLength(1);
    });

    it("should pass through sense_complete chunks", async () => {
      const ctx = createMockContext();

      async function* mockNext() {
        yield {
          type: "sense_trigger",
          id: "sense-1",
          name: "execute_command",
          arguments: '{"cmd": "ls"}',
          supervisionLevel: 0,
        } as SenseTriggerChunk;
        yield {
          type: "sense_complete",
          id: "sense-1",
          name: "execute_command",
          result: "file1.txt\nfile2.txt",
        } as SenseCompleteChunk;
      }

      const results: MiddlewareChunk[] = [];
      for await (const chunk of checkpointMiddleware(ctx, mockNext)) {
        results.push(chunk);
      }

      const completeChunks = results.filter((c) => c.type === "sense_complete");
      expect(completeChunks).toHaveLength(1);
    });
  });

  describe("messages 追加", () => {
    it("should append assistant message with content", async () => {
      const ctx = createMockContext({
        soul: {
          soulId: "test-soul",
          chatId: "test-chat",
          hashCheck: new Map(),
          senseSharedData: new Map(),
          userInputs: [],
          builtSenses: [],
          messages: [],
        },
      });

      async function* mockNext() {
        yield { type: "stream", thinkingDelta: "", contentDelta: "hello world" } as StreamChunk;
      }

      for await (const _ of checkpointMiddleware(ctx, mockNext)) {
        // consume
      }

      // Should have assistant message with content
      const assistantMsg = ctx.soul.messages?.find((m) => m.role === "assistant");
      expect(assistantMsg).toBeDefined();
      expect((assistantMsg as any).content).toBe("hello world");
    });

    it("should append sense result message", async () => {
      const ctx = createMockContext({
        soul: {
          soulId: "test-soul",
          chatId: "test-chat",
          hashCheck: new Map(),
          senseSharedData: new Map(),
          userInputs: [],
          builtSenses: [],
          messages: [],
        },
      });

      async function* mockNext() {
        // Need content to trigger message append
        yield { type: "stream", thinkingDelta: "", contentDelta: "I will run a command" } as StreamChunk;
        yield {
          type: "sense_trigger",
          id: "sense-1",
          name: "execute_command",
          arguments: '{"cmd": "ls"}',
          supervisionLevel: 0,
        } as SenseTriggerChunk;
        yield {
          type: "sense_complete",
          id: "sense-1",
          name: "execute_command",
          result: "file1.txt",
        } as SenseCompleteChunk;
      }

      for await (const _ of checkpointMiddleware(ctx, mockNext)) {
        // consume
      }

      // Should have sense message
      const senseMsg = ctx.soul.messages?.find((m) => m.role === "sense");
      expect(senseMsg).toBeDefined();
      expect((senseMsg as any).content).toBe("file1.txt");
    });
  });

  describe("checkpoint 持久化", () => {
    it("should persist checkpoint after processing", async () => {
      const { checkpointRepo } = await import("@/db/checkpoint.js");

      const ctx = createMockContext();

      async function* mockNext() {
        yield { type: "stream", thinkingDelta: "", contentDelta: "test" } as StreamChunk;
      }

      for await (const _ of checkpointMiddleware(ctx, mockNext)) {
        // consume
      }

      expect(checkpointRepo.create).toHaveBeenCalled();
      const createArg = (checkpointRepo.create as any).mock.calls[0][0];
      expect(createArg.soulId).toBe("test-soul");
      expect(createArg.chatId).toBe("test-chat");
      expect(createArg.phase).toBe("complete");
    });
  });

  describe("done chunk", () => {
    it("should yield done chunk at the end", async () => {
      const ctx = createMockContext();

      async function* mockNext() {
        yield { type: "stream", thinkingDelta: "", contentDelta: "test" } as StreamChunk;
      }

      const results: MiddlewareChunk[] = [];
      for await (const chunk of checkpointMiddleware(ctx, mockNext)) {
        results.push(chunk);
      }

      const lastChunk = results[results.length - 1];
      expect(lastChunk.type).toBe("done");
    });
  });

  describe("空消息处理", () => {
    it("should not append assistant message when no content", async () => {
      const ctx = createMockContext({
        soul: {
          soulId: "test-soul",
          chatId: "test-chat",
          hashCheck: new Map(),
          senseSharedData: new Map(),
          userInputs: [],
          builtSenses: [],
          messages: [],
        },
      });

      async function* mockNext() {
        // No chunks
      }

      for await (const _ of checkpointMiddleware(ctx, mockNext)) {
        // consume
      }

      // Should not have any messages (no user input, no response)
      expect(ctx.soul.messages).toHaveLength(0);
    });
  });
});