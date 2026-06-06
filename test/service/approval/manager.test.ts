import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApprovalManager, approvalManager } from "@/service/approval/manager.js";
import type { SenseTriggerChunk } from "@/core/middleware/types.js";
import type { MiddlewareContext } from "@/core/middleware/types.js";

// Mock approvalRepo
vi.mock("@/db/approval.js", () => ({
  approvalRepo: {
    create: vi.fn(),
    findById: vi.fn(),
    update: vi.fn(),
    findBySoulId: vi.fn(),
  },
}));

import { approvalRepo } from "@/db/approval.js";

function createMockTrigger(overrides: Partial<SenseTriggerChunk> = {}): SenseTriggerChunk {
  return {
    type: "sense_trigger",
    id: "approval-123",
    name: "execute_command",
    arguments: '{"command": "ls"}',
    supervisionLevel: "confirm",
    approvalResolve: vi.fn(),
    ...overrides,
  } as SenseTriggerChunk;
}

function createMockCtx(overrides: Partial<MiddlewareContext> = {}): MiddlewareContext {
  return {
    soul: {
      soulId: "soul-1",
      chatId: "chat-1",
      messages: [],
      userInputs: [],
      hashCheck: new Map(),
      senseSharedData: {},
      builtSenses: {},
    },
    global: {
      thinking: true,
      supervision: "confirm",
      stream: true,
      maxLoopCount: 10,
    },
    brain: {
      provider: "ollama",
      model: "test-model",
    },
    adapters: {} as any,
    senseManager: {} as any,
    ...overrides,
  } as MiddlewareContext;
}

