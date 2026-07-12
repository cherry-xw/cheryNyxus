import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/db/chat.js", () => ({
  createChat: vi.fn(),
  listAllChats: vi.fn(),
  getChat: vi.fn(),
  deleteChat: vi.fn(),
  getMessages: vi.fn(),
  parseMessageRow: vi.fn(),
  findChatsByParent: vi.fn(),
}));
vi.mock("@/service/chat/runtime.js", () => ({
  ensureChat: vi.fn(),
  clearChatRuntime: vi.fn(),
  isChatRunning: vi.fn(() => false),
}));
vi.mock("@/utils/token.js", () => ({ computeContextUsage: vi.fn(() => 0) }));
vi.mock("@/agent/runtimeResolver.js", () => ({
  parseRuntimeSelection: vi.fn(),
}));

import {
  handleChatCreate,
  handleChatList,
  handleChatGet,
  handleChatDelete,
  registerChatManageHandlers,
} from "@/service/chat/handler.js";
import {
  createChat,
  listAllChats,
  getChat,
  deleteChat,
  getMessages,
  parseMessageRow,
  findChatsByParent,
} from "@/db/chat.js";
import { ensureChat, clearChatRuntime } from "@/service/chat/runtime.js";
import { parseRuntimeSelection } from "@/agent/runtimeResolver.js";
import { createRouter, type HandlerContext } from "@/service/message/router.js";

const ctx: HandlerContext = { connectionId: "conn-1" };

async function collect<T>(
  gen: AsyncGenerator<unknown, T>,
): Promise<{ items: unknown[]; result: T }> {
  const items: unknown[] = [];
  let result: T | undefined;
  while (true) {
    const { done, value } = await gen.next();
    if (done) {
      result = value;
      break;
    }
    items.push(value);
  }
  return { items, result: result as T };
}

