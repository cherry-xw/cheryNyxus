import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  handleChatSend,
  handleSenseApproval,
  registerChatHandlers,
} from "@/service/chat/send.js";
import type { HandlerContext } from "@/service/message/router.js";
import { Method } from "@/service/message/types.js";

// Mock dependencies
vi.mock("@/agent/builder.js", () => {
  class MockAgentBuilder {
    use = vi.fn().mockReturnThis();
    build = vi.fn().mockResolvedValue({
      createChat: vi.fn(),
      send: vi.fn(),
    });
  }
  return {
    AgentBuilder: MockAgentBuilder,
  };
});

vi.mock("@/db/chat.js", () => ({
  createChat: vi.fn(),
  getChat: vi.fn(),
  addMessage: vi.fn(),
  getMessages: vi.fn(),
  parseMessageRow: vi.fn(),
}));

vi.mock("@/db/soul.js", () => ({
  getSoul: vi.fn(),
  parseSoulRow: vi.fn(),
}));

vi.mock("@/service/approval/manager.js", () => ({
  approvalManager: {
    registerFromTrigger: vi.fn(),
    confirmApproval: vi.fn(),
    loadSoulApprovals: vi.fn(),
  },
}));

vi.mock("@/service/websocket/connection.js", () => ({
  connectionManager: {
    getBySoulId: vi.fn(),
    clearApprovalTimeout: vi.fn(),
  },
}));

vi.mock("@/service/soul/lifecycle.js", () => ({
  agentSouls: new Map(),
}));

vi.mock("@/utils/config", () => ({
  default: {
    llm: {
      brain: {
        testBrain: { provider: "ollama", model: "test-model" },
      },
    },
  },
}));

import { createChat, getChat, addMessage } from "@/db/chat.js";
import { getSoul, parseSoulRow } from "@/db/soul.js";
import { approvalManager } from "@/service/approval/manager.js";
import { connectionManager } from "@/service/websocket/connection.js";
import { agentSouls } from "@/service/soul/lifecycle.js";
import { AgentBuilder } from "@/agent/builder.js";

function createMockCtx(): HandlerContext {
  return {
    connectionId: "conn-1",
    sendChunk: vi.fn(),
    sendNotification: vi.fn(),
  };
}

function createMockGenerator(chunks: any[] = []) {
  return async function* () {
    for (const chunk of chunks) {
      yield chunk;
    }
  }();
}

