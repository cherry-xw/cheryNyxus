import { describe, it, expect, vi, beforeEach } from "vitest";
import { chunkMiddleware, type StreamChunk, type StagedChunk } from "@/agent/middleware/chunk";
import { createHistoryProxy } from "@/core/middleware/utils";

// 创建完整的 Mock 上下文
function createMockContext(stream: boolean) {
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
      stream,
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
        extractStreamDelta: vi.fn((chunk: any) => chunk.choices?.[0]?.delta?.content ?? ""),
        extractStreamThinking: vi.fn((chunk: any) => chunk.choices?.[0]?.delta?.thinking ?? undefined),
        buildMessages: vi.fn(),
      },
      toolAdapter: {
        buildTools: vi.fn(() => []),
        buildToolCallMessage: vi.fn(),
        buildToolResponseMessage: vi.fn(),
        assembleToolCallChunks: vi.fn((chunks: any) => ({
          choices: [{ message: { tool_calls: chunks } }],
        })),
        extractToolCalls: vi.fn((raw: any) => {
          if (raw.choices?.[0]?.message?.tool_calls) {
            return [{ tid: "tc-1", name: "test_tool", arguments: "{}" }];
          }
          return [];
        }),
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

describe("chunkMiddleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("stream mode", () => {
    it("should accumulate content delta", async () => {
      const ctx = createMockContext(true);

      async function* mockNext() {
        yield {
          type: "stream",
          thinkingDelta: "",
          contentDelta: "",
          thinkingAccumulated: "",
          contentAccumulated: "",
          raw: { choices: [{ delta: { content: "Hello" } }] },
        };
        yield {
          type: "stream",
          thinkingDelta: "",
          contentDelta: "",
          thinkingAccumulated: "",
          contentAccumulated: "",
          raw: { choices: [{ delta: { content: " World" } }] },
        };
      }

      const generator = chunkMiddleware(ctx, mockNext);
      const results = [];

      for await (const chunk of generator) {
        results.push(chunk);
      }

      expect(ctx.process.contentAccumulated).toBe("Hello World");
    });

    it("should accumulate thinking delta", async () => {
      const ctx = createMockContext(true);

      async function* mockNext() {
        yield {
          type: "stream",
          thinkingDelta: "",
          contentDelta: "",
          thinkingAccumulated: "",
          contentAccumulated: "",
          raw: { choices: [{ delta: { thinking: "Thinking..." } }] },
        };
      }

      const generator = chunkMiddleware(ctx, mockNext);
      for await (const chunk of generator) {
        // consume generator
      }

      expect(ctx.process.thinkingAccumulated).toContain("Thinking...");
    });

    it("should yield StreamChunk with assembled data", async () => {
      const ctx = createMockContext(true);

      async function* mockNext() {
        yield {
          type: "stream",
          thinkingDelta: "",
          contentDelta: "",
          thinkingAccumulated: "",
          contentAccumulated: "",
          raw: { choices: [{ delta: { content: "test" } }] },
        };
      }

      const generator = chunkMiddleware(ctx, mockNext);
      const results = [];

      for await (const chunk of generator) {
        results.push(chunk);
      }

      const streamChunk = results.find((r: any) => r.type === "stream") as StreamChunk;
      expect(streamChunk).toBeDefined();
      expect(streamChunk.contentDelta).toBe("test");
      expect(streamChunk.contentAccumulated).toBe("test");
    });

    it("should yield StagedChunk at end", async () => {
      const ctx = createMockContext(true);

      async function* mockNext() {
        yield {
          type: "stream",
          thinkingDelta: "",
          contentDelta: "",
          thinkingAccumulated: "",
          contentAccumulated: "",
          raw: { choices: [{ delta: { content: "test" } }] },
        };
      }

      const generator = chunkMiddleware(ctx, mockNext);
      const results = [];

      for await (const chunk of generator) {
        results.push(chunk);
      }

      const stagedChunk = results[results.length - 1] as StagedChunk;
      expect(stagedChunk.type).toBe("staged");
      expect(stagedChunk.content).toBe("test");
    });

    it("should increment chunkCount", async () => {
      const ctx = createMockContext(true);

      async function* mockNext() {
        yield {
          type: "stream",
          thinkingDelta: "",
          contentDelta: "",
          thinkingAccumulated: "",
          contentAccumulated: "",
          raw: { choices: [{ delta: { content: "chunk1" } }] },
        };
        yield {
          type: "stream",
          thinkingDelta: "",
          contentDelta: "",
          thinkingAccumulated: "",
          contentAccumulated: "",
          raw: { choices: [{ delta: { content: "chunk2" } }] },
        };
      }

      const generator = chunkMiddleware(ctx, mockNext);
      for await (const chunk of generator) {
        // consume generator
      }

      expect(ctx.process.chunkCount).toBe(2);
    });

    it("should trim accumulated content at end", async () => {
      const ctx = createMockContext(true);

      async function* mockNext() {
        yield {
          type: "stream",
          thinkingDelta: "",
          contentDelta: "",
          thinkingAccumulated: "",
          contentAccumulated: "",
          raw: { choices: [{ delta: { content: "test " } }] },
        };
      }

      const generator = chunkMiddleware(ctx, mockNext);
      for await (const chunk of generator) {
        // consume generator
      }

      expect(ctx.process.contentAccumulated).toBe("test");
    });
  });

  describe("non-stream mode", () => {
    it("should pass through chunks without accumulation", async () => {
      const ctx = createMockContext(false);

      async function* mockNext() {
        yield { type: "staged", content: "response", raw: { choices: [{ message: {} }] } };
      }

      const generator = chunkMiddleware(ctx, mockNext);
      const results = [];

      for await (const chunk of generator) {
        results.push(chunk);
      }

      expect(results.length).toBe(1);
      expect(results[0]).toEqual({ type: "staged", content: "response", raw: { choices: [{ message: {} }] } });
    });
  });

  describe("empty content handling", () => {
    it("should handle stream chunks without content delta", async () => {
      const ctx = createMockContext(true);

      async function* mockNext() {
        yield {
          type: "stream",
          thinkingDelta: "",
          contentDelta: "",
          thinkingAccumulated: "",
          contentAccumulated: "",
          raw: { choices: [{ delta: {} }] },
        };
      }

      const generator = chunkMiddleware(ctx, mockNext);
      for await (const chunk of generator) {
        // consume generator
      }

      expect(ctx.process.contentAccumulated).toBe("");
    });
  });
});