import { describe, it, expect, beforeEach } from "vitest";
import { CheckpointState } from "@/agent/middleware/checkpointState";
import type { MiddlewareContext } from "@/core/middleware/types";
import type { SenseCallData } from "@/core/sense/adapter";

// Mock randomUUID for consistent testing
vi.mock("crypto", () => ({
  randomUUID: vi.fn(() => "test-uuid-1234"),
}));

// 创建 Mock 上下文
function createMockContext(overrides: Partial<MiddlewareContext> = {}): MiddlewareContext {
  return {
    soul: {
      soulId: "test-soul",
      chatId: "test-chat",
      hashCheck: new Map(),
      senseSharedData: new Map(),
      userInputs: [],
      builtSenses: [],
      messages: [],
    },
    global: {
      thinking: false,
      supervision: 0,
      stream: true,
      maxLoopCount: 10,
    },
    brain: {
      provider: "test",
      model: "test-model",
      url: "http://localhost",
      key: "",
      sense_group: [],
    },
    adapters: {
      llmAdapter: {} as any,
      messageAdapter: {} as any,
      senseAdapter: {} as any,
    },
    senseManager: {} as any,
    ...overrides,
  } as MiddlewareContext;
}

describe("CheckpointState", () => {
  let state: CheckpointState;

  beforeEach(() => {
    state = new CheckpointState();
  });

  describe("ingest - stream chunk", () => {
    it("should accumulate thinking delta", () => {
      state.ingest({
        type: "stream",
        thinkingDelta: "Hello ",
      });

      expect(state.getThinking()).toBe("Hello ");

      state.ingest({
        type: "stream",
        thinkingDelta: "world",
      });

      expect(state.getThinking()).toBe("Hello world");
    });

    it("should accumulate content delta", () => {
      state.ingest({
        type: "stream",
        contentDelta: "Hello ",
      });

      expect(state.getContent()).toBe("Hello ");

      state.ingest({
        type: "stream",
        contentDelta: "world",
      });

      expect(state.getContent()).toBe("Hello world");
    });

    it("should accumulate senseDelta", () => {
      const senseDelta: SenseCallData[] = [
        { index: 0, id: "sense-1", name: "execute_command", arguments: '{"cmd":' },
      ];

      state.ingest({
        type: "stream",
        senseDelta,
      });

      state.ingest({
        type: "stream",
        senseDelta: [{ index: 0, arguments: ' "ls"}' }],
      });
    });

    it("should handle undefined deltas gracefully", () => {
      state.ingest({
        type: "stream",
      });

      expect(state.getThinking()).toBe("");
      expect(state.getContent()).toBe("");
    });
  });

  describe("ingest - sense result chunks", () => {
    it("should store sense result", () => {
      // Need content to trigger message append
      state.ingest({ type: "stream", contentDelta: "Response" });
      state.ingest({
        type: "sense_accept",
        id: "sense-1",
        name: "execute_command",
        result: "file1.txt",
      });

      // Verify via appendResponseMessages
      const ctx = createMockContext();
      state.appendResponseMessages(ctx);

      const senseMsg = ctx.soul.messages?.find((m) => m.role === "sense");
      expect(senseMsg).toBeDefined();
      expect((senseMsg as any).content).toBe("file1.txt");
    });
  });

  describe("getStagedData", () => {
    it("should return accumulated thinking and content", () => {
      state.ingest({ type: "stream", thinkingDelta: "thinking", contentDelta: "content" });

      const staged = state.getStagedData();
      expect(staged.thinking).toBe("thinking");
      expect(staged.content).toBe("content");
    });

    it("should return empty strings when nothing accumulated", () => {
      const staged = state.getStagedData();
      expect(staged.thinking).toBe("");
      expect(staged.content).toBe("");
    });
  });

  describe("appendResponseMessages", () => {
    it("should append assistant message with content", () => {
      const ctx = createMockContext();

      state.ingest({ type: "stream", contentDelta: "Hello world" });
      state.appendResponseMessages(ctx);

      expect(ctx.soul.messages).toHaveLength(1);
      const msg = ctx.soul.messages?.[0];
      expect(msg?.role).toBe("assistant");
      expect((msg as any).content).toBe("Hello world");
    });

    it("should append assistant message with thinking", () => {
      const ctx = createMockContext();

      state.ingest({ type: "stream", thinkingDelta: "I am thinking..." });
      state.appendResponseMessages(ctx);

      expect(ctx.soul.messages).toHaveLength(1);
      const msg = ctx.soul.messages?.[0];
      expect(msg?.role).toBe("assistant");
      expect((msg as any).thinking).toBe("I am thinking...");
    });

    it("should not append if no content, thinking, or senseCalls", () => {
      const ctx = createMockContext();

      state.appendResponseMessages(ctx);

      expect(ctx.soul.messages).toHaveLength(0);
    });

    it("should append sense result messages after assistant message", () => {
      const ctx = createMockContext();

      state.ingest({ type: "stream", contentDelta: "I will run a command" });
      state.ingest({
        type: "sense_accept",
        id: "sense-1",
        name: "execute_command",
        result: "file1.txt",
      });
      state.appendResponseMessages(ctx);

      expect(ctx.soul.messages).toHaveLength(2);
      expect(ctx.soul.messages?.[0]?.role).toBe("assistant");
      expect(ctx.soul.messages?.[1]?.role).toBe("sense");
      expect((ctx.soul.messages?.[1] as any).content).toBe("file1.txt");
    });

    it("should append to existing messages", () => {
      const ctx = createMockContext({
        soul: {
          soulId: "test-soul",
          chatId: "test-chat",
          hashCheck: new Map(),
          senseSharedData: new Map(),
          userInputs: [],
          builtSenses: [],
          messages: [{ id: "existing", role: "user", content: "Hello", createdAt: 0, updateAt: 0 }],
        },
      });

      state.ingest({ type: "stream", contentDelta: "Response" });
      state.appendResponseMessages(ctx);

      expect(ctx.soul.messages).toHaveLength(2);
      expect(ctx.soul.messages?.[0]?.role).toBe("user");
      expect(ctx.soul.messages?.[1]?.role).toBe("assistant");
    });

    it("should handle senseDelta and create senseCalls", () => {
      const ctx = createMockContext();

      state.ingest({
        type: "stream",
        senseDelta: [{ index: 0, id: "sense-1", name: "execute_command", arguments: '{"cmd":"ls"}' }],
      });
      state.appendResponseMessages(ctx);

      expect(ctx.soul.messages).toHaveLength(1);
      const msg = ctx.soul.messages?.[0];
      expect((msg as any).senseCalls).toBeDefined();
      expect((msg as any).senseCalls).toHaveLength(1);
      expect((msg as any).senseCalls[0].name).toBe("execute_command");
    });

    it("should merge senseDelta fragments by index", () => {
      const ctx = createMockContext();

      state.ingest({
        type: "stream",
        senseDelta: [{ index: 0, id: "sense-1", name: "execute_command", arguments: '{"cmd":' }],
      });
      state.ingest({
        type: "stream",
        senseDelta: [{ index: 0, arguments: ' "ls"}' }],
      });
      state.appendResponseMessages(ctx);

      const msg = ctx.soul.messages?.[0];
      expect((msg as any).senseCalls).toHaveLength(1);
      expect((msg as any).senseCalls[0].arguments).toBe('{"cmd": "ls"}');
    });
  });

  describe("getContent", () => {
    it("should return accumulated content", () => {
      state.ingest({ type: "stream", contentDelta: "Hello " });
      state.ingest({ type: "stream", contentDelta: "world" });

      expect(state.getContent()).toBe("Hello world");
    });
  });

  describe("getThinking", () => {
    it("should return accumulated thinking", () => {
      state.ingest({ type: "stream", thinkingDelta: "Let me think... " });
      state.ingest({ type: "stream", thinkingDelta: "about this" });

      expect(state.getThinking()).toBe("Let me think... about this");
    });
  });
});
