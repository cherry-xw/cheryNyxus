import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/db/chat.js", () => ({
  getChat: vi.fn(),
  markMessagesRevoked: vi.fn(),
}));
vi.mock("@/service/chat/runtime.js", () => ({
  ensureChat: vi.fn(),
  clearChatRuntime: vi.fn(),
  abortChatRuntime: vi.fn(),
}));
vi.mock("@/service/chat/observer.js", () => ({
  observeAgentChunks: vi.fn(),
}));
vi.mock("@/service/chat/streamMapper.js", () => ({
  streamAgentChunks: vi.fn(),
}));
vi.mock("@/service/approval/manager.js", () => ({
  approvalManager: { confirm: vi.fn() },
}));
vi.mock("@/service/websocket/connection.js", () => ({
  connectionManager: {
    bindChatConnection: vi.fn(),
    releaseChatConnection: vi.fn(),
    forceReleaseChatConnection: vi.fn(),
  },
}));

import {
  handleChatSend,
  handleChatResume,
  handleSenseApproval,
  handleChatAbort,
  registerChatHandlers,
} from "@/service/chat/send.js";
import { getChat, markMessagesRevoked } from "@/db/chat.js";
import { ensureChat, clearChatRuntime, abortChatRuntime } from "@/service/chat/runtime.js";
import { observeAgentChunks } from "@/service/chat/observer.js";
import { streamAgentChunks } from "@/service/chat/streamMapper.js";
import { approvalManager } from "@/service/approval/manager.js";
import { connectionManager } from "@/service/websocket/connection.js";
import { AgentAbortError } from "@/core/middleware/errors.js";
import { createRouter, type HandlerContext } from "@/service/message/router.js";
import type { Chunk, Notification, Response } from "@/service/message/types.js";

const ctx: HandlerContext = { requestId: "req-1", connectionId: "conn-1" };

async function* genOf<T>(items: T[]): AsyncGenerator<T, void> {
  for (const i of items) yield i;
}

async function collect(
  gen: AsyncGenerator<Chunk | Notification, unknown>,
): Promise<{ items: (Chunk | Notification)[]; result: unknown }> {
  const items: (Chunk | Notification)[] = [];
  let result: unknown;
  while (true) {
    const { done, value } = await gen.next();
    if (done) {
      result = value;
      break;
    }
    items.push(value as Chunk | Notification);
  }
  return { items, result };
}

function mockAgent(opts: { running?: boolean; revoke?: string[] } = {}) {
  return {
    isRunning: () => opts.running ?? false,
    run: vi.fn(() => genOf([])),
    revokeTrailingCycle: () => opts.revoke ?? [],
    getMessages: () => [],
    resume: vi.fn(() => genOf([])),
  };
}