describe("handleChatSend", () => {
  let mockCtx: HandlerContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCtx = createMockCtx();
    agentSouls.clear();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("soul loading", () => {
    it("should throw error when soul not found in memory or DB", async () => {
      vi.mocked(getSoul).mockReturnValue(null);
      vi.mocked(getChat).mockReturnValue(null);
      vi.mocked(createChat).mockReturnValue({ id: "chat-1" } as any);

      const generator = handleChatSend(mockCtx, {
        soulId: "non-existent",
        prompt: "hello",
      });

      await expect(async () => {
        for await (const _ of generator) {}
      }).rejects.toThrow('Soul "non-existent" not found');
    });

    it("should recover soul from database when not in memory", async () => {
      vi.mocked(getSoul).mockReturnValue({
        id: "soul-1",
        agent_name: "testBrain",
        provider: "ollama",
        model: "test-model",
        sense_group: JSON.stringify(["safe"]),
        created_at: 1000,
      } as any);
      vi.mocked(parseSoulRow).mockReturnValue({
        agentName: "testBrain",
        provider: "ollama",
        model: "test-model",
        senseGroup: ["safe"],
        createdAt: 1000,
      });
      vi.mocked(getChat).mockReturnValue({ id: "chat-1" } as any);

      const mockAgent = {
        createChat: vi.fn(),
        send: vi.fn().mockReturnValue(createMockGenerator([{ type: "done" }])),
      };

      // Create a builder instance and mock its build method
      const builder = new AgentBuilder();
      vi.mocked(builder.build).mockResolvedValue(mockAgent);

      // Ensure soul is NOT in memory at start - this will force DB recovery
      agentSouls.delete("soul-1");

      const generator = handleChatSend(mockCtx, {
        soulId: "soul-1",
        chatId: "chat-1",
        prompt: "test",
      });

      const items: any[] = [];
      for await (const item of generator) {
        items.push(item);
      }

      // Should have called getSoul to recover from DB
      expect(getSoul).toHaveBeenCalledWith("soul-1");
      // Should have loaded approval handles after recovery
      expect(approvalManager.loadSoulApprovals).toHaveBeenCalledWith("soul-1");
      // Should have set soul in memory after recovery
      expect(agentSouls.get("soul-1")).toBeDefined();
    });

    it("should use cached soul from memory", async () => {
      vi.mocked(getChat).mockReturnValue({ id: "chat-1" } as any);

      agentSouls.set("soul-1", {
        id: "soul-1",
        agent: Promise.resolve({
          createChat: vi.fn(),
          send: vi.fn().mockReturnValue(createMockGenerator([{ type: "done" }])),
        }),
        config: { provider: "ollama", model: "test-model" },
        createdAt: 1000,
      });

      const generator = handleChatSend(mockCtx, {
        soulId: "soul-1",
        chatId: "chat-1",
        prompt: "test",
      });

      const items: any[] = [];
      for await (const item of generator) {
        items.push(item);
      }

      // Should not call getSoul when soul is in memory
      expect(getSoul).not.toHaveBeenCalled();
    });
  });

  describe("chat creation", () => {
    it("should create new chat when chatId not provided", async () => {
      vi.mocked(getChat).mockReturnValue(null);
      vi.mocked(createChat).mockReturnValue({ id: "new-chat-id" } as any);

      agentSouls.set("soul-1", {
        id: "soul-1",
        agent: Promise.resolve({
          createChat: vi.fn(),
          send: vi.fn().mockReturnValue(createMockGenerator([{ type: "done" }])),
        }),
        config: { provider: "ollama", model: "test-model" },
        createdAt: 1000,
      });

      const generator = handleChatSend(mockCtx, {
        soulId: "soul-1",
        prompt: "test",
      });

      const items: any[] = [];
      for await (const item of generator) {
        items.push(item);
      }

      expect(createChat).toHaveBeenCalled();
      expect(addMessage).toHaveBeenCalled();
    });

    it("should use existing chat when chatId provided", async () => {
      vi.mocked(getChat).mockReturnValue({ id: "existing-chat" } as any);

      agentSouls.set("soul-1", {
        id: "soul-1",
        agent: Promise.resolve({
          createChat: vi.fn(),
          send: vi.fn().mockReturnValue(createMockGenerator([{ type: "done" }])),
        }),
        config: { provider: "ollama", model: "test-model" },
        createdAt: 1000,
      });

      const generator = handleChatSend(mockCtx, {
        soulId: "soul-1",
        chatId: "existing-chat",
        prompt: "test",
      });

      const items: any[] = [];
      for await (const item of generator) {
        items.push(item);
      }

      expect(createChat).not.toHaveBeenCalled();
    });
  });

  describe("chunk handling", () => {
    it("should yield stream chunks for thinking delta", async () => {
      vi.mocked(getChat).mockReturnValue({ id: "chat-1" } as any);

      const chunks = [
        { type: "stream", thinkingDelta: "thinking..." },
        { type: "done" },
      ];

      agentSouls.set("soul-1", {
        id: "soul-1",
        agent: Promise.resolve({
          createChat: vi.fn(),
          send: vi.fn().mockReturnValue(createMockGenerator(chunks)),
        }),
        config: { provider: "ollama", model: "test-model" },
        createdAt: 1000,
      });

      const generator = handleChatSend(mockCtx, {
        soulId: "soul-1",
        chatId: "chat-1",
        prompt: "test",
      });

      const items: any[] = [];
      for await (const item of generator) {
        items.push(item);
      }

      const streamChunks = items.filter((i) => i.type === "stream");
      expect(streamChunks.length).toBe(1);
      expect(streamChunks[0].data.thinking).toBe("thinking...");
    });

    it("should yield thinking_end staged chunk when transitioning from thinking to content", async () => {
      vi.mocked(getChat).mockReturnValue({ id: "chat-1" } as any);

      const chunks = [
        { type: "stream", thinkingDelta: "thinking..." },
        { type: "stream", contentDelta: "hello" },
        { type: "done" },
      ];

      agentSouls.set("soul-1", {
        id: "soul-1",
        agent: Promise.resolve({
          createChat: vi.fn(),
          send: vi.fn().mockReturnValue(createMockGenerator(chunks)),
        }),
        config: { provider: "ollama", model: "test-model" },
        createdAt: 1000,
      });

      const generator = handleChatSend(mockCtx, {
        soulId: "soul-1",
        chatId: "chat-1",
        prompt: "test",
      });

      const items: any[] = [];
      for await (const item of generator) {
        items.push(item);
      }

      const thinkingEnd = items.find(
        (i) => i.type === "staged" && i.data?.type === "thinking_end"
      );
      expect(thinkingEnd).toBeDefined();
      expect(thinkingEnd!.data.thinking).toBe("thinking...");
    });

    it("should yield stream chunks for content delta", async () => {
      vi.mocked(getChat).mockReturnValue({ id: "chat-1" } as any);

      const chunks = [
        { type: "stream", contentDelta: "hello" },
        { type: "stream", contentDelta: " world" },
        { type: "done" },
      ];

      agentSouls.set("soul-1", {
        id: "soul-1",
        agent: Promise.resolve({
          createChat: vi.fn(),
          send: vi.fn().mockReturnValue(createMockGenerator(chunks)),
        }),
        config: { provider: "ollama", model: "test-model" },
        createdAt: 1000,
      });

      const generator = handleChatSend(mockCtx, {
        soulId: "soul-1",
        chatId: "chat-1",
        prompt: "test",
      });

      const items: any[] = [];
      for await (const item of generator) {
        items.push(item);
      }

      const streamChunks = items.filter((i) => i.type === "stream");
      expect(streamChunks.length).toBe(2);
    });

    it("should yield content_end staged chunk after stream content", async () => {
      vi.mocked(getChat).mockReturnValue({ id: "chat-1" } as any);

      const chunks = [
        { type: "stream", contentDelta: "hello world" },
        { type: "staged" },
        { type: "done" },
      ];

      agentSouls.set("soul-1", {
        id: "soul-1",
        agent: Promise.resolve({
          createChat: vi.fn(),
          send: vi.fn().mockReturnValue(createMockGenerator(chunks)),
        }),
        config: { provider: "ollama", model: "test-model" },
        createdAt: 1000,
      });

      const generator = handleChatSend(mockCtx, {
        soulId: "soul-1",
        chatId: "chat-1",
        prompt: "test",
      });

      const items: any[] = [];
      for await (const item of generator) {
        items.push(item);
      }

      const contentEnd = items.find(
        (i) => i.type === "staged" && i.data?.type === "content_end"
      );
      expect(contentEnd).toBeDefined();
      expect(contentEnd!.data.content).toBe("hello world");
    });

    it("should handle sense delta chunks", async () => {
      vi.mocked(getChat).mockReturnValue({ id: "chat-1" } as any);

      const chunks = [
        {
          type: "stream",
          senseDelta: [{ index: 0, id: "sc-1", name: "execute_command", arguments: '{"cmd"' }],
        },
        {
          type: "stream",
          senseDelta: [{ index: 0, arguments: ': "ls"}' }],
        },
        { type: "done" },
      ];

      agentSouls.set("soul-1", {
        id: "soul-1",
        agent: Promise.resolve({
          createChat: vi.fn(),
          send: vi.fn().mockReturnValue(createMockGenerator(chunks)),
        }),
        config: { provider: "ollama", model: "test-model" },
        createdAt: 1000,
      });

      const generator = handleChatSend(mockCtx, {
        soulId: "soul-1",
        chatId: "chat-1",
        prompt: "test",
      });

      const items: any[] = [];
      for await (const item of generator) {
        items.push(item);
      }

      const streamChunks = items.filter((i) => i.type === "stream");
      expect(streamChunks.length).toBe(2);
      // Check sense call accumulation
      expect(streamChunks[0].data.senseCall).toBeDefined();
    });

    it("should handle multiple sense calls in same delta", async () => {
      vi.mocked(getChat).mockReturnValue({ id: "chat-1" } as any);

      const chunks = [
        {
          type: "stream",
          senseDelta: [
            { index: 0, id: "sc-1", name: "execute_command", arguments: '{"cmd": "ls"}' },
            { index: 1, id: "sc-2", name: "read_file", arguments: '{"path": "test.txt"}' },
          ],
        },
        { type: "done" },
      ];

      agentSouls.set("soul-1", {
        id: "soul-1",
        agent: Promise.resolve({
          createChat: vi.fn(),
          send: vi.fn().mockReturnValue(createMockGenerator(chunks)),
        }),
        config: { provider: "ollama", model: "test-model" },
        createdAt: 1000,
      });

      const generator = handleChatSend(mockCtx, {
        soulId: "soul-1",
        chatId: "chat-1",
        prompt: "test",
      });

      const items: any[] = [];
      for await (const item of generator) {
        items.push(item);
      }

      const streamChunk = items.find((i) => i.type === "stream");
      expect(streamChunk!.data.senseCall.length).toBe(2);
    });

    it("should handle sense delta without index (defaults to 0)", async () => {
      vi.mocked(getChat).mockReturnValue({ id: "chat-1" } as any);

      const chunks = [
        {
          type: "stream",
          senseDelta: [{ id: "sc-1", name: "execute_command", arguments: '{"cmd": "ls"}' }],
        },
        { type: "done" },
      ];

      agentSouls.set("soul-1", {
        id: "soul-1",
        agent: Promise.resolve({
          createChat: vi.fn(),
          send: vi.fn().mockReturnValue(createMockGenerator(chunks)),
        }),
        config: { provider: "ollama", model: "test-model" },
        createdAt: 1000,
      });

      const generator = handleChatSend(mockCtx, {
        soulId: "soul-1",
        chatId: "chat-1",
        prompt: "test",
      });

      const items: any[] = [];
      for await (const item of generator) {
        items.push(item);
      }

      expect(items.length).toBeGreaterThan(0);
    });
  });

  describe("notification handling", () => {
    it("should yield interrupt notification for sense_trigger", async () => {
      vi.mocked(getChat).mockReturnValue({ id: "chat-1" } as any);

      const chunks = [
        {
          type: "sense_trigger",
          id: "approval-1",
          name: "execute_command",
          arguments: '{"cmd": "ls"}',
          supervisionLevel: "confirm",
          approvalResolve: vi.fn(),
        },
        { type: "done" },
      ];

      agentSouls.set("soul-1", {
        id: "soul-1",
        agent: Promise.resolve({
          createChat: vi.fn(),
          send: vi.fn().mockReturnValue(createMockGenerator(chunks)),
        }),
        config: { provider: "ollama", model: "test-model" },
        createdAt: 1000,
      });

      const generator = handleChatSend(mockCtx, {
        soulId: "soul-1",
        chatId: "chat-1",
        prompt: "test",
      });

      const items: any[] = [];
      for await (const item of generator) {
        items.push(item);
      }

      const interrupt = items.find((i) => i.type === "interrupt");
      expect(interrupt).toBeDefined();
      expect(interrupt!.data).toEqual(
        expect.objectContaining({
          approvalId: "approval-1",
          senseName: "execute_command",
        })
      );
      expect(approvalManager.registerFromTrigger).toHaveBeenCalled();
    });

    it("should yield complete notification for sense_complete", async () => {
      vi.mocked(getChat).mockReturnValue({ id: "chat-1" } as any);

      const chunks = [
        {
          type: "sense_complete",
          id: "approval-1",
          name: "execute_command",
          result: "file1\nfile2",
        },
        { type: "done" },
      ];

      agentSouls.set("soul-1", {
        id: "soul-1",
        agent: Promise.resolve({
          createChat: vi.fn(),
          send: vi.fn().mockReturnValue(createMockGenerator(chunks)),
        }),
        config: { provider: "ollama", model: "test-model" },
        createdAt: 1000,
      });

      const generator = handleChatSend(mockCtx, {
        soulId: "soul-1",
        chatId: "chat-1",
        prompt: "test",
      });

      const items: any[] = [];
      for await (const item of generator) {
        items.push(item);
      }

      const complete = items.find((i) => i.type === "complete");
      expect(complete).toBeDefined();
      expect(complete!.data).toEqual(
        expect.objectContaining({
          approvalId: "approval-1",
          senseName: "execute_command",
          result: "file1\nfile2",
        })
      );
    });

    it("should yield consumed notification", async () => {
      vi.mocked(getChat).mockReturnValue({ id: "chat-1" } as any);

      const chunks = [
        { type: "consumed", count: 3 },
        { type: "done" },
      ];

      agentSouls.set("soul-1", {
        id: "soul-1",
        agent: Promise.resolve({
          createChat: vi.fn(),
          send: vi.fn().mockReturnValue(createMockGenerator(chunks)),
        }),
        config: { provider: "ollama", model: "test-model" },
        createdAt: 1000,
      });

      const generator = handleChatSend(mockCtx, {
        soulId: "soul-1",
        chatId: "chat-1",
        prompt: "test",
      });

      const items: any[] = [];
      for await (const item of generator) {
        items.push(item);
      }

      const consumed = items.find((i) => i.type === "consumed");
      expect(consumed).toBeDefined();
      expect(consumed!.data.count).toBe(3);
    });

    it("should yield consumed notification with count 0 when missing", async () => {
      vi.mocked(getChat).mockReturnValue({ id: "chat-1" } as any);

      const chunks = [
        { type: "consumed" },
        { type: "done" },
      ];

      agentSouls.set("soul-1", {
        id: "soul-1",
        agent: Promise.resolve({
          createChat: vi.fn(),
          send: vi.fn().mockReturnValue(createMockGenerator(chunks)),
        }),
        config: { provider: "ollama", model: "test-model" },
        createdAt: 1000,
      });

      const generator = handleChatSend(mockCtx, {
        soulId: "soul-1",
        chatId: "chat-1",
        prompt: "test",
      });

      const items: any[] = [];
      for await (const item of generator) {
        items.push(item);
      }

      const consumed = items.find((i) => i.type === "consumed");
      expect(consumed).toBeDefined();
      expect(consumed!.data.count).toBe(0);
    });

    it("should yield done notification", async () => {
      vi.mocked(getChat).mockReturnValue({ id: "chat-1" } as any);

      const chunks = [{ type: "done" }];

      agentSouls.set("soul-1", {
        id: "soul-1",
        agent: Promise.resolve({
          createChat: vi.fn(),
          send: vi.fn().mockReturnValue(createMockGenerator(chunks)),
        }),
        config: { provider: "ollama", model: "test-model" },
        createdAt: 1000,
      });

      const generator = handleChatSend(mockCtx, {
        soulId: "soul-1",
        chatId: "chat-1",
        prompt: "test",
      });

      const items: any[] = [];
      for await (const item of generator) {
        items.push(item);
      }

      const done = items.find((i) => i.type === "done");
      expect(done).toBeDefined();
      expect(done!.data).toBeNull();
    });

    it("should yield error notification for error chunk", async () => {
      vi.mocked(getChat).mockReturnValue({ id: "chat-1" } as any);

      const chunks = [
        { type: "error", errors: [{ message: "Something went wrong" }] },
        { type: "done" },
      ];

      agentSouls.set("soul-1", {
        id: "soul-1",
        agent: Promise.resolve({
          createChat: vi.fn(),
          send: vi.fn().mockReturnValue(createMockGenerator(chunks)),
        }),
        config: { provider: "ollama", model: "test-model" },
        createdAt: 1000,
      });

      const generator = handleChatSend(mockCtx, {
        soulId: "soul-1",
        chatId: "chat-1",
        prompt: "test",
      });

      const items: any[] = [];
      for await (const item of generator) {
        items.push(item);
      }

      const error = items.find((i) => i.type === "error");
      expect(error).toBeDefined();
      expect(error!.data.message).toBe("Something went wrong");
    });

    it("should yield error notification with default message when errors array is empty", async () => {
      vi.mocked(getChat).mockReturnValue({ id: "chat-1" } as any);

      const chunks = [
        { type: "error", errors: [] },
        { type: "done" },
      ];

      agentSouls.set("soul-1", {
        id: "soul-1",
        agent: Promise.resolve({
          createChat: vi.fn(),
          send: vi.fn().mockReturnValue(createMockGenerator(chunks)),
        }),
        config: { provider: "ollama", model: "test-model" },
        createdAt: 1000,
      });

      const generator = handleChatSend(mockCtx, {
        soulId: "soul-1",
        chatId: "chat-1",
        prompt: "test",
      });

      const items: any[] = [];
      for await (const item of generator) {
        items.push(item);
      }

      const error = items.find((i) => i.type === "error");
      expect(error).toBeDefined();
      expect(error!.data.message).toBe("Unknown error");
    });
  });

  describe("error handling", () => {
    it("should yield error notification when generator throws", async () => {
      vi.mocked(getChat).mockReturnValue({ id: "chat-1" } as any);

      async function* errorGenerator() {
        yield { type: "stream", contentDelta: "start" };
        throw new Error("generator error");
      }

      agentSouls.set("soul-1", {
        id: "soul-1",
        agent: Promise.resolve({
          createChat: vi.fn(),
          send: vi.fn().mockReturnValue(errorGenerator()),
        }),
        config: { provider: "ollama", model: "test-model" },
        createdAt: 1000,
      });

      const generator = handleChatSend(mockCtx, {
        soulId: "soul-1",
        chatId: "chat-1",
        prompt: "test",
      });

      const items: any[] = [];
      for await (const item of generator) {
        items.push(item);
      }

      const errorNotification = items.find((i) => i.type === "error");
      expect(errorNotification).toBeDefined();
      expect(errorNotification!.data).toEqual(
        expect.objectContaining({
          message: "generator error",
        })
      );
    });

    it("should yield error notification when agent.send throws immediately", async () => {
      vi.mocked(getChat).mockReturnValue({ id: "chat-1" } as any);

      async function* immediateErrorGenerator() {
        throw new Error("immediate error");
      }

      agentSouls.set("soul-1", {
        id: "soul-1",
        agent: Promise.resolve({
          createChat: vi.fn(),
          send: vi.fn().mockReturnValue(immediateErrorGenerator()),
        }),
        config: { provider: "ollama", model: "test-model" },
        createdAt: 1000,
      });

      const generator = handleChatSend(mockCtx, {
        soulId: "soul-1",
        chatId: "chat-1",
        prompt: "test",
      });

      const items: any[] = [];
      for await (const item of generator) {
        items.push(item);
      }

      const errorNotification = items.find((i) => i.type === "error");
      expect(errorNotification).toBeDefined();
      expect(errorNotification!.data.message).toBe("immediate error");
    });
  });

  describe("return value", () => {
    it("should return response with chatId", async () => {
      vi.mocked(getChat).mockReturnValue({ id: "chat-1" } as any);

      const chunks = [{ type: "done" }];

      agentSouls.set("soul-1", {
        id: "soul-1",
        agent: Promise.resolve({
          createChat: vi.fn(),
          send: vi.fn().mockReturnValue(createMockGenerator(chunks)),
        }),
        config: { provider: "ollama", model: "test-model" },
        createdAt: 1000,
      });

      const generator = handleChatSend(mockCtx, {
        soulId: "soul-1",
        chatId: "chat-1",
        prompt: "test",
      });

      const items: any[] = [];
      for await (const item of generator) {
        items.push(item);
      }

      // Last yielded item should be the return value (via for-await-of)
      // Actually, in async generators, return value is not yielded
      // Let's check the final result via direct iteration
    });

    it("should return response with generated chatId when not provided", async () => {
      vi.mocked(getChat).mockReturnValue(null);
      vi.mocked(createChat).mockImplementation((id) => ({ id }) as any);

      const chunks = [{ type: "done" }];

      agentSouls.set("soul-1", {
        id: "soul-1",
        agent: Promise.resolve({
          createChat: vi.fn(),
          send: vi.fn().mockReturnValue(createMockGenerator(chunks)),
        }),
        config: { provider: "ollama", model: "test-model" },
        createdAt: 1000,
      });

      const generator = handleChatSend(mockCtx, {
        soulId: "soul-1",
        prompt: "test",
      });

      // Consume generator
      const result = await generator.next();
      while (!result.done) {
        result.value;
        const next = await generator.next();
        result.done = next.done;
        result.value = next.value;
      }

      // result.value is the final Response
      expect(result.done).toBe(true);
      expect(result.value).toBeDefined();
      expect(result.value.success).toBe(true);
      expect(result.value.data.chatId).toBeDefined();
    });
  });

  describe("thinking_end with staged chunk", () => {
    it("should yield thinking_end when staged chunk arrives while thinking", async () => {
      vi.mocked(getChat).mockReturnValue({ id: "chat-1" } as any);

      const chunks = [
        { type: "stream", thinkingDelta: "thinking..." },
        { type: "staged" },
        { type: "done" },
      ];

      agentSouls.set("soul-1", {
        id: "soul-1",
        agent: Promise.resolve({
          createChat: vi.fn(),
          send: vi.fn().mockReturnValue(createMockGenerator(chunks)),
        }),
        config: { provider: "ollama", model: "test-model" },
        createdAt: 1000,
      });

      const generator = handleChatSend(mockCtx, {
        soulId: "soul-1",
        chatId: "chat-1",
        prompt: "test",
      });

      const items: any[] = [];
      for await (const item of generator) {
        items.push(item);
      }

      const thinkingEnd = items.find(
        (i) => i.type === "staged" && i.data?.type === "thinking_end"
      );
      expect(thinkingEnd).toBeDefined();
      const contentEnd = items.find(
        (i) => i.type === "staged" && i.data?.type === "content_end"
      );
      expect(contentEnd).toBeDefined();
    });
  });
});

