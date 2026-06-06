import { describe, it, expect, vi, beforeEach } from "vitest";
import { messageMiddleware } from "@/agent/middleware/message";

import type { LLMResponse } from "@/core/message/index";

// 创建完整的 Mock 上下文
function createMockContext() {
  return {
    session: {
      sessionId: "test-session",
      threadId: "test-thread",
      hashCheck: new Map(),
      senseSharedData: new Map(),
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
        buildTools: vi.fn(() => []),
        buildSenseCallMessage: vi.fn(),
        buildToolResponseMessage: vi.fn(),
        extractSenseCalls: vi.fn(() => []),
        assembleSenseCallChunks: vi.fn(() => []),
      },
    },
    process: {
      history: [],
      contentAccumulated: "",
      thinkingAccumulated: "",
      chunkCount: 0,
      toolCallAccumulated: new Map(),
      pendingInputs: [],
    },
    senses: {
      senseManager: {
        add: vi.fn(),
        getAll: vi.fn(() => []),
        get: vi.fn(),
        execute: vi.fn(),
        getAdapter: vi.fn(),
      },
    },
  } as any;
}

describe("messageMiddleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("消息累积", () => {
    it("should accumulate messages in history", async () => {
      const ctx = createMockContext();

      async function* mockNext() {
        yield { type: "staged", content: "response" };
      }

      const generator = messageMiddleware(ctx, mockNext);
      for await (const _ of generator) {
        // consume generator
      }

      expect(ctx.process.history.length).toBeGreaterThan(0);
    });
  });

  describe("pendingInputs 处理", () => {
    it("should have pendingInputs array in process", () => {
      const ctx = createMockContext();
      expect(ctx.process.pendingInputs).toBeDefined();
      expect(Array.isArray(ctx.process.pendingInputs)).toBe(true);
    });
  });

  describe("assistant 消息创建", () => {
    it("should create assistant message from staged chunk", async () => {
      const ctx = createMockContext();

      async function* mockNext() {
        yield { type: "staged", content: "AI response", thinking: "thoughts" };
      }

      const generator = messageMiddleware(ctx, mockNext);
      for await (const _ of generator) {
        // consume generator
      }

      const lastMessage = ctx.process.history.filter(m => m.role === "assistant").pop();
      expect(lastMessage).toBeDefined();
      expect(lastMessage?.role).toBe("assistant");
      expect(lastMessage?.content).toBe("AI response");
    });
  });

  describe("tool 结果处理", () => {
    it("should create tool message from result", async () => {
      const ctx = createMockContext();
      const toolResult: LLMResponse = {
        id: "tool-result-1",
        role: "tool",
        content: "tool output",
        createdAt: Date.now(),
        updateAt: Date.now(),
        raw: {},
      };

      // 先添加一条 assistant 消息
      ctx.process.history.push({
        id: "assistant-1",
        role: "assistant",
        content: "calling tool",
        createdAt: Date.now(),
        updateAt: Date.now(),
        raw: {},
      });

      async function* mockNext() {
        yield { type: "staged", content: "", toolResult };
      }

      const generator = messageMiddleware(ctx, mockNext);
      for await (const _ of generator) {
        // consume generator
      }

      expect(ctx.process.history.length).toBeGreaterThan(1);
    });
  });
});