describe("service/chat/handler", () => {
  beforeEach(() => {
    vi.mocked(createChat).mockClear();
    vi.mocked(listAllChats).mockClear();
    vi.mocked(getChat).mockClear();
    vi.mocked(deleteChat).mockClear();
    vi.mocked(getMessages).mockClear();
    vi.mocked(parseMessageRow).mockClear();
    vi.mocked(findChatsByParent).mockReset();
    vi.mocked(findChatsByParent).mockReturnValue([]);
    vi.mocked(ensureChat).mockClear();
    vi.mocked(clearChatRuntime).mockClear();
    vi.mocked(parseRuntimeSelection).mockClear();
  });

  describe("handleChatCreate", () => {
    it("creates chat with explicit chatId and configures runtime", async () => {
      vi.mocked(parseRuntimeSelection).mockReturnValue({ brain: "b", senseGroup: "g" });
      vi.mocked(ensureChat).mockResolvedValue({} as never);
      const res = await handleChatCreate(ctx, { chatId: "c1", brain: "b", senseGroup: "g" });
      expect(res).toMatchObject({ chatId: "c1", brain: "b", senseGroup: "g" });
      expect(createChat).toHaveBeenCalledWith("c1", undefined, undefined);
      expect(ensureChat).toHaveBeenCalledWith("c1", { brain: "b", senseGroup: "g" });
    });

    it("generates chatId when not provided", async () => {
      vi.mocked(parseRuntimeSelection).mockReturnValue({ brain: "b", senseGroup: "g" });
      vi.mocked(ensureChat).mockResolvedValue({} as never);
      const res = await handleChatCreate(ctx, { brain: "b", senseGroup: "g" } as never);
      expect(typeof res.chatId).toBe("string");
      expect(res.chatId.length).toBeGreaterThan(0);
      expect(createChat).toHaveBeenCalledWith(res.chatId, undefined, undefined);
    });
  });

  describe("handleChatList", () => {
    it("maps chat rows to list response using redundant message_count", async () => {
      vi.mocked(listAllChats).mockReturnValue([
        { id: "c1", created_at: 1, updated_at: 2, message_count: 5 },
      ] as never);
      const res = (await handleChatList(ctx, {})) as { chats: unknown[] };
      expect(res.chats).toMatchObject([{ chatId: "c1", createdAt: 1, updatedAt: 2, messageCount: 5 }]);
    });
  });

  describe("handleChatGet", () => {
    it("throws when chat not found", async () => {
      vi.mocked(getChat).mockReturnValue(undefined);
      await expect(handleChatGet(ctx, { chatId: "c1" }).next()).rejects.toThrow(/not found/);
    });

    it("streams content_end + loaded and returns canResume true for trailing user msg", async () => {
      vi.mocked(getChat).mockReturnValue({ id: "c1" } as never);
      vi.mocked(getMessages).mockReturnValue([{ id: "m1", role: "user", revoked: 0 } as never]);
      vi.mocked(parseMessageRow).mockReturnValue({ role: "user", content: "hi" } as never);
      const { items, result } = await collect(handleChatGet(ctx, { chatId: "c1" }));
      expect(items.some((i) => (i as { kind: string }).kind === "chunk")).toBe(true);
      expect(items.some((i) => (i as { kind: string; type: string }).type === "loaded")).toBe(true);
      expect(result).toMatchObject({ chatId: "c1", canResume: true });
    });

    it("returns canResume false when last visible message is assistant", async () => {
      vi.mocked(getChat).mockReturnValue({ id: "c1" } as never);
      vi.mocked(getMessages).mockReturnValue([{ id: "m1", role: "assistant", revoked: 0 } as never]);
      vi.mocked(parseMessageRow).mockReturnValue({ role: "assistant", content: "x" } as never);
      const { result } = await collect(handleChatGet(ctx, { chatId: "c1" }));
      expect(result.canResume).toBe(false);
    });

    it("returns canResume true for a trailing role reply without child id transport", async () => {
      vi.mocked(getChat).mockReturnValue({ id: "c1" } as never);
      vi.mocked(getMessages).mockReturnValue([{ id: "m1", role: "role", revoked: 0 } as never]);
      vi.mocked(parseMessageRow).mockReturnValue({ role: "role", content: "child result" } as never);

      const { items, result } = await collect(handleChatGet(ctx, { chatId: "c1" }));
      expect(result.canResume).toBe(true);
      const roleChunk = items.find((item) => (item as { data?: { role?: string } }).data?.role === "role") as {
        data: Record<string, unknown>;
      };
      expect(roleChunk.data).not.toHaveProperty("childChatId");
    });

    it("emits thinking_end and sense_end for messages carrying them", async () => {
      vi.mocked(getChat).mockReturnValue({ id: "c1" } as never);
      vi.mocked(getMessages).mockReturnValue([{ id: "m1", role: "assistant", revoked: 0 } as never]);
      vi.mocked(parseMessageRow).mockReturnValue({
        role: "assistant",
        thinking: "t",
        content: "c",
        senseCall: [{ id: "sc1", name: "read_file", arguments: "{}" }],
      } as never);
      const { items } = await collect(handleChatGet(ctx, { chatId: "c1" }));
      const data = items.map(
        (i) => (i as { data?: { type?: string; senseName?: string } }).data,
      );
      expect(data.some((d) => d?.type === "thinking_end")).toBe(true);
      expect(data.some((d) => d?.type === "content_end")).toBe(true);
      expect(data.some((d) => d?.type === "sense_end" && d?.senseName === "read_file")).toBe(true);
    });

    it("skips revoked messages when computing canResume", async () => {
      vi.mocked(getChat).mockReturnValue({ id: "c1" } as never);
      vi.mocked(getMessages).mockReturnValue([
        { id: "m1", role: "user", revoked: 1 } as never,
        { id: "m2", role: "assistant", revoked: 0 } as never,
      ]);
      vi.mocked(parseMessageRow).mockImplementation(
        (row) =>
          ({
            role: (row as { role: "user" | "assistant" }).role,
            content: "x",
            revoked: (row as { revoked: number }).revoked === 1,
          }) as never,
      );
      const { result } = await collect(handleChatGet(ctx, { chatId: "c1" }));
      expect(result.canResume).toBe(false);
    });
  });

  describe("handleChatDelete", () => {
    it("throws when chat not found", async () => {
      vi.mocked(getChat).mockReturnValue(undefined);
      await expect(handleChatDelete(ctx, { chatId: "c1" })).rejects.toThrow(/not found/);
    });

    it("clears runtime and deletes chat", async () => {
      vi.mocked(getChat).mockReturnValue({ id: "c1" } as never);
      const res = await handleChatDelete(ctx, { chatId: "c1" });
      expect(clearChatRuntime).toHaveBeenCalledWith("c1");
      expect(deleteChat).toHaveBeenCalledWith("c1");
      expect(res).toEqual({ chatId: "c1" });
    });

    it("deletes descendants from leaves to root", async () => {
      vi.mocked(getChat).mockReturnValue({ id: "main", parent_chat_id: null } as never);
      vi.mocked(findChatsByParent).mockImplementation((parentChatId: string) => {
        if (parentChatId === "main") return [{ id: "child" }] as never;
        if (parentChatId === "child") return [{ id: "grandchild" }] as never;
        return [] as never;
      });

      await handleChatDelete(ctx, { chatId: "main" });

      expect(deleteChat).toHaveBeenNthCalledWith(1, "grandchild");
      expect(deleteChat).toHaveBeenNthCalledWith(2, "child");
      expect(deleteChat).toHaveBeenNthCalledWith(3, "main");
    });
  });

  describe("registerChatManageHandlers", () => {
    it("registers chat.create/list/get/delete", () => {
      const router = createRouter();
      const spy = vi.spyOn(router, "register");
      registerChatManageHandlers(router);
      expect(spy).toHaveBeenCalledWith("chat.create", expect.any(Function));
      expect(spy).toHaveBeenCalledWith("chat.list", expect.any(Function));
      expect(spy).toHaveBeenCalledWith("chat.get", expect.any(Function));
      expect(spy).toHaveBeenCalledWith("chat.delete", expect.any(Function));
    });
  });
});
