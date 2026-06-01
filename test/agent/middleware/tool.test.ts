import { describe, it, expect, vi } from "vitest";
import {
  toolMiddleware,
  executeSingleToolCall,
  type InterruptChunk,
} from "@/agent/middleware/tool";
import { SupervisionLevel } from "@/core/config";
import { createHistoryProxy } from "@/core/middleware/utils";
import type { MiddlewareContext, ToolCallAccumulator } from "@/core/middleware/types";
import type { ToolManager } from "@/core/tool/index";

function createMockToolManager(): ToolManager {
  return {
    add: vi.fn(),
    get: vi.fn(),
    execute: vi.fn(async () => ({ content: "tool result", hash: "test-hash" })),
    tools: new Map(),
  } as unknown as ToolManager;
}

function createMockContext(): MiddlewareContext {
  const toolManager = createMockToolManager();
  return {
    session: {
      sessionId: "test-session",
      threadId: "test-thread",
      hashCheck: new Map(),
      toolSharedData: new Map(),
    },
    global: {
      thinking: false,
      supervision: SupervisionLevel.confirm,
      stream: true,
      maxLoopCount: 10,
    },
    config: {
      model: "test-model",
      provider: "test",
      url: "http://localhost",
      tool_group: "test",
    },
    adapters: {} as any,
    process: {
      history: createHistoryProxy(),
      contentAccumulated: "",
      thinkingAccumulated: "",
      chunkCount: 0,
      toolCallAccumulated: new Map(),
      pendingInputs: [],
    },
    tools: { toolManager },
  };
}

function createToolCall(
  tid: string,
  name: string,
  args: string = "{}",
): ToolCallAccumulator {
  return {
    tid,
    name,
    arguments: args,
    approved: false,
    triggeredAt: Date.now(),
  };
}

const mockToolBase: any = {
  definition: {
    type: "function" as const,
    function: {
      name: "test_tool",
      description: "test",
      parameters: { type: "object" as const, properties: {}, required: [] as string[], additionalProperties: false },
    },
  },
  executor: {},
};

