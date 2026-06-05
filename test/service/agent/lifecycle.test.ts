import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { HandlerContext } from "@/service/message/router.js";
import type { RpcRouter } from "@/service/message/router.js";

// In-memory database mock for testing
const mockSessions: Map<string, {
  id: string;
  agent_name: string;
  provider: string;
  model: string;
  tool_group: string | null;
  created_at: number;
  updated_at: number;
}> = new Map();

vi.mock("@/db/session.js", () => ({
  createSession: vi.fn((sessionId: string, data: { agentName: string; provider: string; model: string; toolGroup?: string | string[] }) => {
    const now = Date.now();
    const toolGroupStr = typeof data.toolGroup === "string"
      ? data.toolGroup
      : data.toolGroup
        ? JSON.stringify(data.toolGroup)
        : null;
    const row = {
      id: sessionId,
      agent_name: data.agentName,
      provider: data.provider,
      model: data.model,
      tool_group: toolGroupStr,
      created_at: now,
      updated_at: now,
    };
    mockSessions.set(sessionId, row);
    return row;
  }),
  getSession: vi.fn((sessionId: string) => mockSessions.get(sessionId)),
  listSessions: vi.fn(() => Array.from(mockSessions.values())),
  deleteSession: vi.fn((sessionId: string) => {
    mockSessions.delete(sessionId);
  }),
  parseSessionRow: vi.fn((row: { id: string; agent_name: string; provider: string; model: string; tool_group: string | null; created_at: number }) => ({
    id: row.id,
    agentName: row.agent_name,
    provider: row.provider,
    model: row.model,
    toolGroup: row.tool_group
      ? (row.tool_group.startsWith("[")
        ? JSON.parse(row.tool_group)
        : row.tool_group)
      : undefined,
    createdAt: row.created_at,
  })),
}));

vi.mock("@/db/thread.js", () => ({
  listThreadsBySession: vi.fn(() => []),
  getMessages: vi.fn(() => []),
  parseMessageRow: vi.fn(),
}));

vi.mock("@/db/interrupt.js", () => ({
  interruptRepo: {
    findBySessionId: vi.fn(async () => []),
  },
}));

// Hoisted mock — factory must be self-contained (no external vi.fn references)
vi.mock("@/agent/builder.js", () => ({
  AgentBuilder: vi.fn(function(this: any) {
    this.use = vi.fn().mockReturnThis();
    this.build = vi.fn().mockResolvedValue({});
  }),
}));

vi.mock("@/utils/config", () => ({
  default: {
    llm: {
      agent: {
        testAgent: {
          provider: "test",
          model: "gpt-test",
          tool_group: ["safe"],
        },
      },
    },
  },
}));

// Must import after mocks are set up
import {
  handleAgentCreate,
  handleAgentDelete,
  handleAgentList,
  handleAgentSession,
  registerLifecycleHandlers,
  agentSessions,
} from "@/service/agent/lifecycle.js";
import { AgentBuilder } from "@/agent/builder.js";
import { Method } from "@/service/message/types.js";

function createMockCtx(overrides?: Partial<HandlerContext>): HandlerContext {
  return {
    sessionId: undefined,
    connectionId: "conn-1",
    sendEvent: vi.fn(),
    setTimeout: vi.fn(),
    clearTimeout: vi.fn(),
    ...overrides,
  };
}

