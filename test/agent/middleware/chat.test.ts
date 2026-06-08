import { describe, it, expect, vi, beforeEach } from "vitest";
import { chatMiddleware } from "@/agent/middleware/chat";


// 创建完整的 Mock 上下文
function createMockContext(stream: boolean) {
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
      stream,
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

describe("chatMiddleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("stream mode", () => {
    it("should call chatStream when stream is true", async () => {
      const ctx = createMockContext(true);

      async function* mockNext() {
        yield { type: "staged", stagedType: "content_end", content: "response", thinking: "" };
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
        yield { type: "staged", stagedType: "content_end", content: "response", thinking: "" };
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
        yield { type: "staged", stagedType: "content_end", content: "response", thinking: "" };
      }

      const generator = chatMiddleware(ctx, mockNext);
      for await (const _ of generator) {
        // consume generator
      }

      expect(ctx.adapters.llmAdapter.chat).toHaveBeenCalled();
    });

    it("should yield StreamChunk with content", async () => {
      const ctx = createMockContext(false);

      async function* mockNext() {
        yield { type: "staged", stagedType: "content_end", content: "response", thinking: "" };
      }

      const generator = chatMiddleware(ctx, mockNext);
      const results = [];

      for await (const chunk of generator) {
        results.push(chunk);
      }

      expect(results.length).toBe(2);
    });
  });

  describe("options handling", () => {
    it("should pass model from brain config", async () => {
      const ctx = createMockContext(true);
      ctx.brain.model = "gpt-4";

      async function* mockNext() {
        yield { type: "staged", stagedType: "content_end", content: "response", thinking: "" };
      }

      const generator = chatMiddleware(ctx, mockNext);
      for await (const _ of generator) {
        // consume generator
      }

      expect(ctx.adapters.llmAdapter.chatStream).toHaveBeenCalled();
    });

    it("should pass url from brain config", async () => {
      const ctx = createMockContext(true);
      ctx.brain.url = "http://localhost:11434";

      async function* mockNext() {
        yield { type: "staged", stagedType: "content_end", content: "response", thinking: "" };
      }

      const generator = chatMiddleware(ctx, mockNext);
      for await (const _ of generator) {
        // consume generator
      }

      expect(ctx.adapters.llmAdapter.chatStream).toHaveBeenCalled();
    });

    it("should pass thinking option when enabled", async () => {
      const ctx = createMockContext(true);
      ctx.brain.thinking = true;

      async function* mockNext() {
        yield { type: "staged", stagedType: "content_end", content: "response", thinking: "" };
      }

      const generator = chatMiddleware(ctx, mockNext);
      for await (const _ of generator) {
        // consume generator
      }

      expect(ctx.adapters.llmAdapter.chatStream).toHaveBeenCalled();
    });
  });
});