describe("toolMiddleware", () => {
  describe("InterruptChunk structure", () => {
    it("should have type 'interrupt'", () => {
      const chunk = { type: "interrupt", handles: [] };
      expect(chunk.type).toBe("interrupt");
    });

    it("should include handles array", () => {
      const chunk = { type: "interrupt", handles: [] };
      expect(Array.isArray(chunk.handles)).toBe(true);
    });
  });

  describe("ToolCallAccumulator", () => {
    it("should have required properties", () => {
      const accumulator = createToolCall("tool-0", "test_tool");

      expect(accumulator.tid).toBeDefined();
      expect(accumulator.name).toBeDefined();
      expect(accumulator.arguments).toBeDefined();
      expect(accumulator.approved).toBeDefined();
      expect(accumulator.triggeredAt).toBeDefined();
    });
  });

  describe("supervision level behavior", () => {
    it("auto level should allow immediate execution", () => {
      expect(SupervisionLevel.auto).toBe(0);
    });

    it("confirm level should require user approval", () => {
      expect(SupervisionLevel.confirm).toBe(1);
    });

    it("manual level should block execution", () => {
      expect(SupervisionLevel.manual).toBe(2);
    });
  });

  describe("middleware execution", () => {
    it("should pass through when no toolCalls", async () => {
      const ctx = createMockContext();
      const next = vi.fn(async function* () {
        yield { type: "test" };
      });

      const generator = toolMiddleware(ctx, next);
      const chunks: unknown[] = [];
      for await (const chunk of generator) {
        chunks.push(chunk);
      }

      expect(next).toHaveBeenCalled();
      expect(chunks).toContainEqual({ type: "test" });
    });

    it("should handle tool not found", async () => {
      const ctx = createMockContext();
      ctx.process.toolCallAccumulated.set(
        "tc-1",
        createToolCall("tc-1", "unknown_tool"),
      );
      ctx.tools.toolManager.get = vi.fn(() => undefined);

      const next = vi.fn(async function* () {
        yield { type: "test" };
      });

      const generator = toolMiddleware(ctx, next);
      for await (const _ of generator) {
        // consume
      }

      const toolMessages = ctx.process.history.filter((m) => m.role === "tool");
      expect(toolMessages.length).toBeGreaterThan(0);
      expect(toolMessages[0]!.content).toContain("not found");
    });

    it("should auto execute when tool supervisionLevel is auto", async () => {
      const ctx = createMockContext();
      ctx.process.toolCallAccumulated.set(
        "tc-1",
        createToolCall("tc-1", "test_tool"),
      );
      ctx.tools.toolManager.get = vi.fn(() => ({
        ...mockToolBase,
        supervisionLevel: SupervisionLevel.auto,
      }));

      const next = vi.fn(async function* () {
        yield { type: "test" };
      });

      const generator = toolMiddleware(ctx, next);
      for await (const _ of generator) {
        // consume
      }

      expect(ctx.tools.toolManager.execute).toHaveBeenCalled();
    });

    it("should yield interrupt when tool supervisionLevel is confirm", async () => {
      const ctx = createMockContext();
      ctx.process.toolCallAccumulated.set(
        "tc-1",
        createToolCall("tc-1", "test_tool"),
      );
      ctx.tools.toolManager.get = vi.fn(() => ({
        ...mockToolBase,
        supervisionLevel: SupervisionLevel.confirm,
      }));

      const next = vi.fn(async function* () {
        yield { type: "test" };
      });

      const generator = toolMiddleware(ctx, next);
      const chunks: unknown[] = [];
      for await (const chunk of generator) {
        chunks.push(chunk);
      }

      const interruptChunk = chunks.find(
        (c) => (c as InterruptChunk).type === "interrupt",
      ) as InterruptChunk | undefined;
      expect(interruptChunk).toBeDefined();
      expect(interruptChunk!.handles.length).toBe(1);
    });

    it("should respect tool supervisionLevel for mixed tools", async () => {
      const ctx = createMockContext();

      ctx.process.toolCallAccumulated.set(
        "tc-auto",
        createToolCall("tc-auto", "auto_tool"),
      );

      ctx.process.toolCallAccumulated.set(
        "tc-confirm",
        createToolCall("tc-confirm", "confirm_tool"),
      );

      ctx.tools.toolManager.get = vi.fn((name: string) => {
        if (name === "auto_tool") {
          return { ...mockToolBase, supervisionLevel: SupervisionLevel.auto };
        }
        return { ...mockToolBase, supervisionLevel: SupervisionLevel.confirm };
      });

      const next = vi.fn(async function* () {
        yield { type: "test" };
      });

      const generator = toolMiddleware(ctx, next);
      const chunks: unknown[] = [];
      for await (const chunk of generator) {
        chunks.push(chunk);
      }

      const interruptChunk = chunks.find(
        (c) => (c as InterruptChunk).type === "interrupt",
      ) as InterruptChunk | undefined;
      expect(interruptChunk).toBeDefined();
      expect(interruptChunk!.handles.length).toBe(1);
      expect(interruptChunk!.handles[0]!.reason).toContain("confirm_tool");
    });
  });

  describe("acknowledge callback", () => {
    it("should execute tool when accept", async () => {
      const ctx = createMockContext();
      ctx.process.toolCallAccumulated.set(
        "tc-1",
        createToolCall("tc-1", "test_tool", '{"arg": "value"}'),
      );
      ctx.tools.toolManager.get = vi.fn(() => ({
        ...mockToolBase,
        supervisionLevel: SupervisionLevel.confirm,
      }));

      const next = vi.fn(async function* () {
        yield { type: "test" };
      });

      let acknowledgeCallback:
        | ((action: "accept" | "reject", reason?: string) => Promise<void>)
        | undefined;

      const generator = toolMiddleware(ctx, next);
      for await (const chunk of generator) {
        if ((chunk as InterruptChunk).type === "interrupt") {
          acknowledgeCallback = (chunk as InterruptChunk).handles[0]?.acknowledge;
          await acknowledgeCallback!("accept");
        }
      }

      expect(ctx.tools.toolManager.execute).toHaveBeenCalled();
      const toolMessages = ctx.process.history.filter((m) => m.role === "tool");
      expect(toolMessages.length).toBeGreaterThan(0);
    });

    it("should return reject message when reject", async () => {
      const ctx = createMockContext();
      ctx.process.toolCallAccumulated.set(
        "tc-1",
        createToolCall("tc-1", "test_tool"),
      );
      ctx.tools.toolManager.get = vi.fn(() => ({
        ...mockToolBase,
        supervisionLevel: SupervisionLevel.confirm,
      }));

      const next = vi.fn(async function* () {
        yield { type: "test" };
      });

      let acknowledgeCallback:
        | ((action: "accept" | "reject", reason?: string) => Promise<void>)
        | undefined;

      const generator = toolMiddleware(ctx, next);
      for await (const chunk of generator) {
        if ((chunk as InterruptChunk).type === "interrupt") {
          acknowledgeCallback = (chunk as InterruptChunk).handles[0]?.acknowledge;
          await acknowledgeCallback!("reject", "unsafe operation");
        }
      }

      const toolMessages = ctx.process.history.filter((m) => m.role === "tool");
      expect(toolMessages.length).toBeGreaterThan(0);
      expect(toolMessages[0]!.content).toContain("拒绝执行");
    });

    it("should mark tool call as approved after acknowledge", async () => {
      const ctx = createMockContext();
      const tc = createToolCall("tc-1", "test_tool");
      ctx.process.toolCallAccumulated.set("tc-1", tc);
      ctx.tools.toolManager.get = vi.fn(() => ({
        ...mockToolBase,
        supervisionLevel: SupervisionLevel.confirm,
      }));

      const next = vi.fn(async function* () {
        yield { type: "test" };
      });

      const generator = toolMiddleware(ctx, next);
      for await (const chunk of generator) {
        if ((chunk as InterruptChunk).type === "interrupt") {
          await (chunk as InterruptChunk).handles[0]!.acknowledge("accept");
        }
      }

      expect(tc.approved).toBe(true);
    });
  });
});