describe("lifecycle", () => {
  beforeEach(async () => {
    agentSessions.clear();
    mockSessions.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    agentSessions.clear();
    mockSessions.clear();
  });

  describe("handleAgentCreate", () => {
    it("creates session and returns sessionId + config", async () => {
      const ctx = createMockCtx();
      const result = await handleAgentCreate(ctx, {
        agent: "testAgent",
        sessionId: "sess-1",
      }) as { sessionId: string; config: unknown; createdAt: number };

      expect(result.sessionId).toBe("sess-1");
      expect(result.config).toEqual({
        provider: "test",
        model: "gpt-test",
        tool_group: ["safe"],
      });
      expect(result.createdAt).toBeDefined();
      expect(agentSessions.has("sess-1")).toBe(true);
    });

    it("creates session with custom sessionId", async () => {
      const ctx = createMockCtx();
      const result = await handleAgentCreate(ctx, {
        agent: "testAgent",
        sessionId: "my-custom-id",
      }) as { sessionId: string };

      expect(result.sessionId).toBe("my-custom-id");
      expect(agentSessions.has("my-custom-id")).toBe(true);
    });

    it("generates UUID when no sessionId provided", async () => {
      const ctx = createMockCtx();
      const result = await handleAgentCreate(ctx, {
        agent: "testAgent",
      }) as { sessionId: string };

      expect(result.sessionId).toBeDefined();
      expect(typeof result.sessionId).toBe("string");
      expect(result.sessionId.length).toBeGreaterThan(0);
      expect(agentSessions.has(result.sessionId)).toBe(true);
    });

    it("sets ctx.sessionId to the created session id", async () => {
      const ctx = createMockCtx();
      await handleAgentCreate(ctx, {
        agent: "testAgent",
        sessionId: "sess-ctx",
      });

      expect(ctx.sessionId).toBe("sess-ctx");
    });

    it("recovers existing session when sessionId already exists in database", async () => {
      // Pre-populate mock database
      mockSessions.set("sess-existing", {
        id: "sess-existing",
        agent_name: "testAgent",
        provider: "test",
        model: "gpt-test",
        tool_group: JSON.stringify(["safe"]),
        created_at: 1000,
        updated_at: 1000,
      });

      const ctx = createMockCtx();
      const result = await handleAgentCreate(ctx, {
        agent: "testAgent",
        sessionId: "sess-existing",
      }) as { sessionId: string; recovered: boolean; createdAt: number };

      expect(result.sessionId).toBe("sess-existing");
      expect(result.recovered).toBe(true);
      expect(result.createdAt).toBe(1000);
      expect(agentSessions.has("sess-existing")).toBe(true);
    });
  });

  describe("handleAgentDelete", () => {
    it("removes session", async () => {
      const ctx = createMockCtx();
      // Create first
      await handleAgentCreate(ctx, { agent: "testAgent", sessionId: "sess-del" });
      expect(agentSessions.has("sess-del")).toBe(true);
      expect(mockSessions.has("sess-del")).toBe(true);

      const result = await handleAgentDelete(ctx, { sessionId: "sess-del" }) as { sessionId: string };
      expect(result.sessionId).toBe("sess-del");
      expect(agentSessions.has("sess-del")).toBe(false);
      expect(mockSessions.has("sess-del")).toBe(false);
    });

    it("throws for unknown session", async () => {
      const ctx = createMockCtx();
      await expect(
        handleAgentDelete(ctx, { sessionId: "nonexistent" }),
      ).rejects.toThrow('Session "nonexistent" not found');
    });
  });

  describe("handleAgentList", () => {
    it("returns empty when no sessions", async () => {
      const ctx = createMockCtx();
      const result = await handleAgentList(ctx, {}) as { sessions: unknown[] };
      expect(result.sessions).toEqual([]);
    });

    it("returns all sessions from database", async () => {
      const ctx = createMockCtx();
      await handleAgentCreate(ctx, { agent: "testAgent", sessionId: "sess-a" });
      await handleAgentCreate(ctx, { agent: "testAgent", sessionId: "sess-b" });

      const result = await handleAgentList(ctx, {}) as { sessions: Array<{ sessionId: string; config: unknown; createdAt: number }> };
      expect(result.sessions).toHaveLength(2);
      const ids = result.sessions.map(s => s.sessionId).sort();
      expect(ids).toEqual(["sess-a", "sess-b"]);
      // Check createdAt field
      expect(result.sessions.every(s => s.createdAt !== undefined)).toBe(true);
    });
  });

  describe("handleAgentSession", () => {
    it("returns session details with threads and pendingInterrupts", async () => {
      const ctx = createMockCtx();
      await handleAgentCreate(ctx, { agent: "testAgent", sessionId: "sess-detail" });

      const result = await handleAgentSession(ctx, { sessionId: "sess-detail" }) as {
        sessionId: string;
        config: unknown;
        createdAt: number;
        threads: unknown[];
        pendingInterrupts: unknown[];
      };

      expect(result.sessionId).toBe("sess-detail");
      expect(result.config).toBeDefined();
      expect(result.createdAt).toBeDefined();
      expect(result.threads).toEqual([]);
      expect(result.pendingInterrupts).toEqual([]);
    });

    it("throws for unknown session", async () => {
      const ctx = createMockCtx();
      await expect(
        handleAgentSession(ctx, { sessionId: "nonexistent" }),
      ).rejects.toThrow('Session "nonexistent" not found');
    });
  });

  describe("registerLifecycleHandlers", () => {
    it("registers 4 methods on the router", () => {
      const registered: Array<{ method: string; streaming: boolean }> = [];
      const mockRouter = {
        register: vi.fn((method: string, _handler: unknown, streaming?: boolean) => {
          registered.push({ method, streaming: !!streaming });
        }),
      } as unknown as RpcRouter;

      registerLifecycleHandlers(mockRouter);

      expect(mockRouter.register).toHaveBeenCalledTimes(4);
      expect(registered.map(r => r.method)).toEqual([
        Method.AGENT_CREATE,
        Method.AGENT_DELETE,
        Method.AGENT_LIST,
        Method.AGENT_SESSION,
      ]);
      // None should be streaming
      expect(registered.every(r => !r.streaming)).toBe(true);
    });
  });
});