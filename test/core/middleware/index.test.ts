import { describe, it, expect, vi, beforeEach } from "vitest";
import Middleware from "@/core/middleware/index";
import { compose } from "@/core/middleware/compose";
import type { MiddlewareContext, MiddlewareHandler, LoopHandler } from "@/core/middleware/types";
import type { SenseManager } from "@/core/sense/index";

// Mock dependencies
vi.mock("@/core/prompt/index", () => ({
  default: vi.fn(() => "mock system prompt"),
}));

vi.mock("uuid", () => ({
  v4: vi.fn(() => "test-uuid-1234"),
}));

function createMockSenseManager(): SenseManager {
  return {
    add: vi.fn(),
    get: vi.fn(),
    execute: vi.fn(async () => ({ content: "result", hash: "test-hash" })),
    senses: new Map(),
  } as unknown as SenseManager;
}

function createMockGlobalConfig() {
  return {
    thinking: false,
    supervision: 0,
    stream: true,
    maxLoopCount: 10,
  };
}

function createMockBrainConfig() {
  return {
    model: "test-model",
    provider: "test",
    url: "http://localhost",
    sense_group: ["test"],
  };
}

function createMockAdapters() {
  return {
    llmAdapter: {
      chat: vi.fn(),
      chatStream: vi.fn(),
    },
    messageAdapter: {
      role: vi.fn(() => "assistant" as const),
      content: vi.fn(() => ""),
      extractStreamDelta: vi.fn(() => ""),
      buildMessages: vi.fn(() => []),
    },
    senseAdapter: {
      buildTools: vi.fn(() => []),
      extractSenseCalls: vi.fn(() => []),
      assembleSenseCallChunks: vi.fn(() => []),
    },
  } as any;
}

// Mock context for compose tests
const mockContext: MiddlewareContext = {
  soul: {
    soulId: "test",
    chatId: "chat-1",
    hashCheck: new Map(),
    senseSharedData: new Map(),
    userInputs: [],
    builtSenses: [],
    messages: [],
  },
  global: { thinking: false, supervision: 1, stream: true, maxLoopCount: 10 },
  brain: { model: "test", provider: "test", url: "http://test", sense_group: ["test"] },
  adapters: {} as any,
  senseManager: {} as any,
};

// Simple handler for testing
const simpleHandler: MiddlewareHandler = async function* (ctx, next) {
  yield { type: "test" };
  yield* next();
};

/** 简单循环策略（模拟 agent 层 loopHandler） */
function createTestLoopHandler(maxLoop: number = 30): LoopHandler {
  return async function* (ctx, runChain) {
    let times = 0;
    while (times < maxLoop) {
      times++;
      yield* runChain();
      const lastMessage = ctx.soul.messages[ctx.soul.messages.length - 1];
      if (!lastMessage) break;
      if (lastMessage.role === "assistant" && !lastMessage.senseCalls?.length) break;
    }
  };
}

describe("Middleware", () => {
  describe("exports", () => {
    it("exports compose function", () => {
      expect(compose).toBeDefined();
      expect(typeof compose).toBe("function");
    });

    it("exports Middleware class", () => {
      expect(Middleware).toBeDefined();
    });
  });

  describe("compose", () => {
    it("returns function that creates generator", () => {
      const chain = compose([simpleHandler]);
      expect(typeof chain).toBe("function");
    });

    it("generator yields chunks", async () => {
      const chain = compose([simpleHandler]);
      const generator = chain(mockContext);

      const chunks = [];
      for await (const chunk of generator) {
        chunks.push(chunk);
      }

      expect(chunks.length).toBeGreaterThan(0);
    });
  });
});