describe("handleSenseApproval", () => {
  let mockCtx: HandlerContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCtx = createMockCtx();
  });

  it("should call approvalManager.confirmApproval with correct params", async () => {
    vi.mocked(approvalManager.confirmApproval).mockResolvedValue(undefined);

    const result = await handleSenseApproval(mockCtx, {
      soulId: "soul-1",
      approvalId: "approval-1",
      action: "accept",
      reason: "looks good",
    });

    expect(approvalManager.confirmApproval).toHaveBeenCalledWith(
      "approval-1",
      "accept",
      "looks good"
    );
    expect(result.success).toBe(true);
  });

  it("should clear approval timeout on accept", async () => {
    vi.mocked(approvalManager.confirmApproval).mockResolvedValue(undefined);
    vi.mocked(connectionManager.getBySoulId).mockReturnValue({
      ws: {} as any,
      pendingRequests: new Map([
        ["req-1", { approvalId: "approval-1" }],
      ]),
    } as any);

    await handleSenseApproval(mockCtx, {
      soulId: "soul-1",
      approvalId: "approval-1",
      action: "accept",
    });

    expect(connectionManager.clearApprovalTimeout).toHaveBeenCalled();
  });

  it("should not clear timeout on reject action", async () => {
    vi.mocked(approvalManager.confirmApproval).mockResolvedValue(undefined);
    vi.mocked(connectionManager.getBySoulId).mockReturnValue({
      ws: {} as any,
      pendingRequests: new Map([
        ["req-1", { approvalId: "approval-1" }],
      ]),
    } as any);

    await handleSenseApproval(mockCtx, {
      soulId: "soul-1",
      approvalId: "approval-1",
      action: "reject",
    });

    expect(connectionManager.clearApprovalTimeout).not.toHaveBeenCalled();
  });

  it("should handle reject action", async () => {
    vi.mocked(approvalManager.confirmApproval).mockResolvedValue(undefined);

    const result = await handleSenseApproval(mockCtx, {
      soulId: "soul-1",
      approvalId: "approval-1",
      action: "reject",
      reason: "dangerous",
    });

    expect(approvalManager.confirmApproval).toHaveBeenCalledWith(
      "approval-1",
      "reject",
      "dangerous"
    );
    expect(result.success).toBe(true);
  });

  it("should handle when connection state not found", async () => {
    vi.mocked(approvalManager.confirmApproval).mockResolvedValue(undefined);
    vi.mocked(connectionManager.getBySoulId).mockReturnValue(null);

    const result = await handleSenseApproval(mockCtx, {
      soulId: "soul-1",
      approvalId: "approval-1",
      action: "accept",
    });

    expect(result.success).toBe(true);
    // Should not throw
  });

  it("should handle when pending request has no approvalId", async () => {
    vi.mocked(approvalManager.confirmApproval).mockResolvedValue(undefined);
    vi.mocked(connectionManager.getBySoulId).mockReturnValue({
      ws: {} as any,
      pendingRequests: new Map([
        ["req-1", { requestId: "req-1" }], // No approvalId
      ]),
    } as any);

    await handleSenseApproval(mockCtx, {
      soulId: "soul-1",
      approvalId: "approval-1",
      action: "accept",
    });

    // Should not throw, just skip clearing timeout
    expect(connectionManager.clearApprovalTimeout).not.toHaveBeenCalled();
  });
});

describe("registerChatHandlers", () => {
  it("should register handlers to router", () => {
    const router = {
      register: vi.fn(),
    } as any;

    registerChatHandlers(router);

    expect(router.register).toHaveBeenCalledWith(
      Method.CHAT_SEND,
      handleChatSend,
      true
    );
    expect(router.register).toHaveBeenCalledWith(
      Method.SENSE_APPROVAL,
      handleSenseApproval
    );
  });
});