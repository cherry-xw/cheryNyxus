import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  handleChatList,
  handleChatGet,
  handleChatDelete,
  registerChatManageHandlers,
} from "@/service/chat/handler.js";
import type { HandlerContext } from "@/service/message/router.js";
import { Method } from "@/service/message/types.js";

// Mock db/chat.js
vi.mock("@/db/chat.js", () => ({
  listChatsBySoul: vi.fn(),
  getChat: vi.fn(),
  deleteChat: vi.fn(),
  getMessages: vi.fn(),
  parseMessageRow: vi.fn(),
}));

// Mock message types
vi.mock("@/service/message/types.js", async (importOriginal) => {
  const original = await importOriginal<any>();
  return {
    ...original,
    createChunk: original.createChunk,
    createNotification: original.createNotification,
    createResponse: original.createResponse,
  };
});

import {
  listChatsBySoul,
  getChat,
  deleteChat,
  getMessages,
  parseMessageRow,
} from "@/db/chat.js";

function createMockCtx(): HandlerContext {
  return {
    connectionId: "conn-1",
    sendChunk: vi.fn(),
    sendNotification: vi.fn(),
  };
}

describe("handleChatList", () => {
  let mockCtx: HandlerContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCtx = createMockCtx();
  });

  it("should return list of chats with message counts", async () => {
    vi.mocked(listChatsBySoul).mockReturnValue([
      { id: "chat-1", soul_id: "soul-1", created_at: 1000, updated_at: 2000 },
      { id: "chat-2", soul_id: "soul-1", created_at: 3000, updated_at: 4000 },
    ]);
    vi.mocked(getMessages)
      .mockReturnValueOnce([{ id: "m1" }] as any)
      .mockReturnValueOnce([{ id: "m2" }, { id: "m3" }] as any);

    const result = await handleChatList(mockCtx, { soulId: "soul-1" });

    expect(result).toEqual({
      chats: [
        { chatId: "chat-1", createdAt: 1000, updatedAt: 2000, messageCount: 1 },
        { chatId: "chat-2", createdAt: 3000, updatedAt: 4000, messageCount: 2 },
      ],
    });
  });

  it("should return empty array when no chats exist", async () => {
    vi.mocked(listChatsBySoul).mockReturnValue([]);

    const result = await handleChatList(mockCtx, { soulId: "soul-1" });

    expect(result).toEqual({ chats: [] });
  });
});

describe("handleChatGet", () => {
  let mockCtx: HandlerContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCtx = createMockCtx();
  });

  it("should throw error when chat not found", async () => {
    vi.mocked(getChat).mockReturnValue(null);

    // handleChatGet is a generator, need to iterate to trigger the throw
    const generator = handleChatGet(mockCtx, { chatId: "non-existent" });

    await expect(async () => {
      for await (const _ of generator) {}
    }).rejects.toThrow('Chat "non-existent" not found');
  });

  it("should yield chunks for messages with thinking and content", async () => {
    vi.mocked(getChat).mockReturnValue({ id: "chat-1" } as any);
    vi.mocked(getMessages).mockReturnValue([
      { id: "m1", role: "assistant", thinking: "thinking...", content: "hello" },
    ] as any);
    vi.mocked(parseMessageRow).mockReturnValue({
      role: "assistant",
      thinking: "thinking...",
      content: "hello",
    });

    const generator = handleChatGet(mockCtx, { chatId: "chat-1" });
    const items: any[] = [];

    for await (const item of generator) {
      items.push(item);
    }

    // Should have thinking_end, content_end, loaded notification, and final response
    expect(items.length).toBe(3);
    expect(items[0]).toEqual(
      expect.objectContaining({
        kind: "chunk",
        type: "staged",
        data: expect.objectContaining({ type: "thinking_end", thinking: "thinking..." }),
      })
    );
    expect(items[1]).toEqual(
      expect.objectContaining({
        kind: "chunk",
        type: "staged",
        data: expect.objectContaining({ type: "content_end", content: "hello" }),
      })
    );
    // Items[2] should be notification (loaded) - but response comes as generator return value
    const loadedNotification = items.find((i) => i.type === "loaded");
    expect(loadedNotification).toBeDefined();
  });

  it("should yield sense_trigger chunks for messages with sense calls", async () => {
    vi.mocked(getChat).mockReturnValue({ id: "chat-1" } as any);
    vi.mocked(getMessages).mockReturnValue([
      { id: "m1", role: "assistant" },
    ] as any);
    vi.mocked(parseMessageRow).mockReturnValue({
      role: "assistant",
      senseCall: [{ name: "execute_command", arguments: '{"cmd": "ls"}' }],
    });

    const generator = handleChatGet(mockCtx, { chatId: "chat-1" });
    const items: any[] = [];

    for await (const item of generator) {
      items.push(item);
    }

    const senseTrigger = items.find(
      (i) => i.type === "staged" && i.data?.type === "sense_trigger"
    );
    expect(senseTrigger).toBeDefined();
    expect(senseTrigger!.data).toEqual(
      expect.objectContaining({
        senseName: "execute_command",
        arguments: '{"cmd": "ls"}',
      })
    );
  });

  it("should yield loaded notification after all messages", async () => {
    vi.mocked(getChat).mockReturnValue({ id: "chat-1" } as any);
    vi.mocked(getMessages).mockReturnValue([] as any);

    const generator = handleChatGet(mockCtx, { chatId: "chat-1" });
    const items: any[] = [];

    for await (const item of generator) {
      items.push(item);
    }

    const loadedNotification = items.find((i) => i.type === "loaded");
    expect(loadedNotification).toBeDefined();
  });
});

describe("handleChatDelete", () => {
  let mockCtx: HandlerContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCtx = createMockCtx();
  });

  it("should throw error when chat not found", async () => {
    vi.mocked(getChat).mockReturnValue(null);

    await expect(
      handleChatDelete(mockCtx, { chatId: "non-existent" })
    ).rejects.toThrow('Chat "non-existent" not found');
  });

  it("should delete chat and return chatId", async () => {
    vi.mocked(getChat).mockReturnValue({ id: "chat-1" } as any);
    vi.mocked(deleteChat).mockReturnValue(undefined);

    const result = await handleChatDelete(mockCtx, { chatId: "chat-1" });

    expect(deleteChat).toHaveBeenCalledWith("chat-1");
    expect(result).toEqual({ chatId: "chat-1" });
  });
});

describe("registerChatManageHandlers", () => {
  it("should register handlers to router", () => {
    const router = {
      register: vi.fn(),
    } as any;

    registerChatManageHandlers(router);

    expect(router.register).toHaveBeenCalledWith(Method.CHAT_LIST, handleChatList);
    expect(router.register).toHaveBeenCalledWith(Method.CHAT_GET, handleChatGet, true);
    expect(router.register).toHaveBeenCalledWith(Method.CHAT_DELETE, handleChatDelete);
  });
});