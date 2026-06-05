import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolCallAccumulator } from "@/core/middleware/types.js";
import type { InterruptEntity, ContextSnapshot } from "@/db/interrupt.js";

// Use vi.hoisted so the mock object is available inside hoisted vi.mock factory
const mockRepo = vi.hoisted(() => ({
  create: vi.fn().mockResolvedValue(undefined),
  findById: vi.fn().mockResolvedValue(null),
  findBySessionId: vi.fn().mockResolvedValue([]),
  findByStatus: vi.fn().mockResolvedValue([]),
  update: vi.fn().mockResolvedValue(undefined),
  delete: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/db/interrupt.js", () => ({
  interruptRepo: mockRepo,
}));

// Must import after mocks
import { InterruptManager } from "@/service/agent/interrupt.js";

function createMockToolCall(tid: string, name: string): ToolCallAccumulator {
  return {
    tid,
    name,
    arguments: "{}",
    approved: false,
    triggeredAt: Date.now(),
  };
}

function createMockCtx() {
  return {
    session: {
      sessionId: "sess-1",
      threadId: "thread-1",
      hashCheck: new Map<string, string>(),
      toolSharedData: new Map<string, Map<string, unknown>>(),
    },
    process: {
      history: [] as unknown[],
      toolCallAccumulated: new Map<string, ToolCallAccumulator>(),
      pendingInputs: [] as Array<{ input: string; time: number }>,
      contentAccumulated: "",
      thinkingAccumulated: "",
      chunkCount: 0,
    },
    config: {
      provider: "test",
      model: "gpt",
      tool_group: ["safe"] as string[],
    },
  };
}

