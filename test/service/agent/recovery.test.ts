import { describe, it, expect, vi, beforeEach } from "vitest";
import type { InterruptEntity, ContextSnapshot } from "@/db/interrupt.js";
import type { ClientConfig } from "@/utils/config.js";

// vi.hoisted ensures the mock objects exist when hoisted vi.mock factories run
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

const mockInterruptManager = vi.hoisted(() => ({
  resumeInterrupt: vi.fn().mockResolvedValue(null),
  confirmHandle: vi.fn().mockResolvedValue(undefined),
  completeInterrupt: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/service/agent/interrupt.js", () => ({
  interruptManager: mockInterruptManager,
  InterruptManager: vi.fn(),
}));

// Import after mocks
import { RecoveryService } from "@/service/agent/recovery.js";

function createMockEntity(overrides: Partial<InterruptEntity> = {}): InterruptEntity {
  return {
    id: "int-1",
    threadId: "thread-1",
    sessionId: "sess-1",
    status: "pending",
    toolCalls: [],
    contextSnapshot: {
      history: [],
      toolCallAccumulated: [],
      pendingInputs: [],
      config: {
        provider: "test",
        model: "gpt-4",
        tool_group: ["safe"],
      },
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function createTestConfig(overrides: Partial<ClientConfig> = {}): ClientConfig {
  return {
    url: "http://localhost",
    provider: "test",
    model: "gpt-4",
    tool_group: ["safe"],
    ...overrides,
  };
}

describe("RecoveryService", () => {
  let service: RecoveryService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new RecoveryService();
  });

  describe("loadPendingInterrupts", () => {
    it("delegates to repo.findByStatus with pending", async () => {
      const entities = [createMockEntity()];
      mockRepo.findByStatus.mockResolvedValue(entities);

      const result = await service.loadPendingInterrupts();
      expect(mockRepo.findByStatus).toHaveBeenCalledWith("pending");
      expect(result).toEqual(entities);
    });
  });

  describe("resumeSession", () => {
    it("returns ResumableSession[] for pending interrupts", async () => {
      const entity = createMockEntity();
      mockRepo.findBySessionId.mockResolvedValue([entity]);

      const result = await service.resumeSession("sess-1");
      expect(result).toHaveLength(1);
      expect(result[0]!.interruptId).toBe("int-1");
      expect(result[0]!.threadId).toBe("thread-1");
      expect(result[0]!.configSnapshot).toEqual({
        provider: "test",
        model: "gpt-4",
        tool_group: ["safe"],
      });
    });

    it("filters non-pending interrupts", async () => {
      const pending = createMockEntity({ status: "pending" });
      const acknowledged = createMockEntity({
        id: "int-2",
        status: "acknowledged",
      });
      mockRepo.findBySessionId.mockResolvedValue([pending, acknowledged]);

      const result = await service.resumeSession("sess-1");
      expect(result).toHaveLength(1);
      expect(result[0]!.interruptId).toBe("int-1");
    });
  });

  describe("validateConfigCompatibility", () => {
    it("returns compatible when configs match", async () => {
      const entity = createMockEntity();
      mockRepo.findById.mockResolvedValue(entity);

      const result = await service.validateConfigCompatibility(
        "int-1",
        createTestConfig(),
      );
      expect(result.compatible).toBe(true);
      expect(result.mismatches).toHaveLength(0);
    });

    it("detects provider mismatch", async () => {
      const entity = createMockEntity();
      mockRepo.findById.mockResolvedValue(entity);

      const result = await service.validateConfigCompatibility(
        "int-1",
        createTestConfig({ provider: "ollama" }),
      );
      expect(result.compatible).toBe(false);
      expect(result.mismatches).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: "provider" }),
        ]),
      );
    });

    it("detects model mismatch", async () => {
      const entity = createMockEntity();
      mockRepo.findById.mockResolvedValue(entity);

      const result = await service.validateConfigCompatibility(
        "int-1",
        createTestConfig({ model: "claude-3" }),
      );
      expect(result.compatible).toBe(false);
      expect(result.mismatches).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: "model" }),
        ]),
      );
    });

    it("detects tool_group mismatch", async () => {
      const entity = createMockEntity();
      mockRepo.findById.mockResolvedValue(entity);

      const result = await service.validateConfigCompatibility(
        "int-1",
        createTestConfig({ tool_group: ["dangerous"] }),
      );
      expect(result.compatible).toBe(false);
      expect(result.mismatches).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: "tool_group" }),
        ]),
      );
    });

    it("returns incompatible for missing interrupt", async () => {
      mockRepo.findById.mockResolvedValue(null);

      const result = await service.validateConfigCompatibility(
        "nonexistent",
        createTestConfig(),
      );
      expect(result.compatible).toBe(false);
      expect(result.reason).toBe("Interrupt not found");
    });
  });

  describe("resumeAndContinue", () => {
    it("succeeds with matching config", async () => {
      const entity = createMockEntity();
      mockRepo.findById.mockResolvedValue(entity);

      const snapshot: ContextSnapshot = {
        history: [],
        toolCallAccumulated: [],
        pendingInputs: [],
        config: { provider: "test", model: "gpt-4", tool_group: ["safe"] },
      };
      mockInterruptManager.resumeInterrupt.mockResolvedValue(snapshot);

      const decisions = new Map<string, { action: "accept" | "reject"; reason?: string }>();
      decisions.set("handle-1", { action: "accept" });

      const result = await service.resumeAndContinue(
        "int-1",
        createTestConfig(),
        decisions,
      );

      expect(result.success).toBe(true);
      expect(result.snapshot).toEqual(snapshot);
    });

    it("fails with CONFIG_MISMATCH", async () => {
      const entity = createMockEntity();
      mockRepo.findById.mockResolvedValue(entity);

      const result = await service.resumeAndContinue(
        "int-1",
        createTestConfig({ provider: "ollama" }),
        new Map(),
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("CONFIG_MISMATCH");
    });

    it("fails when interrupt not found", async () => {
      // First call: validateConfigCompatibility -> findById returns entity (pass)
      const entity = createMockEntity();
      mockRepo.findById.mockResolvedValue(entity);
      // But resumeInterrupt returns null
      mockInterruptManager.resumeInterrupt.mockResolvedValue(null);

      const result = await service.resumeAndContinue(
        "int-1",
        createTestConfig(),
        new Map(),
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("Interrupt not found or no snapshot");
    });

    it("applies decisions via confirmHandle", async () => {
      const entity = createMockEntity();
      mockRepo.findById.mockResolvedValue(entity);

      const snapshot: ContextSnapshot = {
        history: [],
        toolCallAccumulated: [],
        pendingInputs: [],
        config: { provider: "test", model: "gpt-4", tool_group: ["safe"] },
      };
      mockInterruptManager.resumeInterrupt.mockResolvedValue(snapshot);

      const decisions = new Map<string, { action: "accept" | "reject"; reason?: string }>();
      decisions.set("h-1", { action: "accept" });
      decisions.set("h-2", { action: "reject", reason: "unsafe" });

      await service.resumeAndContinue("int-1", createTestConfig(), decisions);

      expect(mockInterruptManager.confirmHandle).toHaveBeenCalledWith("h-1", "accept", undefined);
      expect(mockInterruptManager.confirmHandle).toHaveBeenCalledWith("h-2", "reject", "unsafe");
    });

    it("marks interrupt completed", async () => {
      const entity = createMockEntity();
      mockRepo.findById.mockResolvedValue(entity);

      const snapshot: ContextSnapshot = {
        history: [],
        toolCallAccumulated: [],
        pendingInputs: [],
        config: { provider: "test", model: "gpt-4", tool_group: ["safe"] },
      };
      mockInterruptManager.resumeInterrupt.mockResolvedValue(snapshot);

      await service.resumeAndContinue("int-1", createTestConfig(), new Map());

      expect(mockInterruptManager.completeInterrupt).toHaveBeenCalledWith("int-1");
    });
  });
});
