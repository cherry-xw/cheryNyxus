import { describe, it, expect, vi, beforeEach } from "vitest";
import type { HandlerContext } from "@/service/message/router.js";
import type { RpcRouter } from "@/service/message/router.js";
import type { RpcEvent, RpcTool } from "@/service/message/types.js";
import type { ToolChunk } from "@/agent/middleware/tool.js";

// Mock db/thread
const mockCreateThread = vi.fn().mockReturnValue({
  id: "thread-1",
  session_id: "sess-1",
  created_at: Date.now(),
  updated_at: Date.now(),
  metadata: null,
});
const mockGetThread = vi.fn().mockReturnValue(undefined);
const mockGetMessages = vi.fn().mockReturnValue([]);
const mockAddMessage = vi.fn();
const mockParseMessageRow = vi.fn().mockImplementation((r: unknown) => r);

vi.mock("@/db/thread.js", () => ({
  createThread: (...args: unknown[]) => mockCreateThread(...args),
  getThread: (...args: unknown[]) => mockGetThread(...args),
  getMessages: (...args: unknown[]) => mockGetMessages(...args),
  addMessage: (...args: unknown[]) => mockAddMessage(...args),
  parseMessageRow: (...args: unknown[]) => mockParseMessageRow(...args),
}));

// Mock lifecycle — provide a mutable sessions map we control
const mockSessions = new Map<string, { id: string; agent: any; config: unknown }>();
vi.mock("@/service/agent/lifecycle.js", () => ({
  get agentSessions() {
    return mockSessions;
  },
}));

// Mock interruptManager
const mockConfirmHandle = vi.fn().mockResolvedValue(undefined);
vi.mock("@/service/agent/interrupt.js", () => ({
  interruptManager: {
    confirmHandle: (...args: unknown[]) => mockConfirmHandle(...args),
  },
}));

// Import after mocks
import {
  handleAgentExecute,
  handleToolApproval,
  registerExecuteHandlers,
} from "@/service/agent/execute.js";
import { EventType, Method } from "@/service/message/types.js";

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

function setupMockSession(agent: unknown) {
  mockSessions.set("sess-1", {
    id: "sess-1",
    agent: Promise.resolve(agent),
    config: { provider: "test", model: "gpt-4", sense_group: ["safe"] },
  });
}

/** Collect all values from an AsyncGenerator into an array */
async function collectGenerator(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
  const items: unknown[] = [];
  for await (const item of gen) {
    items.push(item);
  }
  return items;
}

