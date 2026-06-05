import { describe, it, expect, vi } from "vitest";
import type { MiddlewareContext, MiddlewareHandler } from "@/core/middleware/types.js";


vi.mock("@/db/interrupt.js", () => ({
  interruptRepo: {},
}));

function createMockContext(): MiddlewareContext {
  return {
    session: {
      sessionId: "test-session",
      threadId: "test-thread",
      hashCheck: new Map(),
      toolSharedData: new Map(),
      userInputs: [],
      builtTools: [],
    },
    global: {
      thinking: false,
      supervision: 0,
      stream: true,
      maxLoopCount: 30,
    },
    config: {
      provider: "test",
      model: "gpt-test",
      url: "http://localhost",
      tool_group: ["safe"],
    },
    adapters: {
      llmAdapter: { chat: vi.fn(), chatStream: vi.fn() } as any,
      messageAdapter: {} as any,
      toolAdapter: {} as any,
    },
    process: {
      history: [],
      contentAccumulated: "",
      thinkingAccumulated: "",
      chunkCount: 0,
      toolCallAccumulated: new Map(),
      pendingInputs: [],
    },
    tools: {
      toolManager: {} as any,
    },
  };
}

describe("cacheMiddleware", () => {
  it("should yield chunks from next", async () => {
    const { default: cacheMiddleware } = await import("@/agent/middleware/cache.js");
    const ctx = createMockContext();

    async function* mockNext() {
      yield { type: "stream", contentDelta: "hello" };
      yield { type: "staged", content: "done" };
    }

    const results: unknown[] = [];
    for await (const chunk of cacheMiddleware(ctx, mockNext)) {
      results.push(chunk);
    }

    expect(results).toHaveLength(2);
    expect((results[0] as any).type).toBe("stream");
    expect((results[1] as any).type).toBe("staged");
  });

  it("should handle empty generator", async () => {
    const { default: cacheMiddleware } = await import("@/agent/middleware/cache.js");
    const ctx = createMockContext();

    async function* mockNext() {
      // empty
    }

    const results: unknown[] = [];
    for await (const chunk of cacheMiddleware(ctx, mockNext)) {
      results.push(chunk);
    }

    expect(results).toHaveLength(0);
  });

  it("should pass through interrupt chunks", async () => {
    const { default: cacheMiddleware } = await import("@/agent/middleware/cache.js");
    const ctx = createMockContext();

    async function* mockNext() {
      yield { type: "interrupt", interruptId: "int-1" };
      yield { type: "done" };
    }

    const results: unknown[] = [];
    for await (const chunk of cacheMiddleware(ctx, mockNext)) {
      results.push(chunk);
    }

    expect(results).toHaveLength(2);
    expect((results[0] as any).type).toBe("interrupt");
  });
});