describe("service/chat/send", () => {
  beforeEach(() => {
    vi.mocked(getChat).mockReset();
    vi.mocked(markMessagesRevoked).mockReset();
    vi.mocked(ensureChat).mockReset();
    vi.mocked(clearChatRuntime).mockReset();
    vi.mocked(abortChatRuntime).mockReset();
    vi.mocked(observeAgentChunks).mockReset();
    vi.mocked(streamAgentChunks).mockReset();
    vi.mocked(connectionManager.bindChatConnection).mockReset();
    vi.mocked(connectionManager.releaseChatConnection).mockReset();
    vi.mocked(connectionManager.forceReleaseChatConnection).mockReset();
    // 默认 observer/streamMapper 透传空流
    vi.mocked(observeAgentChunks).mockImplementation((() => genOf([])) as never);
    vi.mocked(streamAgentChunks).mockImplementation((() => genOf([])) as never);
  });

  describe("handleChatSend", () => {
    it("throws when chat not found", async () => {
      vi.mocked(getChat).mockReturnValue(undefined);
      await expect(
        handleChatSend(ctx, { chatId: "c1", prompt: "hi" }).next(),
      ).rejects.toThrow(/not found/);
    });

    it("running send only enqueues (no bind) and returns chatId", async () => {
      vi.mocked(getChat).mockReturnValue({ id: "c1" } as never);
      vi.mocked(ensureChat).mockResolvedValue(mockAgent({ running: true }) as never);
      const { result } = await collect(
        handleChatSend(ctx, { chatId: "c1", prompt: "hi" }) as never,
      );
      expect(result).toEqual({ chatId: "c1" });
      expect(connectionManager.bindChatConnection).not.toHaveBeenCalled();
    });

    it("idle send binds connection, streams, returns chatId, releases", async () => {
      vi.mocked(getChat).mockReturnValue({ id: "c1" } as never);
      vi.mocked(ensureChat).mockResolvedValue(mockAgent({ running: false, revoke: [] }) as never);
      const { result } = await collect(
        handleChatSend(ctx, { chatId: "c1", prompt: "hi" }) as never,
      );
      expect(connectionManager.bindChatConnection).toHaveBeenCalledWith("c1", "conn-1");
      expect(connectionManager.releaseChatConnection).toHaveBeenCalledWith("c1", "conn-1");
      expect(result).toEqual({ chatId: "c1" });
    });

    it("emits staged reverse chunk + marks revoked when revokeTrailingCycle returns ids", async () => {
      vi.mocked(getChat).mockReturnValue({ id: "c1" } as never);
      vi.mocked(ensureChat).mockResolvedValue(
        mockAgent({ running: false, revoke: ["m1", "m2"] }) as never,
      );
      const { items } = await collect(
        handleChatSend(ctx, { chatId: "c1", prompt: "hi" }) as never,
      );
      expect(markMessagesRevoked).toHaveBeenCalledWith("c1", ["m1", "m2"]);
      const reverse = items.find(
        (i) =>
          i.kind === "chunk" &&
          (i as { data?: { type?: string } }).data?.type === "reverse",
      ) as unknown as { data: { messageIds: string[] } } | undefined;
      expect(reverse).toBeDefined();
      expect(reverse?.data.messageIds).toEqual(["m1", "m2"]);
    });

    it("bind failure yields error notification + failure Response", async () => {
      vi.mocked(getChat).mockReturnValue({ id: "c1" } as never);
      vi.mocked(ensureChat).mockResolvedValue(mockAgent({ running: false }) as never);
      vi.mocked(connectionManager.bindChatConnection).mockImplementation(() => {
        throw new Error("busy");
      });
      const { items, result } = await collect(
        handleChatSend(ctx, { chatId: "c1", prompt: "hi" }) as never,
      );
      expect(
        items.some((i) => i.kind === "notification" && (i as Notification).type === "error"),
      ).toBe(true);
      const res = result as Response;
      expect(res.success).toBe(false);
      expect(res.error?.code).toBe("INTERNAL");
    });

    it("approval aborted error is silent (no error notification)", async () => {
      vi.mocked(getChat).mockReturnValue({ id: "c1" } as never);
      vi.mocked(ensureChat).mockResolvedValue(mockAgent({ running: false }) as never);
      async function* throwing(): AsyncGenerator<never, void> {
        throw new AgentAbortError();
      }
      vi.mocked(streamAgentChunks).mockReturnValue(throwing() as never);
      const { items, result } = await collect(
        handleChatSend(ctx, { chatId: "c1", prompt: "hi" }) as never,
      );
      expect(
        items.some((i) => i.kind === "notification" && (i as Notification).type === "error"),
      ).toBe(false);
      expect(result).toEqual({ chatId: "c1" });
    });

    it("non-aborted stream error yields error notification + failure Response", async () => {
      vi.mocked(getChat).mockReturnValue({ id: "c1" } as never);
      vi.mocked(ensureChat).mockResolvedValue(mockAgent({ running: false }) as never);
      async function* throwing(): AsyncGenerator<never, void> {
        throw new Error("stream broke");
      }
      vi.mocked(streamAgentChunks).mockReturnValue(throwing() as never);
      const { items, result } = await collect(
        handleChatSend(ctx, { chatId: "c1", prompt: "hi" }) as never,
      );
      expect(
        items.some((i) => i.kind === "notification" && (i as Notification).type === "error"),
      ).toBe(true);
      const res = result as Response;
      expect(res.success).toBe(false);
      expect(res.error?.message).toBe("stream broke");
    });
  });

  describe("handleChatResume", () => {
    it("throws when chat not found", async () => {
      vi.mocked(getChat).mockReturnValue(undefined);
      await expect(handleChatResume(ctx, { chatId: "c1" }).next()).rejects.toThrow(/not found/);
    });

    it("idle resume binds connection and returns chatId", async () => {
      vi.mocked(getChat).mockReturnValue({ id: "c1" } as never);
      vi.mocked(ensureChat).mockResolvedValue(mockAgent({ running: false }) as never);
      const { result } = await collect(handleChatResume(ctx, { chatId: "c1" }) as never);
      expect(connectionManager.bindChatConnection).toHaveBeenCalledWith("c1", "conn-1");
      expect(connectionManager.releaseChatConnection).toHaveBeenCalledWith("c1", "conn-1");
      expect(result).toEqual({ chatId: "c1" });
    });
  });

  describe("handleSenseApproval", () => {
    it("forwards accept to approvalManager.confirm", async () => {
      const res = await handleSenseApproval(ctx, { approvalId: "a1", action: "accept" });
      expect(approvalManager.confirm).toHaveBeenCalledWith("a1", "accept", undefined);
      expect(res).toEqual({ approvalId: "a1", action: "accept" });
    });

    it("forwards reject with reason", async () => {
      await handleSenseApproval(ctx, { approvalId: "a1", action: "reject", reason: "no" });
      expect(approvalManager.confirm).toHaveBeenCalledWith("a1", "reject", "no");
    });
  });

  describe("handleChatAbort", () => {
    it("aborts runtime, force-releases connection, clears runtime", async () => {
      const res = await handleChatAbort(ctx, { chatId: "c1" });
      expect(abortChatRuntime).toHaveBeenCalledWith("c1");
      expect(connectionManager.forceReleaseChatConnection).toHaveBeenCalledWith("c1");
      expect(clearChatRuntime).toHaveBeenCalledWith("c1");
      expect(res).toEqual({ chatId: "c1" });
    });
  });

  describe("registerChatHandlers", () => {
    it("registers chat.send/resume/sense.approval/chat.abort", () => {
      const router = createRouter();
      const spy = vi.spyOn(router, "register");
      registerChatHandlers(router);
      expect(spy).toHaveBeenCalledWith("chat.send", expect.any(Function));
      expect(spy).toHaveBeenCalledWith("chat.resume", expect.any(Function));
      expect(spy).toHaveBeenCalledWith("sense.approval", expect.any(Function));
      expect(spy).toHaveBeenCalledWith("chat.abort", expect.any(Function));
    });
  });
});
