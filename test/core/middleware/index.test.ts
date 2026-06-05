import { describe, it, expect, vi, beforeEach } from "vitest";
import Middleware from "@/core/middleware/index";
import { compose } from "@/core/middleware/compose";
import type { MiddlewareContext, MiddlewareHandler, LoopHandler } from "@/core/middleware/types";
import type { ToolManager } from "@/core/tool/index";

// Mock dependencies
vi.mock("@/core/prompt/index", () => ({
  default: vi.fn(() => "mock system prompt"),
}));

vi.mock("uuid", () => ({
  v4: vi.fn(() => "test-uuid-1234"),
}));

function createMockToolManager(): ToolManager {
  return {
    add: vi.fn(),
    get: vi.fn(),
    execute: vi.fn(async () => ({ content: "result", hash: "test-hash" })),
    tools: new Map(),
  } as unknown as ToolManager;
}

function createMockGlobalConfig() {
  return {
    thinking: false,
    supervision: 0,
    stream: true,
    maxLoopCount: 10,
  };
}

function createMockClientConfig() {
  return {
    model: "test-model",
    provider: "test",
    url: "http://localhost",
    tool_group: "test",
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
    toolAdapter: {
      buildTools: vi.fn(() => []),
      extractToolCalls: vi.fn(() => []),
      assembleToolCallChunks: vi.fn(() => []),
    },
  } as any;
}

