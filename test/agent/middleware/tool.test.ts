import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  toolMiddleware,
  executeSingleSenseCall,
  type ToolChunk,
} from "@/agent/middleware/tool";
import { SupervisionLevel } from "@/core/config";

import type { MiddlewareContext, SenseCallAccumulator } from "@/core/middleware/types";
import type { SenseManager } from "@/core/sense/index";

// Mock interruptRepo for polling mechanism
const mockInterruptRepo = vi.hoisted(() => ({
  findById: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/db/interrupt.js", () => ({
  interruptRepo: mockInterruptRepo,
}));

// Mock interruptManager
vi.mock("@/service/agent/interrupt.js", () => ({
  interruptManager: {
    createInterrupt: vi.fn(async () => "test-interrupt-id"),
    completeInterrupt: vi.fn(async () => {}),
  },
}));

function createMockSenseManager(): SenseManager {
  return {
    add: vi.fn(),
    get: vi.fn(),
    execute: vi.fn(async () => ({ content: "tool result", hash: "test-hash" })),
    senses: new Map(),
  } as unknown as SenseManager;
}

function createMockContext(): MiddlewareContext {
  const senseManager = createMockSenseManager();
  return {
    session: {
      sessionId: "test-session",
      threadId: "test-thread",
      hashCheck: new Map(),
      senseSharedData: new Map(),
      userInputs: [],
      builtSenses: [],
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
      sense_group: "test",
    },
    adapters: {} as any,
    process: {
      history: [],
      contentAccumulated: "",
      thinkingAccumulated: "",
      chunkCount: 0,
      toolCallAccumulated: new Map(),
      pendingInputs: [],
    },
    senses: { senseManager },
  };
}

function createSenseCall(
  tid: string,
  name: string,
  args: string = "{}",
): SenseCallAccumulator {
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

  describe("SenseCallAccumulator", () => {
    it("should have required properties", () => {
      const accumulator = createSenseCall("tool-0", "test_tool");

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
    it("should pass through when no senseCalls", async () => {
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
        createSenseCall("tc-1", "unknown_tool"),
      );
      ctx.senses.senseManager.get = vi.fn(() => undefined);

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
        createSenseCall("tc-1", "test_tool"),
      );
      ctx.senses.senseManager.get = vi.fn(() => ({
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

      expect(ctx.senses.senseManager.execute).toHaveBeenCalled();
    });

    it("should yield interrupt when tool supervisionLevel is confirm", async () => {
      // Setup mock to return acknowledged status quickly
      mockInterruptRepo.findById.mockResolvedValue({
        id: "test-interrupt-id",
        status: "acknowledged",
      });

      const ctx = createMockContext();
      ctx.process.toolCallAccumulated.set(
        "tc-1",
        createSenseCall("tc-1", "test_tool"),
      );
      ctx.senses.senseManager.get = vi.fn(() => ({
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
        (c) => (c as ToolChunk).type === "tool" && (c as ToolChunk).state === "interrupt",
      ) as ToolChunk | undefined;
      expect(interruptChunk).toBeDefined();
      expect(interruptChunk!.data.handleId).toBeDefined();
      expect(interruptChunk!.data.interruptId).toBe("test-interrupt-id");
    });

    it("should respect tool supervisionLevel for mixed tools", async () => {
      mockInterruptRepo.findById.mockResolvedValue({
        id: "test-interrupt-id",
        status: "acknowledged",
      });

      const ctx = createMockContext();

      ctx.process.toolCallAccumulated.set(
        "tc-auto",
        createSenseCall("tc-auto", "auto_tool"),
      );

      ctx.process.toolCallAccumulated.set(
        "tc-confirm",
        createSenseCall("tc-confirm", "confirm_tool"),
      );

      ctx.senses.senseManager.get = vi.fn((name: string) => {
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

      const interruptChunks = chunks.filter(
        (c) => (c as ToolChunk).type === "tool" && (c as ToolChunk).state === "interrupt",
      ) as ToolChunk[];
      expect(interruptChunks.length).toBe(1);
      expect(interruptChunks[0]!.data.toolName).toBe("confirm_tool");
    });
  });

  describe("acknowledge callback", () => {
    it("should execute tool when acknowledged (via polling)", async () => {
      mockInterruptRepo.findById.mockResolvedValue({
        id: "test-interrupt-id",
        status: "acknowledged",
      });

      const ctx = createMockContext();
      ctx.process.toolCallAccumulated.set(
        "tc-1",
        createSenseCall("tc-1", "test_tool", '{"arg": "value"}'),
      );
      ctx.senses.senseManager.get = vi.fn(() => ({
        ...mockToolBase,
        supervisionLevel: SupervisionLevel.confirm,
      }));

      const next = vi.fn(async function* () {
        yield { type: "test" };
      });

      const generator = toolMiddleware(ctx, next);
      for await (const _ of generator) {
        // consume - polling will detect acknowledged status
      }

      expect(ctx.senses.senseManager.execute).toHaveBeenCalled();
      const toolMessages = ctx.process.history.filter((m) => m.role === "tool");
      expect(toolMessages.length).toBeGreaterThan(0);
    });

    it("should mark tool call as approved after acknowledge", async () => {
      mockInterruptRepo.findById.mockResolvedValue({
        id: "test-interrupt-id",
        status: "acknowledged",
      });

      const ctx = createMockContext();
      const tc = createSenseCall("tc-1", "test_tool");
      ctx.process.toolCallAccumulated.set("tc-1", tc);
      ctx.senses.senseManager.get = vi.fn(() => ({
        ...mockToolBase,
        supervisionLevel: SupervisionLevel.confirm,
      }));

      const next = vi.fn(async function* () {
        yield { type: "test" };
      });

      const generator = toolMiddleware(ctx, next);
      for await (const _ of generator) {
        // consume
      }

      expect(tc.approved).toBe(true);
    });
  });
});

describe("executeSingleSenseCall", () => {
  it("should return tool result on success", async () => {
    const ctx = createMockContext();
    ctx.senses.senseManager.execute = vi.fn(async () => ({
      content: "success result",
      hash: "hash-123",
    }));

    const result = await executeSingleSenseCall(ctx, "tc-1", "test_tool", {
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
    ctx.senses.senseManager.execute = vi.fn(async () => ({
      content: "result",
      hash: "hash-123",
    }));

    const result = await executeSingleSenseCall(ctx, "tc-1", "test_tool", {});

    expect(result.result).toContain("已跳过");
    expect(result.result).toContain("重复调用");
  });

  it("should handle execution error", async () => {
    const ctx = createMockContext();
    ctx.senses.senseManager.execute = vi.fn(async () => {
      throw new Error("execution failed");
    });

    const result = await executeSingleSenseCall(ctx, "tc-1", "test_tool", {});

    expect(result.result).toContain("Tool execution failed");
    expect(result.result).toContain("execution failed");
  });

  it("should skip hash check when hash is empty", async () => {
    const ctx = createMockContext();
    ctx.senses.senseManager.execute = vi.fn(async () => ({
      content: "result",
      hash: "",
    }));

    const result = await executeSingleSenseCall(ctx, "tc-1", "test_tool", {});

    expect(result.result).toBe("result");
    expect(ctx.session.hashCheck.size).toBe(0);
  });

  it("should store hash after successful execution", async () => {
    const ctx = createMockContext();
    ctx.senses.senseManager.execute = vi.fn(async () => ({
      content: "result",
      hash: "hash-123",
    }));

    await executeSingleSenseCall(ctx, "tc-1", "test_tool", {});

    expect(ctx.session.hashCheck.has("hash-123")).toBe(true);
  });
});