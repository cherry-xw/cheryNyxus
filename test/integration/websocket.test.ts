import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { randomUUID } from "crypto";

let testDb: Database.Database;

// Simple DB-focused integration tests
vi.mock("@/db/index.js", () => ({
  getDb: () => testDb,
  closeDb: vi.fn(),
}));

describe("WebSocket Integration - DB Layer", () => {
  beforeAll(async () => {
    testDb = new Database(":memory:");
    testDb.pragma("journal_mode = WAL");
    testDb.exec(`
      CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, metadata TEXT);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT, thinking TEXT, tool_calls TEXT, created_at INTEGER NOT NULL, FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS interrupts (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, session_id TEXT NOT NULL, status TEXT NOT NULL, tool_calls TEXT NOT NULL, context_snapshot TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
      CREATE INDEX IF NOT EXISTS idx_threads_session ON threads(session_id);
      CREATE INDEX IF NOT EXISTS idx_interrupts_session ON interrupts(session_id);
      CREATE INDEX IF NOT EXISTS idx_interrupts_status ON interrupts(status);
    `);
  });

  afterAll(() => {
    if (testDb) testDb.close();
  });

  it("should verify DB threads table has correct schema", () => {
    const tables = testDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    const tableNames = tables.map(t => t.name);
    expect(tableNames).toContain("threads");
    expect(tableNames).toContain("messages");
    expect(tableNames).toContain("interrupts");
  });

  it("should insert and query thread in DB", () => {
    const threadId = randomUUID();
    const sessionId = "test-session";
    const now = Date.now();

    testDb.prepare(
      "INSERT INTO threads (id, session_id, created_at, updated_at) VALUES (?, ?, ?, ?)"
    ).run(threadId, sessionId, now, now);

    const thread = testDb.prepare("SELECT * FROM threads WHERE id = ?").get(threadId) as any;
    expect(thread).toBeDefined();
    expect(thread.session_id).toBe(sessionId);
  });

  it("should insert and query messages in DB", () => {
    const threadId = randomUUID();
    const now = Date.now();

    testDb.prepare(
      "INSERT INTO threads (id, session_id, created_at, updated_at) VALUES (?, ?, ?, ?)"
    ).run(threadId, "sess-1", now, now);

    testDb.prepare(
      "INSERT INTO messages (id, thread_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("msg-1", threadId, "user", "hello", now);

    testDb.prepare(
      "INSERT INTO messages (id, thread_id, role, content, tool_calls, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("msg-2", threadId, "assistant", "hi", '[{"tid":"t1","name":"test","arguments":"{}"}]', now);

    const messages = testDb.prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC").all(threadId) as any[];
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[1].tool_calls).toBeDefined();
  });

  it("should cascade delete messages when thread is deleted", () => {
    const threadId = randomUUID();
    const now = Date.now();

    testDb.prepare(
      "INSERT INTO threads (id, session_id, created_at, updated_at) VALUES (?, ?, ?, ?)"
    ).run(threadId, "sess-cascade", now, now);

    testDb.prepare(
      "INSERT INTO messages (id, thread_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("msg-c1", threadId, "user", "test", now);

    testDb.prepare("DELETE FROM threads WHERE id = ?").run(threadId);

    const messages = testDb.prepare("SELECT * FROM messages WHERE thread_id = ?").all(threadId);
    expect(messages).toHaveLength(0);
  });

  it("should insert and query interrupt in DB", () => {
    const interruptId = randomUUID();
    const threadId = randomUUID();
    const sessionId = "sess-int";
    const now = Date.now();

    testDb.prepare(
      "INSERT INTO threads (id, session_id, created_at, updated_at) VALUES (?, ?, ?, ?)"
    ).run(threadId, sessionId, now, now);

    testDb.prepare(
      "INSERT INTO interrupts (id, thread_id, session_id, status, tool_calls, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(interruptId, threadId, sessionId, "pending", '[{"tid":"t1","name":"test"}]', now, now);

    const interrupt = testDb.prepare("SELECT * FROM interrupts WHERE id = ?").get(interruptId) as any;
    expect(interrupt).toBeDefined();
    expect(interrupt.status).toBe("pending");
    expect(interrupt.session_id).toBe(sessionId);
  });

  it("should update interrupt status", () => {
    const interruptId = randomUUID();
    const threadId = randomUUID();
    const now = Date.now();

    testDb.prepare(
      "INSERT INTO threads (id, session_id, created_at, updated_at) VALUES (?, ?, ?, ?)"
    ).run(threadId, "sess-upd", now, now);

    testDb.prepare(
      "INSERT INTO interrupts (id, thread_id, session_id, status, tool_calls, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(interruptId, threadId, "sess-upd", "pending", '[]', now, now);

    testDb.prepare(
      "UPDATE interrupts SET status = ?, updated_at = ? WHERE id = ?"
    ).run("acknowledged", Date.now(), interruptId);

    const interrupt = testDb.prepare("SELECT * FROM interrupts WHERE id = ?").get(interruptId) as any;
    expect(interrupt.status).toBe("acknowledged");
  });

  it("should query interrupts by status", () => {
    const now = Date.now();
    testDb.prepare(
      "INSERT INTO threads (id, session_id, created_at, updated_at) VALUES (?, ?, ?, ?)"
    ).run("thread-pending", "sess-p", now, now);
    testDb.prepare(
      "INSERT INTO threads (id, session_id, created_at, updated_at) VALUES (?, ?, ?, ?)"
    ).run("thread-complete", "sess-c", now, now);

    testDb.prepare(
      "INSERT INTO interrupts (id, thread_id, session_id, status, tool_calls, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("int-p", "thread-pending", "sess-p", "pending", '[]', now, now);
    testDb.prepare(
      "INSERT INTO interrupts (id, thread_id, session_id, status, tool_calls, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("int-c", "thread-complete", "sess-c", "completed", '[]', now, now);

    const pending = testDb.prepare("SELECT * FROM interrupts WHERE status = ?").all("pending") as any[];
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every(i => i.status === "pending")).toBe(true);
  });

  it("should query interrupts by session_id", () => {
    const now = Date.now();
    const sessionId = "sess-multi";

    testDb.prepare(
      "INSERT INTO threads (id, session_id, created_at, updated_at) VALUES (?, ?, ?, ?)"
    ).run("thread-m1", sessionId, now, now);
    testDb.prepare(
      "INSERT INTO threads (id, session_id, created_at, updated_at) VALUES (?, ?, ?, ?)"
    ).run("thread-m2", sessionId, now, now);

    testDb.prepare(
      "INSERT INTO interrupts (id, thread_id, session_id, status, tool_calls, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("int-m1", "thread-m1", sessionId, "pending", '[]', now, now);
    testDb.prepare(
      "INSERT INTO interrupts (id, thread_id, session_id, status, tool_calls, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("int-m2", "thread-m2", sessionId, "pending", '[]', now, now);

    const interrupts = testDb.prepare("SELECT * FROM interrupts WHERE session_id = ?").all(sessionId) as any[];
    expect(interrupts.length).toBeGreaterThanOrEqual(2);
    expect(interrupts.every(i => i.session_id === sessionId)).toBe(true);
  });
});