describe("InterruptManager", () => {
  let manager: InterruptManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new InterruptManager();
  });

  describe("createInterrupt", () => {
    it("persists entity via interruptRepo.create", async () => {
      const ctx = createMockCtx();
      const tcs = [createMockToolCall("tc-1", "read_file")];

      const interruptId = await manager.createInterrupt(ctx as any, tcs);

      expect(mockRepo.create).toHaveBeenCalledTimes(1);
      const entity = mockRepo.create.mock.calls[0][0] as InterruptEntity;
      expect(entity.id).toBe(interruptId);
      expect(entity.sessionId).toBe("sess-1");
      expect(entity.threadId).toBe("thread-1");
      expect(entity.status).toBe("pending");
      expect(entity.toolCalls).toEqual(tcs);
    });

    it("registers pending handles (without resolve/reject)", async () => {
      const ctx = createMockCtx();
      const tcs = [
        createMockToolCall("tc-1", "read_file"),
        createMockToolCall("tc-2", "write_file"),
      ];

      await manager.createInterrupt(ctx as any, tcs);

      const handles = manager.getPendingHandles();
      expect(handles).toHaveLength(2);
      const handleIds = handles.map(h => h.handleId);
      // handleId format: `${interruptId}-${tc.tid}`
      expect(handleIds[0]).toContain("tc-1");
      expect(handleIds[1]).toContain("tc-2");
      // No resolve/reject in new design
      expect(handles[0]!.resolve).toBeUndefined();
      expect(handles[0]!.reject).toBeUndefined();
    });

    it("returns interruptId", async () => {
      const ctx = createMockCtx();
      const interruptId = await manager.createInterrupt(ctx as any, []);
      expect(typeof interruptId).toBe("string");
      expect(interruptId.length).toBeGreaterThan(0);
    });
  });

  describe("getHandle", () => {
    it("returns handle by handleId", async () => {
      const ctx = createMockCtx();
      const tcs = [createMockToolCall("tc-1", "read_file")];
      const interruptId = await manager.createInterrupt(ctx as any, tcs);

      const handleId = `${interruptId}-tc-1`;
      const handle = manager.getHandle(handleId);

      expect(handle).toBeDefined();
      expect(handle?.handleId).toBe(handleId);
      expect(handle?.interruptId).toBe(interruptId);
    });

    it("returns undefined for unknown handleId", () => {
      const handle = manager.getHandle("unknown-handle");
      expect(handle).toBeUndefined();
    });
  });

  describe("confirmHandle", () => {
    it("deletes handle from pending", async () => {
      const ctx = createMockCtx();
      const tcs = [createMockToolCall("tc-1", "read_file")];
      const interruptId = await manager.createInterrupt(ctx as any, tcs);
      const handleId = `${interruptId}-tc-1`;

      await manager.confirmHandle(handleId, "accept");

      expect(manager.getPendingHandles()).toHaveLength(0);
    });

    it("calls interruptRepo.update with status acknowledged", async () => {
      const ctx = createMockCtx();
      const tcs = [createMockToolCall("tc-1", "read_file")];
      const interruptId = await manager.createInterrupt(ctx as any, tcs);
      const handleId = `${interruptId}-tc-1`;

      await manager.confirmHandle(handleId, "accept", "approved by user");

      expect(mockRepo.update).toHaveBeenCalledWith(
        interruptId,
        expect.objectContaining({ status: "acknowledged" }),
      );
    });

    it("handles unknown handleId gracefully (for recovery scenario)", async () => {
      // Should not throw - recovery scenario where handle not in memory
      mockRepo.findById.mockResolvedValue({
        id: "test-interrupt",
        status: "pending",
      });

      await manager.confirmHandle("test-interrupt-tc-1", "accept");

      expect(mockRepo.update).toHaveBeenCalled();
    });
  });

  describe("loadSessionInterrupts", () => {
    it("loads handles from all pending interrupts for session", async () => {
      const tcs1 = [createMockToolCall("tc-1", "read_file")];
      const tcs2 = [createMockToolCall("tc-2", "write_file")];
      mockRepo.findBySessionId.mockResolvedValue([
        { id: "int-1", status: "pending", toolCalls: tcs1, createdAt: Date.now() },
        { id: "int-2", status: "completed", toolCalls: tcs2, createdAt: Date.now() },
      ]);

      const handles = await manager.loadSessionInterrupts("sess-1");

      // Only pending interrupt should be loaded
      expect(handles).toHaveLength(1);
      expect(handles[0]?.handleId).toBe("int-1-tc-1");
      expect(manager.getHandle("int-1-tc-1")).toBeDefined();
    });

    it("returns empty array when no pending interrupts", async () => {
      mockRepo.findBySessionId.mockResolvedValue([
        { id: "int-1", status: "completed", toolCalls: [] },
      ]);

      const handles = await manager.loadSessionInterrupts("sess-1");

      expect(handles).toHaveLength(0);
    });
  });

  describe("loadInterruptHandles", () => {
    it("loads handles from database to memory", async () => {
      const tcs = [createMockToolCall("tc-1", "read_file")];
      mockRepo.findById.mockResolvedValue({
        id: "int-1",
        status: "pending",
        toolCalls: tcs,
        createdAt: Date.now(),
      });

      const handles = await manager.loadInterruptHandles("int-1");

      expect(handles).toHaveLength(1);
      expect(handles[0]?.handleId).toBe("int-1-tc-1");
      expect(manager.getHandle("int-1-tc-1")).toBeDefined();
    });

    it("returns empty array for non-pending interrupt", async () => {
      mockRepo.findById.mockResolvedValue({
        id: "int-1",
        status: "completed",
      });

      const handles = await manager.loadInterruptHandles("int-1");

      expect(handles).toHaveLength(0);
    });

    it("returns empty array when not found", async () => {
      mockRepo.findById.mockResolvedValue(null);

      const handles = await manager.loadInterruptHandles("nonexistent");

      expect(handles).toHaveLength(0);
    });
  });

  describe("cleanupSession", () => {
    it("deletes all handles for given session", async () => {
      const ctx = createMockCtx();
      const tcs = [createMockToolCall("tc-1", "read_file")];
      const interruptId = await manager.createInterrupt(ctx as any, tcs);

      // findById returns entity with matching sessionId
      mockRepo.findById.mockResolvedValue({
        id: interruptId,
        sessionId: "sess-1",
      });

      await manager.cleanupSession("sess-1", "session ended");

      expect(manager.getPendingHandles()).toHaveLength(0);
    });
  });

  describe("resumeInterrupt", () => {
    it("returns contextSnapshot from repo", async () => {
      const snapshot: ContextSnapshot = {
        history: [],
        toolCallAccumulated: [],
        pendingInputs: [],
        config: { provider: "test", model: "gpt", tool_group: ["safe"] },
      };
      mockRepo.findById.mockResolvedValue({
        id: "int-1",
        contextSnapshot: snapshot,
      });

      const result = await manager.resumeInterrupt("int-1");
      expect(result).toEqual(snapshot);
    });

    it("returns null when not found", async () => {
      mockRepo.findById.mockResolvedValue(null);

      const result = await manager.resumeInterrupt("nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("completeInterrupt", () => {
    it("calls repo.update with status completed", async () => {
      await manager.completeInterrupt("int-1");

      expect(mockRepo.update).toHaveBeenCalledWith(
        "int-1",
        expect.objectContaining({ status: "completed" }),
      );
    });

    it("clears handles from memory", async () => {
      const ctx = createMockCtx();
      const tcs = [createMockToolCall("tc-1", "read_file")];
      const interruptId = await manager.createInterrupt(ctx as any, tcs);

      expect(manager.getPendingHandles()).toHaveLength(1);

      await manager.completeInterrupt(interruptId);

      expect(manager.getPendingHandles()).toHaveLength(0);
    });
  });
});