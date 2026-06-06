import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb, closeTestDb } from "@test/helpers/testDb";
import type { InterruptEntity, ContextSnapshot } from "@/db/interrupt.js";
import type { SenseCallAccumulator } from "@/core/middleware/types.js";

function makeSenseCall(overrides: Partial<SenseCallAccumulator> = {}): SenseCallAccumulator {
  return {
    tid: "tc-1",
    name: "test_tool",
    arguments: '{"key":"value"}',
    approved: false,
    triggeredAt: Date.now(),
    ...overrides,
  };
}

function makeEntity(overrides: Partial<InterruptEntity> = {}): InterruptEntity {
  const now = Date.now();
  return {
    id: "int-1",
    threadId: "thread-1",
    sessionId: "session-1",
    status: "pending",
    senseCalls: [makeSenseCall()],
    contextSnapshot: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeContextSnapshot(): ContextSnapshot {
  return {
    history: [
      { id: "h-1", role: "user", content: "hello", thinking: null, senseCalls: null, createdAt: Date.now() },
    ],
    toolCallAccumulated: [["tc-1", makeSenseCall()]],
    pendingInputs: [{ input: "test input", time: Date.now() }],
    config: { provider: "openai", model: "gpt-4", sense_group: "safe_senses" },
  };
}

describe("db/interrupt", () => {
  let db: Database.Database;
  let repo: InstanceType<typeof import("@/db/interrupt.js").SQLiteInterruptRepository>;

  beforeEach(async () => {
    db = createTestDb();
    const { SQLiteInterruptRepository } = await import("@/db/interrupt.js");
    repo = new SQLiteInterruptRepository(db);
  });

  afterEach(() => {
    closeTestDb(db);
  });

  describe("constructor", () => {
    it("should create interrupts table", () => {
      const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='interrupts'").get();
      expect(table).toBeDefined();
    });

    it("should create idx_interrupts_session index", () => {
      const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_interrupts_session'").get();
      expect(idx).toBeDefined();
    });

    it("should create idx_interrupts_status index", () => {
      const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_interrupts_status'").get();
      expect(idx).toBeDefined();
    });
  });

  describe("create", () => {
    it("should insert entity and be retrievable via findById", async () => {
      const entity = makeEntity();
      await repo.create(entity);

      const found = await repo.findById(entity.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(entity.id);
    });

    it("should serialize senseCalls to JSON in raw storage", async () => {
      const senseCalls = [makeSenseCall({ tid: "tc-99", name: "my_tool" })];
      const entity = makeEntity({ senseCalls });
      await repo.create(entity);

      const raw = db.prepare("SELECT tool_calls FROM interrupts WHERE id = ?").get(entity.id) as { tool_calls: string };
      expect(JSON.parse(raw.tool_calls)).toEqual(senseCalls);
    });

    it("should store null contextSnapshot when not provided", async () => {
      const entity = makeEntity({ contextSnapshot: null });
      await repo.create(entity);

      const raw = db.prepare("SELECT context_snapshot FROM interrupts WHERE id = ?").get(entity.id) as { context_snapshot: string | null };
      expect(raw.context_snapshot).toBeNull();
    });
  });

  describe("findById", () => {
    it("should return entity with deserialized fields", async () => {
      const senseCalls = [makeSenseCall({ tid: "tc-a" }), makeSenseCall({ tid: "tc-b", name: "other_tool" })];
      const snapshot = makeContextSnapshot();
      const entity = makeEntity({ senseCalls, contextSnapshot: snapshot });
      await repo.create(entity);

      const found = await repo.findById(entity.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(entity.id);
      expect(found!.threadId).toBe(entity.threadId);
      expect(found!.sessionId).toBe(entity.sessionId);
      expect(found!.status).toBe(entity.status);
      expect(found!.senseCalls).toEqual(senseCalls);
      expect(found!.contextSnapshot).toEqual(snapshot);
      expect(found!.createdAt).toBe(entity.createdAt);
      expect(found!.updatedAt).toBe(entity.updatedAt);
    });

    it("should return null for nonexistent id", async () => {
      const found = await repo.findById("nonexistent");
      expect(found).toBeNull();
    });
  });

  describe("findBySessionId", () => {
    it("should return entities for given session", async () => {
      await repo.create(makeEntity({ id: "int-1", sessionId: "session-a" }));
      await repo.create(makeEntity({ id: "int-2", sessionId: "session-b" }));
      await repo.create(makeEntity({ id: "int-3", sessionId: "session-a" }));

      const results = await repo.findBySessionId("session-a");
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.sessionId === "session-a")).toBe(true);
    });

    it("should return empty for unknown session", async () => {
      const results = await repo.findBySessionId("unknown");
      expect(results).toHaveLength(0);
    });
  });

  describe("findByStatus", () => {
    it("should return entities matching status", async () => {
      await repo.create(makeEntity({ id: "int-1", status: "pending" }));
      await repo.create(makeEntity({ id: "int-2", status: "completed" }));
      await repo.create(makeEntity({ id: "int-3", status: "pending" }));

      const results = await repo.findByStatus("pending");
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.status === "pending")).toBe(true);
    });

    it("should return empty for no matches", async () => {
      await repo.create(makeEntity({ id: "int-1", status: "pending" }));
      const results = await repo.findByStatus("timeout");
      expect(results).toHaveLength(0);
    });
  });

  describe("update", () => {
    it("should change status field", async () => {
      const entity = makeEntity({ status: "pending" });
      await repo.create(entity);

      await repo.update(entity.id, { status: "acknowledged" });

      const found = await repo.findById(entity.id);
      expect(found!.status).toBe("acknowledged");
    });

    it("should update multiple fields at once", async () => {
      const entity = makeEntity();
      await repo.create(entity);
      const newUpdatedAt = Date.now() + 1000;

      await repo.update(entity.id, { status: "completed", updatedAt: newUpdatedAt });

      const found = await repo.findById(entity.id);
      expect(found!.status).toBe("completed");
      expect(found!.updatedAt).toBe(newUpdatedAt);
    });

    it("should be no-op when no fields provided", async () => {
      const entity = makeEntity({ status: "pending" });
      await repo.create(entity);

      await repo.update(entity.id, {});

      const found = await repo.findById(entity.id);
      expect(found!.status).toBe("pending");
    });
  });

  describe("delete", () => {
    it("should remove entity", async () => {
      const entity = makeEntity();
      await repo.create(entity);
      expect(await repo.findById(entity.id)).not.toBeNull();

      await repo.delete(entity.id);
      expect(await repo.findById(entity.id)).toBeNull();
    });
  });

  describe("full round-trip", () => {
    it("should preserve all fields through create and findById", async () => {
      const senseCalls = [
        makeSenseCall({ tid: "tc-1", name: "first_tool", arguments: '{"a":1}', approved: true }),
        makeSenseCall({ tid: "tc-2", name: "second_tool", arguments: '{"b":2}', approved: false }),
      ];
      const snapshot = makeContextSnapshot();
      const now = Date.now();

      const entity: InterruptEntity = {
        id: "round-trip-1",
        threadId: "thread-rt",
        sessionId: "session-rt",
        status: "pending",
        senseCalls,
        contextSnapshot: snapshot,
        createdAt: now,
        updatedAt: now,
      };

      await repo.create(entity);
      const found = await repo.findById(entity.id);

      expect(found).not.toBeNull();
      expect(found!.id).toBe("round-trip-1");
      expect(found!.threadId).toBe("thread-rt");
      expect(found!.sessionId).toBe("session-rt");
      expect(found!.status).toBe("pending");
      expect(found!.senseCalls).toEqual(senseCalls);
      expect(found!.contextSnapshot).toEqual(snapshot);
      expect(found!.createdAt).toBe(now);
      expect(found!.updatedAt).toBe(now);
    });
  });
});