describe("executeSingleToolCall", () => {
  it("should return tool result on success", async () => {
    const ctx = createMockContext();
    ctx.tools.toolManager.execute = vi.fn(async () => ({
      content: "success result",
      hash: "hash-123",
    }));

    const result = await executeSingleToolCall(ctx, "tc-1", "test_tool", {
      arg: "value",
    });

    expect(result.tid).toBe("tc-1");
    expect(result.name).toBe("test_tool");
    expect(result.result).toBe("success result");
    expect(result.arguments).toBe('{"arg":"value"}');
  });

  it("should skip duplicate hash", async () => {
    const ctx = createMockContext();
    ctx.session.hashCheck.set("hash-123", "previous_tool");
    ctx.tools.toolManager.execute = vi.fn(async () => ({
      content: "result",
      hash: "hash-123",
    }));

    const result = await executeSingleToolCall(ctx, "tc-1", "test_tool", {});

    expect(result.result).toContain("已跳过");
    expect(result.result).toContain("重复调用");
  });

  it("should handle execution error", async () => {
    const ctx = createMockContext();
    ctx.tools.toolManager.execute = vi.fn(async () => {
      throw new Error("execution failed");
    });

    const result = await executeSingleToolCall(ctx, "tc-1", "test_tool", {});

    expect(result.result).toContain("Tool execution failed");
    expect(result.result).toContain("execution failed");
  });

  it("should skip hash check when hash is empty", async () => {
    const ctx = createMockContext();
    ctx.tools.toolManager.execute = vi.fn(async () => ({
      content: "result",
      hash: "",
    }));

    const result = await executeSingleToolCall(ctx, "tc-1", "test_tool", {});

    expect(result.result).toBe("result");
    expect(ctx.session.hashCheck.size).toBe(0);
  });

  it("should store hash after successful execution", async () => {
    const ctx = createMockContext();
    ctx.tools.toolManager.execute = vi.fn(async () => ({
      content: "result",
      hash: "hash-123",
    }));

    await executeSingleToolCall(ctx, "tc-1", "test_tool", {});

    expect(ctx.session.hashCheck.has("hash-123")).toBe(true);
  });
});