describe("handleAgentExecute", () => {
  const mockAgentCreateThread = vi.fn();
  const mockAgentSend = vi.fn();

  function createMockAgent(generator: AsyncGenerator) {
    return {
      createThread: mockAgentCreateThread,
      send: mockAgentSend.mockReturnValue(generator),
    };
  }

  /** Helper to create an async generator from a list of chunks */
  async function* chunksToGenerator(chunks: unknown[]): AsyncGenerator<unknown> {
    for (const chunk of chunks) {
      yield chunk;
    }
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockSessions.clear();
  });

  it("throws when session not found", async () => {
    const ctx = createMockCtx();
    const gen = handleAgentExecute(ctx, {
      sessionId: "nonexistent",
      prompt: "hello",
    });

    // The throw in handleAgentExecute is outside the try/catch,
    // so it propagates as an error from the async generator
    await expect(collectGenerator(gen)).rejects.toThrow(
      'Session "nonexistent" not found',
    );
  });

  it("creates thread when threadId not provided", async () => {
    mockGetThread.mockReturnValue(undefined);
    const agent = createMockAgent(chunksToGenerator([{ type: "done" }]));
    setupMockSession(agent);

    const ctx = createMockCtx();
    await collectGenerator(
      handleAgentExecute(ctx, { sessionId: "sess-1", prompt: "hello" }),
    );

    expect(mockCreateThread).toHaveBeenCalled();
  });

  it("uses existing thread when threadId provided and exists", async () => {
    const existingThread = {
      id: "thread-exist",
      session_id: "sess-1",
      created_at: Date.now(),
      updated_at: Date.now(),
      metadata: null,
    };
    mockGetThread.mockReturnValue(existingThread);
    const agent = createMockAgent(chunksToGenerator([{ type: "done" }]));
    setupMockSession(agent);

    const ctx = createMockCtx();
    await collectGenerator(
      handleAgentExecute(ctx, {
        sessionId: "sess-1",
        threadId: "thread-exist",
        prompt: "hello",
      }),
    );

    expect(mockCreateThread).not.toHaveBeenCalled();
  });

  it("loads history messages", async () => {
    const msgRows = [{ id: "m1", role: "user", content: "hi" }];
    mockGetThread.mockReturnValue({ id: "thread-1" });
    mockGetMessages.mockReturnValue(msgRows);
    const agent = createMockAgent(chunksToGenerator([{ type: "done" }]));
    setupMockSession(agent);

    const ctx = createMockCtx();
    await collectGenerator(
      handleAgentExecute(ctx, {
        sessionId: "sess-1",
        threadId: "thread-1",
        prompt: "hello",
      }),
    );

    expect(mockGetMessages).toHaveBeenCalledWith("thread-1");
    expect(mockParseMessageRow).toHaveBeenCalled();
  });

  it("adds user message to DB", async () => {
    mockGetThread.mockReturnValue({ id: "thread-1" });
    const agent = createMockAgent(chunksToGenerator([{ type: "done" }]));
    setupMockSession(agent);

    const ctx = createMockCtx();
    await collectGenerator(
      handleAgentExecute(ctx, {
        sessionId: "sess-1",
        threadId: "thread-1",
        prompt: "hello world",
      }),
    );

    expect(mockAddMessage).toHaveBeenCalledWith(
      expect.any(String),
      "thread-1",
      expect.objectContaining({ role: "user", content: "hello world" }),
    );
  });

  it("yields STREAM events for contentDelta", async () => {
    mockGetThread.mockReturnValue({ id: "thread-1" });
    const agent = createMockAgent(
      chunksToGenerator([
        {
          type: "stream",
          contentDelta: "hello",
          contentAccumulated: "hello",
          thinkingDelta: "",
          thinkingAccumulated: "",
          raw: null,
        },
        { type: "done" },
      ]),
    );
    setupMockSession(agent);

    const ctx = createMockCtx();
    const items = await collectGenerator(
      handleAgentExecute(ctx, {
        sessionId: "sess-1",
        threadId: "thread-1",
        prompt: "test",
      }),
    );

    const streamEvent = items.find(
      (i: any) =>
        i.kind === "event" &&
        i.event === EventType.STREAM &&
        (i as RpcEvent).data?.contentDelta === "hello",
    );
    expect(streamEvent).toBeDefined();
  });

  it("yields STREAM events for thinkingDelta", async () => {
    mockGetThread.mockReturnValue({ id: "thread-1" });
    const agent = createMockAgent(
      chunksToGenerator([
        {
          type: "stream",
          thinkingDelta: "hmm",
          thinkingAccumulated: "hmm",
          contentDelta: "",
          contentAccumulated: "",
          raw: null,
        },
        { type: "done" },
      ]),
    );
    setupMockSession(agent);

    const ctx = createMockCtx();
    const items = await collectGenerator(
      handleAgentExecute(ctx, {
        sessionId: "sess-1",
        threadId: "thread-1",
        prompt: "test",
      }),
    );

    const thinkEvent = items.find(
      (i: any) =>
        i.kind === "event" &&
        i.event === EventType.STREAM &&
        (i as RpcEvent).data?.thinkingDelta === "hmm",
    );
    expect(thinkEvent).toBeDefined();
  });

  it("yields STAGED thinking_end on thinking-to-content transition", async () => {
    mockGetThread.mockReturnValue({ id: "thread-1" });
    const agent = createMockAgent(
      chunksToGenerator([
        {
          type: "stream",
          thinkingDelta: "thinking...",
          thinkingAccumulated: "thinking...",
          contentDelta: "",
          contentAccumulated: "",
          raw: null,
        },
        {
          type: "stream",
          thinkingDelta: "",
          thinkingAccumulated: "thinking...",
          contentDelta: "answer",
          contentAccumulated: "answer",
          raw: null,
        },
        { type: "done" },
      ]),
    );
    setupMockSession(agent);

    const ctx = createMockCtx();
    const items = await collectGenerator(
      handleAgentExecute(ctx, {
        sessionId: "sess-1",
        threadId: "thread-1",
        prompt: "test",
      }),
    );

    const thinkEndEvent = items.find(
      (i: any) =>
        i.kind === "event" &&
        i.event === EventType.STAGED &&
        (i as RpcEvent).data?.type === "thinking_end",
    );
    expect(thinkEndEvent).toBeDefined();
  });

  it("yields STAGED content_end for staged chunks", async () => {
    mockGetThread.mockReturnValue({ id: "thread-1" });
    const agent = createMockAgent(
      chunksToGenerator([
        { type: "staged", content: "final answer", thinking: undefined, raw: null },
        { type: "done" },
      ]),
    );
    setupMockSession(agent);

    const ctx = createMockCtx();
    const items = await collectGenerator(
      handleAgentExecute(ctx, {
        sessionId: "sess-1",
        threadId: "thread-1",
        prompt: "test",
      }),
    );

    const contentEnd = items.find(
      (i: any) =>
        i.kind === "event" &&
        i.event === EventType.STAGED &&
        (i as RpcEvent).data?.type === "content_end",
    );
    expect(contentEnd).toBeDefined();
    expect((contentEnd as RpcEvent).data.content).toBe("final answer");
  });

  it("persists assistant message on staged chunk", async () => {
    mockGetThread.mockReturnValue({ id: "thread-1" });
    const agent = createMockAgent(
      chunksToGenerator([
        { type: "staged", content: "final", thinking: "thought", raw: null },
        { type: "done" },
      ]),
    );
    setupMockSession(agent);

    const ctx = createMockCtx();
    await collectGenerator(
      handleAgentExecute(ctx, {
        sessionId: "sess-1",
        threadId: "thread-1",
        prompt: "test",
      }),
    );

    expect(mockAddMessage).toHaveBeenCalledWith(
      expect.any(String),
      "thread-1",
      expect.objectContaining({
        role: "assistant",
        content: "final",
        thinking: "thought",
      }),
    );
  });

  it("yields TOOL messages for tool chunks", async () => {
    mockGetThread.mockReturnValue({ id: "thread-1" });
    const toolChunk: ToolChunk = {
      type: "tool",
      state: "trigger",
      data: {
        handleId: "h-1",
        toolName: "read_file",
        arguments: '{"path":"/test"}',
        action: "auto",
      },
    };
    const agent = createMockAgent(chunksToGenerator([toolChunk, { type: "done" }]));
    setupMockSession(agent);

    const ctx = createMockCtx();
    const items = await collectGenerator(
      handleAgentExecute(ctx, {
        sessionId: "sess-1",
        threadId: "thread-1",
        prompt: "test",
      }),
    );

    const toolMsg = items.find((i: any) => i.kind === "tool") as RpcTool | undefined;
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.state).toBe("trigger");
    expect(toolMsg!.data.handleId).toBe("h-1");
    expect(toolMsg!.data.toolName).toBe("read_file");
  });

  it("yields DONE event on done chunk", async () => {
    mockGetThread.mockReturnValue({ id: "thread-1" });
    const agent = createMockAgent(chunksToGenerator([{ type: "done" }]));
    setupMockSession(agent);

    const ctx = createMockCtx();
    const items = await collectGenerator(
      handleAgentExecute(ctx, {
        sessionId: "sess-1",
        threadId: "thread-1",
        prompt: "test",
      }),
    );

    const doneEvent = items.find(
      (i: any) => i.kind === "event" && i.event === EventType.DONE,
    );
    expect(doneEvent).toBeDefined();
  });

  it("yields ERROR event on exception", async () => {
    mockGetThread.mockReturnValue({ id: "thread-1" });
    const failingAgent = {
      createThread: vi.fn(),
      send: vi.fn().mockImplementation(function* () {
        throw new Error("LLM connection failed");
      }),
    };
    setupMockSession(failingAgent);

    const ctx = createMockCtx();
    const items = await collectGenerator(
      handleAgentExecute(ctx, {
        sessionId: "sess-1",
        threadId: "thread-1",
        prompt: "test",
      }),
    );

    const errorEvent = items.find(
      (i: any) => i.kind === "event" && i.event === EventType.ERROR,
    ) as RpcEvent | undefined;
    expect(errorEvent).toBeDefined();
    expect((errorEvent!.data as { error: string }).error).toBe("LLM connection failed");
  });

  it("persists tool messages on tool complete + staged/done (flushToolPersist)", async () => {
    mockGetThread.mockReturnValue({ id: "thread-1" });
    const completeToolChunk: ToolChunk = {
      type: "tool",
      state: "complete",
      data: {
        handleId: "h-1",
        toolName: "bash",
        arguments: '{"cmd":"ls"}',
        result: "file1.txt",
      },
    };
    // After tool complete, a staged or done chunk triggers flush
    const agent = createMockAgent(
      chunksToGenerator([completeToolChunk, { type: "done" }]),
    );
    setupMockSession(agent);

    const ctx = createMockCtx();
    await collectGenerator(
      handleAgentExecute(ctx, {
        sessionId: "sess-1",
        threadId: "thread-1",
        prompt: "test",
      }),
    );

    // addMessage should have been called for:
    // 1. user message
    // 2. assistant message with senseCalls
    // 3. tool result message
    const assistantCall = mockAddMessage.mock.calls.find(
      (call: unknown[]) => call[2]?.role === "assistant" && call[2]?.senseCalls,
    );
    const toolResult = mockAddMessage.mock.calls.find(
      (call: unknown[]) => call[2]?.role === "tool",
    );

    expect(assistantCall).toBeDefined();
    expect(toolResult).toBeDefined();
    expect(toolResult![2].content).toBe("file1.txt");
  });

  describe("handleToolApproval", () => {
    it("calls interruptManager.confirmHandle", async () => {
      const ctx = createMockCtx();
      const result = await handleToolApproval(ctx, {
        sessionId: "sess-1",
        handleId: "h-1",
        action: "accept",
        reason: "approved",
      });

      expect(mockConfirmHandle).toHaveBeenCalledWith("h-1", "accept", "approved");
      expect(result).toEqual({ handleId: "h-1", action: "accept" });
    });
  });

  describe("registerExecuteHandlers", () => {
    it("registers agent.execute (streaming) and agent.approval_tool", () => {
      const registered: Array<{ method: string; streaming: boolean }> = [];
      const mockRouter = {
        register: vi.fn((method: string, _handler: unknown, streaming?: boolean) => {
          registered.push({ method, streaming: !!streaming });
        }),
      } as unknown as RpcRouter;

      registerExecuteHandlers(mockRouter);

      expect(mockRouter.register).toHaveBeenCalledTimes(2);
      expect(registered).toEqual([
        { method: Method.AGENT_EXECUTE, streaming: true },
        { method: Method.APPROVAL_TOOL, streaming: false },
      ]);
    });
  });
});