describe("Middleware class", () => {
  let middleware: Middleware;
  let mockSenseManager: SenseManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSenseManager = createMockSenseManager();
    middleware = new Middleware(
      "test-soul",
      createMockGlobalConfig(),
      createMockBrainConfig(),
      mockSenseManager,
      createMockAdapters(),
      [],
    );
  });

  describe("createChat", () => {
    it("should create chat and return chatId", () => {
      const chatId = middleware.createChat("test-chat-1");

      expect(chatId).toBe("test-chat-1");
      expect(middleware.chatMap.has(chatId)).toBe(true);
    });

    it("should initialize system message in history", () => {
      const chatId = middleware.createChat("test-chat-1");
      const ctx = middleware.chatMap.get(chatId);

      expect(ctx).toBeDefined();
      expect(ctx?.soul.messages.length).toBe(1);
      expect(ctx!.soul.messages[0]!.role).toBe("system");
      expect(ctx!.soul.messages[0]!.content).toBe("mock system prompt");
    });

    it("should set correct soulId and chatId", () => {
      const chatId = middleware.createChat("test-chat-1");
      const ctx = middleware.chatMap.get(chatId);

      expect(ctx?.soul.soulId).toBe("test-soul");
      expect(ctx?.soul.chatId).toBe("test-chat-1");
    });

    it("should initialize empty userInputs", () => {
      const chatId = middleware.createChat("test-chat-1");
      const ctx = middleware.chatMap.get(chatId);

      expect(ctx?.soul.userInputs.length).toBe(0);
    });

    it("should initialize hashCheck and senseSharedData maps", () => {
      const chatId = middleware.createChat("test-chat-1");
      const ctx = middleware.chatMap.get(chatId);

      expect(ctx?.soul.hashCheck).toBeInstanceOf(Map);
      expect(ctx?.soul.senseSharedData).toBeInstanceOf(Map);
    });

    it("should return existing chatId if chat already exists", () => {
      const chatId1 = middleware.createChat("test-chat-1");
      const chatId2 = middleware.createChat("test-chat-1");

      expect(chatId1).toBe(chatId2);
      expect(middleware.chatMap.size).toBe(1);
    });
  });

  describe("send", () => {
    it("should throw error when chat not found", async () => {
      await expect(async () => {
        const gen = middleware.send("unknown-chat", "test");
        for await (const _ of gen) {
          // consume
        }
      }).rejects.toThrow("Chat not found");
    });

    it("should not store empty input", async () => {
      const handler: MiddlewareHandler = async function* (_ctx, next) {
        yield { type: "done" };
        yield* next();
      };
      middleware = new Middleware(
        "test-soul",
        createMockGlobalConfig(),
        createMockBrainConfig(),
        mockSenseManager,
        createMockAdapters(),
        [handler],
      );
      const chatId = middleware.createChat("test-chat-1");

      const gen = middleware.send(chatId, "   ");
      for await (const _ of gen) {
        // consume
      }

      const ctx = middleware.chatMap.get(chatId);
      expect(ctx?.soul.userInputs.length).toBe(0);
    });

    it("should yield done chunk when loop completes", async () => {
      const handler: MiddlewareHandler = async function* (_ctx, next) {
        yield { type: "done" };
        yield* next();
      };
      middleware = new Middleware(
        "test-soul",
        createMockGlobalConfig(),
        createMockBrainConfig(),
        mockSenseManager,
        createMockAdapters(),
        [handler],
      );

      const chatId = middleware.createChat("test-chat-1");

      const gen = middleware.send(chatId, "test");
      const chunks: unknown[] = [];
      for await (const chunk of gen) {
        chunks.push(chunk);
      }

      expect(chunks.some((c) => (c as any).type === "done")).toBe(true);
    });

    it("should store user input", async () => {
      const handler: MiddlewareHandler = async function* (_ctx, next) {
        yield { type: "done" };
        yield* next();
      };
      middleware = new Middleware(
        "test-soul",
        createMockGlobalConfig(),
        createMockBrainConfig(),
        mockSenseManager,
        createMockAdapters(),
        [handler],
      );
      const chatId = middleware.createChat("test-chat-1");

      const gen = middleware.send(chatId, "user message");
      for await (const _ of gen) {
        // consume
      }

      const ctx = middleware.chatMap.get(chatId);
      expect(ctx?.soul.userInputs.length).toBe(1);
      expect(ctx?.soul.userInputs[0]?.content).toBe("user message");
    });
  });

  describe("loop execution", () => {
    it("should respect maxLoopCount via loopHandler", async () => {
      const maxLoop = 3;
      const globalConfig = { ...createMockGlobalConfig(), maxLoopCount: maxLoop };

      let loopCount = 0;
      const handler: MiddlewareHandler = async function* (_ctx, next) {
        loopCount++;
        yield { type: "test" };
        yield* next();
      };

      middleware = new Middleware(
        "test-soul",
        globalConfig,
        createMockBrainConfig(),
        mockSenseManager,
        createMockAdapters(),
        [handler],
        createTestLoopHandler(maxLoop),
      );
      const chatId = middleware.createChat("test-chat-1");

      const gen = middleware.send(chatId, "test");
      for await (const _ of gen) {
        // consume
      }

      expect(loopCount).toBeLessThanOrEqual(maxLoop);
    });

    it("should stop when assistant message has no senseCalls", async () => {
      const handler: MiddlewareHandler = async function* (ctx, next) {
        ctx.soul.messages.push({
          id: "test-id",
          role: "assistant",
          content: "response",
          createdAt: Date.now(),
          updateAt: Date.now(),
        });
        yield { type: "done" };
        yield* next();
      };

      middleware = new Middleware(
        "test-soul",
        createMockGlobalConfig(),
        createMockBrainConfig(),
        mockSenseManager,
        createMockAdapters(),
        [handler],
      );
      const chatId = middleware.createChat("test-chat-1");

      const gen = middleware.send(chatId, "test");
      const chunks: unknown[] = [];
      for await (const chunk of gen) {
        chunks.push(chunk);
      }

      expect(chunks.some((c) => (c as any).type === "done")).toBe(true);
    });

    it("should continue loop when assistant has senseCalls", async () => {
      let iterations = 0;
      const handler: MiddlewareHandler = async function* (ctx, next) {
        iterations++;
        if (iterations === 1) {
          ctx.soul.messages.push({
            id: "test-id",
            role: "assistant",
            content: "response",
            senseCalls: [{ id: "sc-1", name: "test-tool", arguments: "{}" }],
            createdAt: Date.now(),
            updateAt: Date.now(),
          });
          yield { type: "test" };
        } else {
          ctx.soul.messages.push({
            id: "test-id-2",
            role: "assistant",
            content: "done",
            createdAt: Date.now(),
            updateAt: Date.now(),
          });
          yield { type: "done" };
        }
        yield* next();
      };

      middleware = new Middleware(
        "test-soul",
        { ...createMockGlobalConfig(), maxLoopCount: 10 },
        createMockBrainConfig(),
        mockSenseManager,
        createMockAdapters(),
        [handler],
        createTestLoopHandler(10),
      );
      const chatId = middleware.createChat("test-chat-1");

      const gen = middleware.send(chatId, "test");
      for await (const _ of gen) {
        // consume
      }

      expect(iterations).toBeGreaterThanOrEqual(2);
    });
  });

  describe("getContext", () => {
    it("should return context for existing chat", () => {
      const chatId = middleware.createChat("test-chat-1");
      const ctx = middleware.getContext(chatId);

      expect(ctx).toBeDefined();
      expect(ctx?.soul.chatId).toBe("test-chat-1");
    });

    it("should return undefined for non-existing chat", () => {
      const ctx = middleware.getContext("unknown-chat");

      expect(ctx).toBeUndefined();
    });
  });
});