import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { createTempDir, cleanupTempDir } from "@test/helpers/tempDir";

describe("db/chat", () => {
  let tempDir: string;
  const tempDirs: string[] = [];

  beforeEach(async () => {
    vi.resetModules();
    tempDir = createTempDir();
    tempDirs.push(tempDir);
    process.env.CHERY_DIR = tempDir;
  });

  afterAll(() => {
    delete process.env.CHERY_DIR;
    for (const dir of tempDirs) {
      cleanupTempDir(dir);
    }
  });

  describe("createChat", () => {
    it("should create a chat", async () => {
      const { createChat, getChat } = await import("@/db/chat.js");
      // Need to create soul first (foreign key constraint)
      const { createSoul } = await import("@/db/soul.js");
      createSoul("soul-1", {
        agentName: "test-agent",
        provider: "ollama",
        model: "gemma3:1b",
      });

      const chat = createChat("chat-1", "soul-1");

      expect(chat.id).toBe("chat-1");
      expect(chat.soul_id).toBe("soul-1");
      expect(chat.created_at).toBeDefined();
      expect(chat.updated_at).toBeDefined();
      expect(chat.metadata).toBeNull();
    });

    it("should create a chat with metadata", async () => {
      const { createChat } = await import("@/db/chat.js");
      const { createSoul } = await import("@/db/soul.js");
      createSoul("soul-2", {
        agentName: "test-agent",
        provider: "ollama",
        model: "gemma3:1b",
      });

      const metadata = { foo: "bar", count: 42 };
      const chat = createChat("chat-2", "soul-2", metadata);

      expect(chat.metadata).toBe(JSON.stringify(metadata));
    });

    it("should persist chat to database", async () => {
      const { createChat, getChat } = await import("@/db/chat.js");
      const { createSoul } = await import("@/db/soul.js");
      createSoul("soul-3", {
        agentName: "test-agent",
        provider: "ollama",
        model: "gemma3:1b",
      });
      createChat("chat-3", "soul-3");

      const chat = getChat("chat-3");
      expect(chat).toBeDefined();
      expect(chat?.id).toBe("chat-3");
      expect(chat?.soul_id).toBe("soul-3");
    });
  });

  describe("getChat", () => {
    it("should return undefined for non-existent chat", async () => {
      const { getChat } = await import("@/db/chat.js");
      const chat = getChat("non-existent");
      expect(chat).toBeUndefined();
    });

    it("should return existing chat", async () => {
      const { createChat, getChat } = await import("@/db/chat.js");
      const { createSoul } = await import("@/db/soul.js");
      createSoul("soul-get", {
        agentName: "test-agent",
        provider: "ollama",
        model: "gemma3:1b",
      });
      createChat("chat-get-test", "soul-get");

      const chat = getChat("chat-get-test");
      expect(chat).toBeDefined();
      expect(chat?.id).toBe("chat-get-test");
      expect(chat?.soul_id).toBe("soul-get");
    });
  });

  describe("listChatsBySoul", () => {
    it("should return empty array for non-existent soul", async () => {
      const { listChatsBySoul } = await import("@/db/chat.js");
      const chats = listChatsBySoul("non-existent");
      expect(chats).toEqual([]);
    });

    it("should return chats for a soul", async () => {
      const { createChat, listChatsBySoul } = await import("@/db/chat.js");
      const { createSoul } = await import("@/db/soul.js");
      createSoul("soul-list", {
        agentName: "test-agent",
        provider: "ollama",
        model: "gemma3:1b",
      });
      createChat("chat-list-1", "soul-list");
      createChat("chat-list-2", "soul-list");

      const chats = listChatsBySoul("soul-list");
      expect(chats).toHaveLength(2);
    });

    it("should return chats sorted by updated_at DESC", async () => {
      const { createChat, listChatsBySoul } = await import("@/db/chat.js");
      const { createSoul } = await import("@/db/soul.js");
      createSoul("soul-sort", {
        agentName: "test-agent",
        provider: "ollama",
        model: "gemma3:1b",
      });
      createChat("chat-old", "soul-sort");
      await new Promise((r) => setTimeout(r, 10));
      createChat("chat-new", "soul-sort");

      const chats = listChatsBySoul("soul-sort");
      expect(chats[0]!.id).toBe("chat-new");
      expect(chats[1]!.id).toBe("chat-old");
    });
  });

  describe("updateChat", () => {
    it("should update updated_at timestamp", async () => {
      const { createChat, updateChat, getChat } = await import("@/db/chat.js");
      const { createSoul } = await import("@/db/soul.js");
      createSoul("soul-update", {
        agentName: "test-agent",
        provider: "ollama",
        model: "gemma3:1b",
      });
      const chat = createChat("chat-update", "soul-update");
      const originalTime = chat.updated_at;

      await new Promise((r) => setTimeout(r, 10));
      updateChat("chat-update");

      const updated = getChat("chat-update");
      expect(updated?.updated_at).toBeGreaterThan(originalTime);
    });
  });

  describe("deleteChat", () => {
    it("should delete chat", async () => {
      const { createChat, deleteChat, getChat } = await import("@/db/chat.js");
      const { createSoul } = await import("@/db/soul.js");
      createSoul("soul-delete", {
        agentName: "test-agent",
        provider: "ollama",
        model: "gemma3:1b",
      });
      createChat("chat-delete", "soul-delete");
      deleteChat("chat-delete");

      const chat = getChat("chat-delete");
      expect(chat).toBeUndefined();
    });

    it("should not throw for non-existent chat", async () => {
      const { deleteChat } = await import("@/db/chat.js");
      expect(() => deleteChat("non-existent")).not.toThrow();
    });
  });

  describe("addMessage", () => {
    it("should add a user message", async () => {
      const { createChat, addMessage, getMessages } = await import("@/db/chat.js");
      const { createSoul } = await import("@/db/soul.js");
      createSoul("soul-msg", {
        agentName: "test-agent",
        provider: "ollama",
        model: "gemma3:1b",
      });
      createChat("chat-msg", "soul-msg");
      const msg = addMessage("msg-1", "chat-msg", {
        role: "user",
        content: "Hello",
      });

      expect(msg.id).toBe("msg-1");
      expect(msg.chat_id).toBe("chat-msg");
      expect(msg.role).toBe("user");
      expect(msg.content).toBe("Hello");
      expect(msg.thinking).toBeNull();
      expect(msg.sense_calls).toBeNull();
    });

    it("should add an assistant message with thinking", async () => {
      const { createChat, addMessage } = await import("@/db/chat.js");
      const { createSoul } = await import("@/db/soul.js");
      createSoul("soul-msg-thinking", {
        agentName: "test-agent",
        provider: "ollama",
        model: "gemma3:1b",
      });
      createChat("chat-msg-thinking", "soul-msg-thinking");
      const msg = addMessage("msg-2", "chat-msg-thinking", {
        role: "assistant",
        content: "Hi there",
        thinking: "Let me think...",
      });

      expect(msg.role).toBe("assistant");
      expect(msg.content).toBe("Hi there");
      expect(msg.thinking).toBe("Let me think...");
    });

    it("should add a message with sense calls", async () => {
      const { createChat, addMessage, getMessages } = await import("@/db/chat.js");
      const { createSoul } = await import("@/db/soul.js");
      createSoul("soul-msg-sense", {
        agentName: "test-agent",
        provider: "ollama",
        model: "gemma3:1b",
      });
      createChat("chat-msg-sense", "soul-msg-sense");
      const msg = addMessage("msg-3", "chat-msg-sense", {
        role: "assistant",
        content: "Done",
        senseCall: [{ id: "call-1", name: "execute_command", arguments: "{}" }],
      });

      expect(msg.sense_calls).not.toBeNull();
      const calls = JSON.parse(msg.sense_calls as string);
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe("execute_command");
    });

    it("should update chat updated_at when message is added", async () => {
      const { createChat, addMessage, getChat } = await import("@/db/chat.js");
      const { createSoul } = await import("@/db/soul.js");
      createSoul("soul-msg-time", {
        agentName: "test-agent",
        provider: "ollama",
        model: "gemma3:1b",
      });
      const chat = createChat("chat-msg-time", "soul-msg-time");
      const originalTime = chat.updated_at;

      await new Promise((r) => setTimeout(r, 10));
      addMessage("msg-time", "chat-msg-time", { role: "user", content: "test" });

      const updated = getChat("chat-msg-time");
      expect(updated?.updated_at).toBeGreaterThan(originalTime);
    });
  });

  describe("getMessages", () => {
    it("should return empty array for chat with no messages", async () => {
      const { createChat, getMessages } = await import("@/db/chat.js");
      const { createSoul } = await import("@/db/soul.js");
      createSoul("soul-no-msg", {
        agentName: "test-agent",
        provider: "ollama",
        model: "gemma3:1b",
      });
      createChat("chat-no-msg", "soul-no-msg");
      const msgs = getMessages("chat-no-msg");
      expect(msgs).toEqual([]);
    });

    it("should return messages sorted by created_at ASC", async () => {
      const { createChat, addMessage, getMessages } = await import("@/db/chat.js");
      const { createSoul } = await import("@/db/soul.js");
      createSoul("soul-msgs", {
        agentName: "test-agent",
        provider: "ollama",
        model: "gemma3:1b",
      });
      createChat("chat-msgs", "soul-msgs");
      addMessage("msg-1", "chat-msgs", { role: "user", content: "First" });
      await new Promise((r) => setTimeout(r, 10));
      addMessage("msg-2", "chat-msgs", { role: "assistant", content: "Second" });

      const msgs = getMessages("chat-msgs");
      expect(msgs).toHaveLength(2);
      expect(msgs[0]!.id).toBe("msg-1");
      expect(msgs[1]!.id).toBe("msg-2");
    });
  });

  describe("clearMessages", () => {
    it("should clear all messages for a chat", async () => {
      const { createChat, addMessage, getMessages, clearMessages } = await import(
        "@/db/chat.js"
      );
      const { createSoul } = await import("@/db/soul.js");
      createSoul("soul-clear", {
        agentName: "test-agent",
        provider: "ollama",
        model: "gemma3:1b",
      });
      createChat("chat-clear", "soul-clear");
      addMessage("msg-clear-1", "chat-clear", { role: "user", content: "test" });
      addMessage("msg-clear-2", "chat-clear", { role: "assistant", content: "response" });

      clearMessages("chat-clear");

      const msgs = getMessages("chat-clear");
      expect(msgs).toEqual([]);
    });

    it("should update chat updated_at when messages cleared", async () => {
      const { createChat, addMessage, getChat, clearMessages } = await import("@/db/chat.js");
      const { createSoul } = await import("@/db/soul.js");
      createSoul("soul-clear-time", {
        agentName: "test-agent",
        provider: "ollama",
        model: "gemma3:1b",
      });
      createChat("chat-clear-time", "soul-clear-time");
      addMessage("msg-c", "chat-clear-time", { role: "user", content: "test" });
      const beforeClear = getChat("chat-clear-time")?.updated_at;

      await new Promise((r) => setTimeout(r, 10));
      clearMessages("chat-clear-time");

      const afterClear = getChat("chat-clear-time")?.updated_at;
      expect(afterClear).toBeGreaterThan(beforeClear!);
    });
  });

  describe("parseMessageRow", () => {
    it("should parse user message", async () => {
      const { parseMessageRow } = await import("@/db/chat.js");
      const row = {
        id: "msg-parse-1",
        chat_id: "chat-1",
        role: "user",
        content: "Hello",
        thinking: null,
        sense_calls: null,
        created_at: Date.now(),
      };

      const data = parseMessageRow(row);
      expect(data.role).toBe("user");
      expect(data.content).toBe("Hello");
      expect(data.thinking).toBeUndefined();
      expect(data.senseCall).toBeUndefined();
    });

    it("should parse assistant message with thinking", async () => {
      const { parseMessageRow } = await import("@/db/chat.js");
      const row = {
        id: "msg-parse-2",
        chat_id: "chat-1",
        role: "assistant",
        content: "Response",
        thinking: "Thinking...",
        sense_calls: null,
        created_at: Date.now(),
      };

      const data = parseMessageRow(row);
      expect(data.role).toBe("assistant");
      expect(data.content).toBe("Response");
      expect(data.thinking).toBe("Thinking...");
    });

    it("should parse message with sense calls", async () => {
      const { parseMessageRow } = await import("@/db/chat.js");
      const row = {
        id: "msg-parse-3",
        chat_id: "chat-1",
        role: "assistant",
        content: null,
        thinking: null,
        sense_calls: JSON.stringify([
          { id: "call-1", name: "read_file", arguments: '{"path":"/test"}' },
        ]),
        created_at: Date.now(),
      };

      const data = parseMessageRow(row);
      expect(data.senseCall).toBeDefined();
      expect(data.senseCall).toHaveLength(1);
      expect(data.senseCall![0]!.name).toBe("read_file");
    });
  });
});