describe("ApprovalManager", () => {
  let manager: ApprovalManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new ApprovalManager();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  // --------------------------------------------------------------------------
  // registerFromTrigger
  // --------------------------------------------------------------------------

  describe("registerFromTrigger", () => {
    it("should register approval from trigger", () => {
      const trigger = createMockTrigger();
      manager.registerFromTrigger(trigger, "soul-1", "chat-1");

      const pending = manager.getPendingApprovals();
      expect(pending).toHaveLength(1);
      expect(pending[0]!.approvalId).toBe("approval-123");
      expect(pending[0]!.sc.name).toBe("execute_command");
      expect(pending[0]!.approvalResolve).toBe(trigger.approvalResolve);
    });

    it("should store trigger arguments", () => {
      const trigger = createMockTrigger({
        arguments: '{"command": "rm -rf /"}',
      });
      manager.registerFromTrigger(trigger, "soul-1", "chat-1");

      const entry = manager.getApproval("approval-123");
      expect(entry?.sc.arguments).toBe('{"command": "rm -rf /"}');
    });
  });

  // --------------------------------------------------------------------------
  // createSingleApproval
  // --------------------------------------------------------------------------

  describe("createSingleApproval", () => {
    it("should create approval in database and memory", async () => {
      vi.mocked(approvalRepo.create).mockResolvedValue(undefined);

      const trigger = createMockTrigger();
      const ctx = createMockCtx();
      const approvalId = await manager.createSingleApproval(ctx, trigger);

      expect(approvalId).toBe("approval-123");
      expect(approvalRepo.create).toHaveBeenCalledOnce();

      const entry = manager.getApproval("approval-123");
      expect(entry).toBeDefined();
    });

    it("should create context snapshot", async () => {
      vi.mocked(approvalRepo.create).mockResolvedValue(undefined);

      const trigger = createMockTrigger();
      const ctx = createMockCtx({
        soul: {
          ...createMockCtx().soul,
          messages: [{ role: "user", content: "hello" }],
        },
      });

      await manager.createSingleApproval(ctx, trigger);

      expect(approvalRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          contextSnapshot: expect.objectContaining({
            messages: JSON.stringify([{ role: "user", content: "hello" }]),
          }),
        })
      );
    });
  });

  // --------------------------------------------------------------------------
  // getPendingApprovals
  // --------------------------------------------------------------------------

  describe("getPendingApprovals", () => {
    it("should return empty array when no approvals", () => {
      expect(manager.getPendingApprovals()).toEqual([]);
    });

    it("should return all pending approvals", () => {
      const trigger1 = createMockTrigger({ id: "approval-1" });
      const trigger2 = createMockTrigger({ id: "approval-2" });

      manager.registerFromTrigger(trigger1, "soul-1", "chat-1");
      manager.registerFromTrigger(trigger2, "soul-1", "chat-1");

      const pending = manager.getPendingApprovals();
      expect(pending).toHaveLength(2);
      expect(pending.map((p) => p.approvalId)).toContain("approval-1");
      expect(pending.map((p) => p.approvalId)).toContain("approval-2");
    });
  });

  // --------------------------------------------------------------------------
  // getApproval
  // --------------------------------------------------------------------------

  describe("getApproval", () => {
    it("should return undefined for non-existent approval", () => {
      expect(manager.getApproval("non-existent")).toBeUndefined();
    });

    it("should return approval entry by id", () => {
      const trigger = createMockTrigger();
      manager.registerFromTrigger(trigger, "soul-1", "chat-1");

      const entry = manager.getApproval("approval-123");
      expect(entry?.approvalId).toBe("approval-123");
    });
  });

  // --------------------------------------------------------------------------
  // confirmApproval
  // --------------------------------------------------------------------------

  describe("confirmApproval", () => {
    it("should call approvalResolve with accept action", async () => {
      const mockResolve = vi.fn();
      const trigger = createMockTrigger({ approvalResolve: mockResolve });
      vi.mocked(approvalRepo.update).mockResolvedValue(undefined);

      manager.registerFromTrigger(trigger, "soul-1", "chat-1");
      await manager.confirmApproval("approval-123", "accept", "looks good");

      expect(mockResolve).toHaveBeenCalledWith("accept", "looks good");
      expect(manager.getApproval("approval-123")).toBeUndefined();
    });

    it("should call approvalResolve with reject action", async () => {
      const mockResolve = vi.fn();
      const trigger = createMockTrigger({ approvalResolve: mockResolve });
      vi.mocked(approvalRepo.update).mockResolvedValue(undefined);

      manager.registerFromTrigger(trigger, "soul-1", "chat-1");
      await manager.confirmApproval("approval-123", "reject", "dangerous");

      expect(mockResolve).toHaveBeenCalledWith("reject", "dangerous");
    });

    it("should handle non-existent approval gracefully", async () => {
      vi.mocked(approvalRepo.findById).mockResolvedValue(null);

      await expect(manager.confirmApproval("non-existent", "accept")).resolves.not.toThrow();
    });

    it("should update database status to acknowledged", async () => {
      const trigger = createMockTrigger();
      vi.mocked(approvalRepo.update).mockResolvedValue(undefined);

      manager.registerFromTrigger(trigger, "soul-1", "chat-1");
      await manager.confirmApproval("approval-123", "accept");

      expect(approvalRepo.update).toHaveBeenCalledWith(
        "approval-123",
        expect.objectContaining({ status: "acknowledged" })
      );
    });
  });

  // --------------------------------------------------------------------------
  // cleanupSoul
  // --------------------------------------------------------------------------

  describe("cleanupSoul", () => {
    it("should remove all approvals for a soul", async () => {
      vi.mocked(approvalRepo.findById)
        .mockResolvedValueOnce({ soulId: "soul-1" } as any)
        .mockResolvedValueOnce({ soulId: "soul-1" } as any);

      const trigger1 = createMockTrigger({ id: "approval-1" });
      const trigger2 = createMockTrigger({ id: "approval-2" });
      manager.registerFromTrigger(trigger1, "soul-1", "chat-1");
      manager.registerFromTrigger(trigger2, "soul-1", "chat-1");

      await manager.cleanupSoul("soul-1");

      expect(manager.getPendingApprovals()).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // loadApprovalHandles
  // --------------------------------------------------------------------------

  describe("loadApprovalHandles", () => {
    it("should return empty array for non-existent approval", async () => {
      vi.mocked(approvalRepo.findById).mockResolvedValue(null);

      const handles = await manager.loadApprovalHandles("non-existent");

      expect(handles).toEqual([]);
    });

    it("should return empty array for non-pending approval", async () => {
      vi.mocked(approvalRepo.findById).mockResolvedValue({
        id: "approval-123",
        status: "completed",
        senseCalls: [],
      } as any);

      const handles = await manager.loadApprovalHandles("approval-123");

      expect(handles).toEqual([]);
    });

    it("should load pending approval into memory", async () => {
      vi.mocked(approvalRepo.findById).mockResolvedValue({
        id: "approval-123",
        status: "pending",
        senseCalls: [{ id: "sc-1", name: "test", arguments: "{}", approved: false, triggeredAt: 1000 }],
        createdAt: 1000,
      } as any);

      const handles = await manager.loadApprovalHandles("approval-123");

      expect(handles).toHaveLength(1);
      expect(manager.getApproval("approval-123")).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // loadSoulApprovals
  // --------------------------------------------------------------------------

  describe("loadSoulApprovals", () => {
    it("should load all pending approvals for a soul", async () => {
      vi.mocked(approvalRepo.findBySoulId).mockResolvedValue([
        {
          id: "approval-1",
          status: "pending",
          senseCalls: [{ id: "sc-1", name: "test", arguments: "{}", approved: false, triggeredAt: 1000 }],
          createdAt: 1000,
        },
        {
          id: "approval-2",
          status: "completed",
          senseCalls: [{ id: "sc-2", name: "test2", arguments: "{}", approved: false, triggeredAt: 2000 }],
          createdAt: 2000,
        },
      ] as any);

      const handles = await manager.loadSoulApprovals("soul-1");

      expect(handles).toHaveLength(1);
      expect(handles[0]!.approvalId).toBe("approval-1");
    });
  });

  // --------------------------------------------------------------------------
  // completeApproval
  // --------------------------------------------------------------------------

  describe("completeApproval", () => {
    it("should update status to completed and remove from memory", async () => {
      vi.mocked(approvalRepo.update).mockResolvedValue(undefined);
      const trigger = createMockTrigger();
      manager.registerFromTrigger(trigger, "soul-1", "chat-1");

      await manager.completeApproval("approval-123");

      expect(approvalRepo.update).toHaveBeenCalledWith(
        "approval-123",
        expect.objectContaining({ status: "completed" })
      );
      expect(manager.getApproval("approval-123")).toBeUndefined();
    });
  });
});

// --------------------------------------------------------------------------
// Singleton instance
// --------------------------------------------------------------------------

describe("approvalManager singleton", () => {
  it("should be an instance of ApprovalManager", () => {
    expect(approvalManager).toBeInstanceOf(ApprovalManager);
  });
});