// Mock context for compose tests
const mockContext: MiddlewareContext = {
  session: { sessionId: "test", threadId: "thread-1", hashCheck: new Map(), toolSharedData: new Map(), userInputs: [], builtTools: [] },
  global: { thinking: false, supervision: 1, stream: true, maxLoopCount: 10 },
  config: { model: "test", provider: "test", url: "http://test", tool_group: "test" },
  adapters: {} as any,
  process: {
    history: [] as any,
    contentAccumulated: "",
    thinkingAccumulated: "",
    chunkCount: 0,
    toolCallAccumulated: new Map(),
    pendingInputs: [],
  },
  tools: { toolManager: {} as any },
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
      if (ctx.process.toolCallAccumulated.size > 0) continue;
      const lastMessage = ctx.process.history[ctx.process.history.length - 1]!;
      if (lastMessage.role === "tool") continue;
      if (lastMessage.role === "assistant" && lastMessage.toolCalls?.length) continue;
      break;
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
  let mockToolManager: ToolManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockToolManager = createMockToolManager();
    middleware = new Middleware(
      "test-session",
      createMockGlobalConfig(),
      createMockClientConfig(),
      mockToolManager,
      createMockAdapters(),
      [],
    );
  });

  describe("createThread", () => {
    it("should create thread and return threadId", () => {
      const threadId = middleware.createThread("test-thread-1");

      expect(threadId).toBe("test-thread-1");
      expect(middleware.threadMap.has(threadId)).toBe(true);
    });

    it("should initialize system message in history", () => {
      const threadId = middleware.createThread("test-thread-1");
      const ctx = middleware.threadMap.get(threadId);

      expect(ctx).toBeDefined();
      expect(ctx?.process.history.length).toBe(1);
      expect(ctx!.process.history[0]!.role).toBe("system");
      expect(ctx!.process.history[0]!.content).toBe("mock system prompt");
    });

    it("should set correct sessionId and threadId", () => {
      const threadId = middleware.createThread("test-thread-1");
      const ctx = middleware.threadMap.get(threadId);

      expect(ctx?.session.sessionId).toBe("test-session");
      expect(ctx?.session.threadId).toBe("test-thread-1");
    });

    it("should initialize empty accumulators", () => {
      const threadId = middleware.createThread("test-thread-1");
      const ctx = middleware.threadMap.get(threadId);

      expect(ctx?.process.contentAccumulated).toBe("");
      expect(ctx?.process.thinkingAccumulated).toBe("");
      expect(ctx?.process.toolCallAccumulated.size).toBe(0);
      expect(ctx?.process.pendingInputs.length).toBe(0);
    });

    it("should initialize hashCheck and toolSharedData maps", () => {
      const threadId = middleware.createThread("test-thread-1");
      const ctx = middleware.threadMap.get(threadId);

      expect(ctx?.session.hashCheck).toBeInstanceOf(Map);
      expect(ctx?.session.toolSharedData).toBeInstanceOf(Map);
    });
  });

  describe("send", () => {
    it("should throw error when thread not found", async () => {
      await expect(async () => {
        const gen = middleware.send("unknown-thread", "test");
        for await (const _ of gen) {
          // consume
        }
      }).rejects.toThrow("Thread not found");
    });

    it("should not store empty input", async () => {
      const handler: MiddlewareHandler = async function* (_ctx, next) {
        yield { type: "done" };
        yield* next();
      };
      middleware = new Middleware(
        "test-session",
        createMockGlobalConfig(),
        createMockClientConfig(),
        mockToolManager,
        createMockAdapters(),
        [handler],
      );
      const threadId = middleware.createThread("test-thread-1");

      const gen = middleware.send(threadId, "   ");
      for await (const _ of gen) {
        // consume
      }

      const ctx = middleware.threadMap.get(threadId);
      expect(ctx?.process.pendingInputs.length).toBe(0);
    });

    it("should yield done chunk when loop completes", async () => {
      const handler: MiddlewareHandler = async function* (_ctx, next) {
        yield { type: "done" };
        yield* next();
      };
      middleware = new Middleware(
        "test-session",
        createMockGlobalConfig(),
        createMockClientConfig(),
        mockToolManager,
        createMockAdapters(),
        [handler],
      );

      const threadId = middleware.createThread("test-thread-1");

      const gen = middleware.send(threadId, "test");
      const chunks: unknown[] = [];
      for await (const chunk of gen) {
        chunks.push(chunk);
      }

      expect(chunks.some((c) => (c as any).type === "done")).toBe(true);
    });

    it("should inject user message into history", async () => {
      const handler: MiddlewareHandler = async function* (ctx, next) {
        yield { type: "done" };
        yield* next();
      };
      middleware = new Middleware(
        "test-session",
        createMockGlobalConfig(),
        createMockClientConfig(),
        mockToolManager,
        createMockAdapters(),
        [handler],
      );
      const threadId = middleware.createThread("test-thread-1");

      const gen = middleware.send(threadId, "user message");
      for await (const _ of gen) {
        // consume
      }

      const ctx = middleware.threadMap.get(threadId);
      // Should have system + user messages
      expect(ctx?.process.history.length).toBeGreaterThan(1);
      const userMessages = ctx?.process.history.filter((m: { role: string }) => m.role === "user");
      expect(userMessages?.length).toBeGreaterThan(0);
    });
  });

  describe("executeLoop", () => {
    it("should respect maxLoopCount", async () => {
      const maxLoop = 3;
      const globalConfig = { ...createMockGlobalConfig(), maxLoopCount: maxLoop };

      let loopCount = 0;
      const handler: MiddlewareHandler = async function* (_ctx, next) {
        loopCount++;
        yield { type: "test" };
        yield* next();
      };

      middleware = new Middleware(
        "test-session",
        globalConfig,
        createMockClientConfig(),
        mockToolManager,
        createMockAdapters(),
        [handler],
        createTestLoopHandler(maxLoop),
      );
      const threadId = middleware.createThread("test-thread-1");

      const gen = middleware.send(threadId, "test");
      for await (const _ of gen) {
        // consume
      }

      expect(loopCount).toBeLessThanOrEqual(maxLoop);
    });

    it("should stop when assistant message has no toolCalls", async () => {
      const handler: MiddlewareHandler = async function* (ctx, next) {
        ctx.process.history.push({
          id: "test-id",
          role: "assistant",
          content: "response",
          createdAt: Date.now(),
          updateAt: Date.now(),
          raw: null,
        });
        yield { type: "done" };
        yield* next();
      };

      middleware = new Middleware(
        "test-session",
        createMockGlobalConfig(),
        createMockClientConfig(),
        mockToolManager,
        createMockAdapters(),
        [handler],
      );
      const threadId = middleware.createThread("test-thread-1");

      const gen = middleware.send(threadId, "test");
      const chunks: unknown[] = [];
      for await (const chunk of gen) {
        chunks.push(chunk);
      }

      expect(chunks.some((c) => (c as any).type === "done")).toBe(true);
    });

    it("should continue when toolCallAccumulated has data", async () => {
      let iterations = 0;
      const handler: MiddlewareHandler = async function* (ctx, next) {
        iterations++;
        if (iterations === 1) {
          ctx.process.toolCallAccumulated.set("tc-1", {
            tid: "tc-1",
            name: "test-tool",
            arguments: "{}",
            approved: false,
            triggeredAt: Date.now(),
          });
          yield { type: "test" };
        } else {
          ctx.process.toolCallAccumulated.clear();
          ctx.process.history.push({
            id: "test-id",
            role: "assistant",
            content: "done",
            createdAt: Date.now(),
            updateAt: Date.now(),
            raw: null,
          });
          yield { type: "done" };
        }
        yield* next();
      };

      middleware = new Middleware(
        "test-session",
        { ...createMockGlobalConfig(), maxLoopCount: 10 },
        createMockClientConfig(),
        mockToolManager,
        createMockAdapters(),
        [handler],
        createTestLoopHandler(10),
      );
      const threadId = middleware.createThread("test-thread-1");

      const gen = middleware.send(threadId, "test");
      for await (const _ of gen) {
        // consume
      }

      expect(iterations).toBeGreaterThanOrEqual(2);
    });

    it("should continue when last message is tool", async () => {
      let iterations = 0;
      const handler: MiddlewareHandler = async function* (ctx, next) {
        iterations++;
        if (iterations === 1) {
          ctx.process.history.push({
            id: "tool-id",
            role: "tool",
            content: "tool result",
            createdAt: Date.now(),
            updateAt: Date.now(),
            raw: {},
          });
          yield { type: "test" };
        } else {
          ctx.process.history.push({
            id: "assistant-id",
            role: "assistant",
            content: "final",
            createdAt: Date.now(),
            updateAt: Date.now(),
            raw: null,
          });
          yield { type: "done" };
        }
        yield* next();
      };

      middleware = new Middleware(
        "test-session",
        { ...createMockGlobalConfig(), maxLoopCount: 10 },
        createMockClientConfig(),
        mockToolManager,
        createMockAdapters(),
        [handler],
        createTestLoopHandler(10),
      );
      const threadId = middleware.createThread("test-thread-1");

      const gen = middleware.send(threadId, "test");
      for await (const _ of gen) {
        // consume
      }

      expect(iterations).toBeGreaterThanOrEqual(2);
    });

    it("should reset accumulators before each loop", async () => {
      const handler: MiddlewareHandler = async function* (ctx, next) {
        if (ctx.process.chunkCount !== 0) {
          throw new Error("chunkCount not reset");
        }
        yield { type: "done" };
        yield* next();
      };

      middleware = new Middleware(
        "test-session",
        createMockGlobalConfig(),
        createMockClientConfig(),
        mockToolManager,
        createMockAdapters(),
        [handler],
      );
      const threadId = middleware.createThread("test-thread-1");

      const gen = middleware.send(threadId, "test");
      for await (const _ of gen) {
        // consume
      }
    });
  });
});