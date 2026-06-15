import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    global: { db_dir: "" },
    llm: { brain: {} },
    sense_groups: {},
  },
}));

vi.mock("@/utils/config.js", () => ({ default: mockConfig }));

import {
  createChat,
  getChat,
  listAllChats,
  updateChat,
  updateChatMetadata,
  getChatRuntimeSelection,
  deleteChat,
  addMessage,
  getMessages,
  fillApprovalResult,
  markMessagesRevoked,
  markMessageReplaced,
  parseMessageRow,
  type ChatRow,
  type MessageRow,
} from "@/db/chat.js";
import { closeAllDbs } from "@/db/index.js";
import { createTempDbDir, cleanupTempDbDir } from "@test/helpers/testDb";

let dbDir: string;
beforeEach(() => {
  closeAllDbs();
  dbDir = createTempDbDir();
  mockConfig.global.db_dir = dbDir;
});
afterEach(() => {
  closeAllDbs();
  cleanupTempDbDir(dbDir);
});

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

describe("db/chat", () => {
  describe("createChat", () => {
    it("creates a chat row with fixed messages_month (current month) and message_count 0", () => {
      const row = createChat("c1");
      expect(row.id).toBe("c1");
      expect(row.messages_month).toBe(currentMonth());
      expect(row.message_count).toBe(0);
      expect(row.metadata).toBeNull();
    });

    it("persists metadata when provided", () => {
      const row = createChat("c2", { foo: "bar" });
      expect(row.metadata).toBe(JSON.stringify({ foo: "bar" }));
    });
  });

  describe("getChat", () => {
    it("returns the chat row when found", () => {
      createChat("c1");
      expect(getChat("c1")?.id).toBe("c1");
    });

    it("returns undefined when not found", () => {
      expect(getChat("missing")).toBeUndefined();
    });
  });

  describe("listAllChats", () => {
    it("lists chats ordered by updated_at DESC", () => {
      createChat("c1");
      createChat("c2");
      updateChat("c1"); // bump c1 updated_at to最新
      const ids = listAllChats().map((c) => c.id);
      expect(ids[0]).toBe("c1");
      expect(ids).toHaveLength(2);
    });
  });

  describe("updateChatMetadata", () => {
    it("merges patch without overwriting other keys", () => {
      createChat("c1", { a: 1 });
      updateChatMetadata("c1", { b: 2 });
      const row = getChat("c1") as ChatRow;
      expect(JSON.parse(row.metadata!)).toEqual({ a: 1, b: 2 });
    });

    it("is a no-op when chat does not exist", () => {
      expect(() => updateChatMetadata("missing", { x: 1 })).not.toThrow();
    });
  });

  describe("getChatRuntimeSelection", () => {
    it("returns persisted runtime selection", () => {
      createChat("c1");
      updateChatMetadata("c1", { runtime: { brain: "longcat", senseGroups: ["safe"] } });
      expect(getChatRuntimeSelection("c1")).toEqual({
        brain: "longcat",
        senseGroups: ["safe"],
      });
    });

    it("returns undefined when no runtime metadata", () => {
      createChat("c1");
      expect(getChatRuntimeSelection("c1")).toBeUndefined();
    });

    it("returns undefined when runtime selection incomplete (empty senseGroups)", () => {
      createChat("c1");
      updateChatMetadata("c1", { runtime: { brain: "longcat", senseGroups: [] } });
      expect(getChatRuntimeSelection("c1")).toBeUndefined();
    });
  });

  describe("deleteChat", () => {
    it("removes chat and its messages", () => {
      createChat("c1");
      addMessage("m1", "c1", { role: "user", content: "hi" });
      deleteChat("c1");
      expect(getChat("c1")).toBeUndefined();
      expect(getMessages("c1")).toEqual([]);
    });

    it("is a no-op when chat does not exist", () => {
      expect(() => deleteChat("missing")).not.toThrow();
    });
  });

  describe("addMessage", () => {
    it("inserts a message and increments message_count", () => {
      createChat("c1");
      const row = addMessage("m1", "c1", { role: "user", content: "hello" });
      expect(row.role).toBe("user");
      expect(row.content).toBe("hello");

      const chat = getChat("c1") as ChatRow;
      expect(chat.message_count).toBe(1);
    });

    it("serializes senseCall array into sense_calls", () => {
      createChat("c1");
      const row = addMessage("m1", "c1", {
        role: "assistant",
        content: "ok",
        senseCall: [{ id: "sc1", name: "read_file", arguments: '{"path":"/a"}' }],
      });
      expect(JSON.parse(row.sense_calls!)).toEqual([
        { id: "sc1", name: "read_file", arguments: '{"path":"/a"}' },
      ]);
    });

    it("throws when chat does not exist", () => {
      expect(() => addMessage("m1", "missing", { role: "user", content: "x" })).toThrow(
        /not found/i,
      );
    });
  });

  describe("getMessages", () => {
    it("returns messages ordered by created_at ASC", () => {
      createChat("c1");
      addMessage("m1", "c1", { role: "user", content: "first" });
      addMessage("m2", "c1", { role: "assistant", content: "second" });
      const msgs = getMessages("c1");
      expect(msgs.map((m) => m.id)).toEqual(["m1", "m2"]);
    });

    it("returns [] when chat does not exist", () => {
      expect(getMessages("missing")).toEqual([]);
    });
  });

  describe("fillApprovalResult", () => {
    it("updates content and hash of a message", () => {
      createChat("c1");
      addMessage("m1", "c1", { role: "sense", content: "" });
      fillApprovalResult("c1", "m1", { content: "result", hash: "h1" });
      const msg = getMessages("c1").find((m) => m.id === "m1") as MessageRow;
      expect(msg.content).toBe("result");
      expect(msg.hash).toBe("h1");
    });

    it("is a no-op when chat does not exist", () => {
      expect(() => fillApprovalResult("missing", "m1", { content: "x" })).not.toThrow();
    });
  });

  describe("markMessagesRevoked", () => {
    it("sets revoked=1 for given message ids", () => {
      createChat("c1");
      addMessage("m1", "c1", { role: "user", content: "a" });
      addMessage("m2", "c1", { role: "assistant", content: "b" });
      markMessagesRevoked("c1", ["m1"]);
      const msgs = getMessages("c1");
      expect(msgs.find((m) => m.id === "m1")?.revoked).toBe(1);
      expect(msgs.find((m) => m.id === "m2")?.revoked).toBe(0);
    });

    it("skips empty id list", () => {
      createChat("c1");
      expect(() => markMessagesRevoked("c1", [])).not.toThrow();
    });
  });

  describe("markMessageReplaced", () => {
    it("writes replace metadata and optional content", () => {
      createChat("c1");
      addMessage("m1", "c1", { role: "sense", content: "original long content" });
      markMessageReplaced("c1", "m1", {
        content: "short",
        replace: { state: true, by: "sc2", content: "short" },
        originalContent: "original long content",
      });
      const msg = getMessages("c1").find((m) => m.id === "m1") as MessageRow;
      expect(msg.replace_state).toBe(1);
      expect(msg.replace_by).toBe("sc2");
      expect(msg.content).toBe("short");
      expect(msg.original_content).toBe("original long content");
    });

    it("preserves content when not provided", () => {
      createChat("c1");
      addMessage("m1", "c1", { role: "sense", content: "keep" });
      markMessageReplaced("c1", "m1", {
        replace: { state: true, by: "sc2", content: "short" },
      });
      const msg = getMessages("c1").find((m) => m.id === "m1") as MessageRow;
      expect(msg.content).toBe("keep");
    });
  });

  describe("parseMessageRow", () => {
    it("parses a full message row including senseCall", () => {
      createChat("c1");
      addMessage("m1", "c1", {
        role: "assistant",
        content: "c",
        thinking: "t",
        senseCall: [{ id: "sc1", name: "read_file", arguments: "{}" }],
        hash: "h",
      });
      const row = getMessages("c1").find((m) => m.id === "m1") as MessageRow;
      const parsed = parseMessageRow(row);
      expect(parsed.role).toBe("assistant");
      expect(parsed.content).toBe("c");
      expect(parsed.thinking).toBe("t");
      expect(parsed.senseCall).toEqual([{ id: "sc1", name: "read_file", arguments: "{}" }]);
      expect(parsed.hash).toBe("h");
      expect(parsed.revoked).toBe(false);
    });

    it("parses replace metadata when replace_state=1", () => {
      createChat("c1");
      addMessage("m1", "c1", { role: "sense", content: "x" });
      markMessageReplaced("c1", "m1", {
        replace: { state: true, by: "sc2", content: "short" },
        originalContent: "orig",
      });
      const row = getMessages("c1").find((m) => m.id === "m1") as MessageRow;
      const parsed = parseMessageRow(row);
      expect(parsed.replace).toEqual({ state: true, by: "sc2", content: "short" });
      expect(parsed.originalContent).toBe("orig");
    });

    it("parses revoked=1 as revoked true", () => {
      createChat("c1");
      addMessage("m1", "c1", { role: "user", content: "x" });
      markMessagesRevoked("c1", ["m1"]);
      const row = getMessages("c1").find((m) => m.id === "m1") as MessageRow;
      expect(parseMessageRow(row).revoked).toBe(true);
    });
  });
});
