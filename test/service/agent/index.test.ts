import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RpcRouter } from "@/service/message/router.js";

// Mock sub-modules so index re-exports don't trigger real deps
vi.mock("@/db/interrupt.js", () => ({
  interruptRepo: {
    create: vi.fn(),
    findById: vi.fn(),
    findBySessionId: vi.fn(),
    findByStatus: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("@/service/agent/interrupt.js", () => ({
  InterruptManager: vi.fn(),
  interruptManager: {},
}));

vi.mock("@/service/agent/lifecycle.js", () => ({
  registerLifecycleHandlers: vi.fn(),
  agentSessions: new Map(),
  handleAgentCreate: vi.fn(),
  handleAgentDelete: vi.fn(),
  handleAgentList: vi.fn(),
}));

vi.mock("@/service/agent/execute.js", () => ({
  registerExecuteHandlers: vi.fn(),
  handleAgentExecute: vi.fn(),
  handleToolApproval: vi.fn(),
}));

vi.mock("@/db/thread.js", () => ({
  createThread: vi.fn(),
  getThread: vi.fn(),
  getMessages: vi.fn(),
  addMessage: vi.fn(),
  parseMessageRow: vi.fn(),
}));

vi.mock("@/agent/builder.js", () => ({
  AgentBuilder: vi.fn(),
}));

vi.mock("@/utils/config", () => ({
  default: { llm: { agent: {} } },
}));

import { registerAgentHandlers } from "@/service/agent/index.js";
import {
  InterruptManager,
  interruptManager,
} from "@/service/agent/interrupt.js";
import {
  RecoveryService,
  recoveryService,
} from "@/service/agent/recovery.js";
import {
  handleAgentCreate,
  handleAgentDelete,
  handleAgentList,
  registerLifecycleHandlers,
} from "@/service/agent/lifecycle.js";
import {
  handleAgentExecute,
  handleToolApproval,
  registerExecuteHandlers,
} from "@/service/agent/execute.js";
import { registerAgentHandlers as registerAgentHandlersDirect } from "@/service/agent/index.js";

describe("service/agent/index", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("registerAgentHandlers", () => {
    it("registers lifecycle and execute handlers", () => {
      const mockRouter = {} as RpcRouter;
      registerAgentHandlers(mockRouter);

      expect(registerLifecycleHandlers).toHaveBeenCalledWith(mockRouter);
      expect(registerExecuteHandlers).toHaveBeenCalledWith(mockRouter);
    });
  });

  describe("exports", () => {
    it("exports InterruptManager class", () => {
      expect(InterruptManager).toBeDefined();
    });

    it("exports interruptManager singleton", () => {
      expect(interruptManager).toBeDefined();
    });

    it("exports RecoveryService class", () => {
      expect(RecoveryService).toBeDefined();
    });

    it("exports recoveryService singleton", () => {
      expect(recoveryService).toBeDefined();
    });

    it("exports handleAgentCreate", () => {
      expect(handleAgentCreate).toBeDefined();
    });

    it("exports handleAgentDelete", () => {
      expect(handleAgentDelete).toBeDefined();
    });

    it("exports handleAgentList", () => {
      expect(handleAgentList).toBeDefined();
    });

    it("exports handleAgentExecute", () => {
      expect(handleAgentExecute).toBeDefined();
    });

    it("exports handleToolApproval", () => {
      expect(handleToolApproval).toBeDefined();
    });

    it("exports registerAgentHandlers", () => {
      expect(registerAgentHandlersDirect).toBeDefined();
      expect(typeof registerAgentHandlersDirect).toBe("function");
    });
  });
});
