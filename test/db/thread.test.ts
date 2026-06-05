import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import type { ThreadRow, MessageRow, MessageData } from "@/db/thread.js";

const { getTestDb, setTestDb } = vi.hoisted(() => {
  let db: Database.Database | null = null;
  return {
    getTestDb: (): Database.Database => db!,
    setTestDb: (d: Database.Database) => { db = d; },
  };
});

vi.mock("@/db/index.js", () => ({
  getDb: getTestDb,
}));

// Prevent interrupt.ts top-level side effect (interruptRepo = new SQLiteInterruptRepository(getDb()))
vi.mock("@/db/interrupt.js", () => ({}));

function createInMemoryDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      metadata TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      thinking TEXT,
      tool_calls TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
    CREATE INDEX IF NOT EXISTS idx_threads_session ON threads(session_id);
  `);
  return db;
}

describe("db/thread", () => {
  beforeEach(() => {
    setTestDb(createInMemoryDb());
  });

  afterEach(() => {
    const db = getTestDb();
    db.close();
  });

  describe("createThread", () => {
    it("should insert and return correct ThreadRow", async () => {
      const { createThread } = await import("@/db/thread.js");
      const before = Date.now();
      const row = createThread("thread-1", "session-1");
      const after = Date.now();

      expect(row.id).toBe("thread-1");
      expect(row.session_id).toBe("session-1");
      expect(row.created_at).toBeGreaterThanOrEqual(before);
      expect(row.created_at).toBeLessThanOrEqual(after);
      expect(row.updated_at).toBe(row.created_at);
      expect(row.metadata).toBeNull();
    });

    it("should store metadata as JSON string", async () => {
      const { createThread } = await import("@/db/thread.js");
      const meta = { key: "value", count: 42 };
      const row = createThread("thread-2", "session-1", meta);

      expect(row.metadata).toBe(JSON.stringify(meta));

      // Verify raw DB content
      const raw = getTestDb().prepare("SELECT metadata FROM threads WHERE id = ?").get("thread-2") as { metadata: string };
      expect(raw.metadata).toBe(JSON.stringify(meta));
    });

    it("should store null metadata when not provided", async () => {
      const { createThread } = await import("@/db/thread.js");
      const row = createThread("thread-3", "session-1");

      expect(row.metadata).toBeNull();
    });
  });

  describe("getThread", () => {
    it("should return existing thread", async () => {
      const { createThread, getThread } = await import("@/db/thread.js");
      createThread("thread-1", "session-1");

      const row = getThread("thread-1");
      expect(row).toBeDefined();
      expect(row?.id).toBe("thread-1");
      expect(row?.session_id).toBe("session-1");
    });

    it("should return undefined for nonexistent thread", async () => {
      const { getThread } = await import("@/db/thread.js");
      const row = getThread("nonexistent");
      expect(row).toBeUndefined();
    });
  });

  describe("listThreadsBySession", () => {
    it("should return threads for given session filtered correctly", async () => {
      const { createThread, listThreadsBySession } = await import("@/db/thread.js");
      createThread("t-1", "session-a");
      createThread("t-2", "session-b");
      createThread("t-3", "session-a");

      const rows = listThreadsBySession("session-a");
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.session_id === "session-a")).toBe(true);
    });

    it("should return empty for unknown session", async () => {
      const { listThreadsBySession } = await import("@/db/thread.js");
      const rows = listThreadsBySession("unknown-session");
      expect(rows).toHaveLength(0);
    });
  });

  describe("updateThread", () => {
    it("should update updated_at timestamp", async () => {
      const { createThread, updateThread } = await import("@/db/thread.js");
      const row = createThread("thread-1", "session-1");
      const originalUpdatedAt = row.updated_at;

      // Small delay to ensure timestamp differs
      await new Promise((resolve) => setTimeout(resolve, 5));
      updateThread("thread-1");

      const updated = getTestDb().prepare("SELECT updated_at FROM threads WHERE id = ?").get("thread-1") as { updated_at: number };
      expect(updated.updated_at).toBeGreaterThanOrEqual(originalUpdatedAt);
    });
  });

  describe("deleteThread", () => {
    it("should remove thread", async () => {
      const { createThread, deleteThread, getThread } = await import("@/db/thread.js");
      createThread("thread-1", "session-1");
      expect(getThread("thread-1")).toBeDefined();

      deleteThread("thread-1");
      expect(getThread("thread-1")).toBeUndefined();
    });
  });

  describe("addMessage", () => {
    it("should insert message with all fields", async () => {
      const { createThread, addMessage } = await import("@/db/thread.js");
      createThread("thread-1", "session-1");

      const toolCalls: MessageData["toolCalls"] = [
        { id: "tc-1", type: "function", function: { name: "test_tool", arguments: '{"key":"value"}' } },
      ];

      const row = addMessage("msg-1", "thread-1", {
        role: "assistant",
        content: "hello",
        thinking: "deep thought",
        toolCalls,
      });

      expect(row.id).toBe("msg-1");
      expect(row.thread_id).toBe("thread-1");
      expect(row.role).toBe("assistant");
      expect(row.content).toBe("hello");
      expect(row.thinking).toBe("deep thought");
      expect(JSON.parse(row.tool_calls!)).toEqual(toolCalls);
    });

    it("should update thread updated_at on message insert", async () => {
      const { createThread, addMessage } = await import("@/db/thread.js");
      const thread = createThread("thread-1", "session-1");
      const originalUpdatedAt = thread.updated_at;

      await new Promise((resolve) => setTimeout(resolve, 5));
      addMessage("msg-1", "thread-1", { role: "user", content: "hi" });

      const updated = getTestDb().prepare("SELECT updated_at FROM threads WHERE id = ?").get("thread-1") as { updated_at: number };
      expect(updated.updated_at).toBeGreaterThanOrEqual(originalUpdatedAt);
    });
  });

  describe("getMessages", () => {
    it("should return messages ordered by created_at ASC", async () => {
      const { createThread, addMessage, getMessages } = await import("@/db/thread.js");
      createThread("thread-1", "session-1");

      addMessage("msg-1", "thread-1", { role: "user", content: "first" });
      addMessage("msg-2", "thread-1", { role: "assistant", content: "second" });
      addMessage("msg-3", "thread-1", { role: "user", content: "third" });

      const msgs = getMessages("thread-1");
      expect(msgs).toHaveLength(3);
      expect(msgs[0]!.content).toBe("first");
      expect(msgs[1]!.content).toBe("second");
      expect(msgs[2]!.content).toBe("third");

      // Verify ordering by created_at
      for (let i = 1; i < msgs.length; i++) {
        expect(msgs[i]!.created_at).toBeGreaterThanOrEqual(msgs[i - 1]!.created_at);
      }
    });

    it("should return empty for thread with no messages", async () => {
      const { createThread, getMessages } = await import("@/db/thread.js");
      createThread("thread-1", "session-1");

      const msgs = getMessages("thread-1");
      expect(msgs).toHaveLength(0);
    });
  });

  describe("clearMessages", () => {
    it("should delete all messages for thread", async () => {
      const { createThread, addMessage, clearMessages, getMessages } = await import("@/db/thread.js");
      createThread("thread-1", "session-1");
      addMessage("msg-1", "thread-1", { role: "user", content: "a" });
      addMessage("msg-2", "thread-1", { role: "assistant", content: "b" });

      expect(getMessages("thread-1")).toHaveLength(2);

      clearMessages("thread-1");
      expect(getMessages("thread-1")).toHaveLength(0);
    });
  });

  describe("parseMessageRow", () => {
    it("should deserialize full MessageRow with all fields", async () => {
      const { parseMessageRow } = await import("@/db/thread.js");
      const toolCalls = [{ id: "tc-1", type: "function" as const, function: { name: "tool", arguments: "{}" } }];
      const row: MessageRow = {
        id: "msg-1",
        thread_id: "thread-1",
        role: "assistant",
        content: "response",
        thinking: "thoughts",
        tool_calls: JSON.stringify(toolCalls),
        created_at: Date.now(),
      };

      const data = parseMessageRow(row);
      expect(data.role).toBe("assistant");
      expect(data.content).toBe("response");
      expect(data.thinking).toBe("thoughts");
      expect(data.toolCalls).toEqual(toolCalls);
    });

    it("should handle null optional fields", async () => {
      const { parseMessageRow } = await import("@/db/thread.js");
      const row: MessageRow = {
        id: "msg-2",
        thread_id: "thread-1",
        role: "user",
        content: null,
        thinking: null,
        tool_calls: null,
        created_at: Date.now(),
      };

      const data = parseMessageRow(row);
      expect(data.role).toBe("user");
      expect(data.content).toBeUndefined();
      expect(data.thinking).toBeUndefined();
      expect(data.toolCalls).toBeUndefined();
    });
  });
});
