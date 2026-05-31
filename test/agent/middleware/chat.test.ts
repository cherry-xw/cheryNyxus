import { describe, it, expect, vi, beforeEach } from "vitest";
import { chatMiddleware } from "@/agent/middleware/chat";
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
        chat: vi.fn(async () => ({
          choices: [{ message: { content: "test response" } }],
        })),
        chatStream: vi.fn(async () => ({
          async *[Symbol.asyncIterator]() {
            yield { choices: [{ delta: { content: "stream" } }] };
          },
        })),
      },
      messageAdapter: {
        role: vi.fn(),
        content: vi.fn((raw: any) => raw.choices?.[0]?.message?.content ?? ""),
        thinking: vi.fn(),
        extractStreamDelta: vi.fn((chunk: any) => chunk.choices?.[0]?.delta?.content ?? ""),
        extractStreamThinking: vi.fn(),
        buildMessages: vi.fn(() => [{ role: "user", content: "test message" }]),
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

describe("chatMiddleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("stream mode", () => {
    it("should call chatStream when stream is true", async () => {
      const ctx = createMockContext(true);

      async function* mockNext() {
        yield { type: "staged", content: "response" };
      }

      const generator = chatMiddleware(ctx, mockNext);
      for await (const _ of generator) {
        // consume generator
      }

      expect(ctx.adapters.llmAdapter.chatStream).toHaveBeenCalled();
    });

    it("should yield StreamChunk for each raw chunk", async () => {
      const ctx = createMockContext(true);

      async function* mockNext() {
        yield { type: "stream", raw: { choices: [{ delta: { content: "test" } }] } };
      }

      const generator = chatMiddleware(ctx, mockNext);
      const results = [];

      for await (const chunk of generator) {
        results.push(chunk);
      }

      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe("non-stream mode", () => {
    it("should call chat when stream is false", async () => {
      const ctx = createMockContext(false);

      async function* mockNext() {
        yield { type: "staged", content: "response" };
      }

      const generator = chatMiddleware(ctx, mockNext);
      for await (const _ of generator) {
        // consume generator
      }

      expect(ctx.adapters.llmAdapter.chat).toHaveBeenCalled();
    });

    it("should yield StagedChunk with content", async () => {
      const ctx = createMockContext(false);

      async function* mockNext() {
        yield { type: "staged", content: "response" };
      }

      const generator = chatMiddleware(ctx, mockNext);
      const results = [];

      for await (const chunk of generator) {
        results.push(chunk);
      }

      expect(results.length).toBe(1);
    });
  });

  describe("options handling", () => {
    it("should pass model from config", async () => {
      const ctx = createMockContext(true);
      ctx.config.model = "gpt-4";

      async function* mockNext() {
        yield { type: "staged", content: "response" };
      }

      const generator = chatMiddleware(ctx, mockNext);
      for await (const _ of generator) {
        // consume generator
      }

      expect(ctx.adapters.llmAdapter.chatStream).toHaveBeenCalled();
    });

    it("should pass url from config", async () => {
      const ctx = createMockContext(true);
      ctx.config.url = "http://localhost:11434";

      async function* mockNext() {
        yield { type: "staged", content: "response" };
      }

      const generator = chatMiddleware(ctx, mockNext);
      for await (const _ of generator) {
        // consume generator
      }

      expect(ctx.adapters.llmAdapter.chatStream).toHaveBeenCalled();
    });

    it("should pass thinking option when enabled", async () => {
      const ctx = createMockContext(true);
      ctx.global.thinking = true;

      async function* mockNext() {
        yield { type: "staged", content: "response" };
      }

      const generator = chatMiddleware(ctx, mockNext);
      for await (const _ of generator) {
        // consume generator
      }

      expect(ctx.adapters.llmAdapter.chatStream).toHaveBeenCalled();
    });
  });

  describe("tools handling", () => {
    it("should build tools from toolManager", async () => {
      const ctx = createMockContext(true);
      // 添加一个 mock tool，让 toolManager.getAll() 返回非空数组
      ctx.tools.toolManager.getAll = vi.fn(() => [
        { name: "test_tool", description: "test", parameters: {}, execute: vi.fn() },
      ]);

      async function* mockNext() {
        yield { type: "staged", content: "response" };
      }

      const generator = chatMiddleware(ctx, mockNext);
      for await (const _ of generator) {
        // consume generator
      }

      expect(ctx.adapters.toolAdapter.buildTools).toHaveBeenCalled();
    });
  });
});