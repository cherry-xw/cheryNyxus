import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { join } from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { SQLiteApprovalRepository, type ApprovalEntity } from "@/db/approval.js";

describe("db/approval", () => {
  let tempDir: string;
  let db: Database.Database;
  let repo: SQLiteApprovalRepository;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "cheryclaw-approval-test-"));
    const dbPath = join(tempDir, "test.db");
    db = new Database(dbPath);
    // Initialize tables
    db.exec(`
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        soul_id TEXT NOT NULL,
        status TEXT NOT NULL,
        sense_calls TEXT NOT NULL,
        context_snapshot TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_approvals_soul ON approvals(soul_id);
      CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
    `);
    repo = new SQLiteApprovalRepository(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createEntity(overrides?: Partial<ApprovalEntity>): ApprovalEntity {
    const now = Date.now();
    return {
      id: "test-approval-1",
      chatId: "chat-1",
      soulId: "soul-1",
      status: "pending",
      senseCalls: [
        {
          id: "call-1",
          name: "execute_command",
          arguments: JSON.stringify({ cmd: "ls" }),
          approved: false,
          triggeredAt: now,
        },
      ],
      contextSnapshot: null,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  describe("create", () => {
    it("should create approval entity", async () => {
      const entity = createEntity();
      await repo.create(entity);

      const found = await repo.findById(entity.id);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(entity.id);
      expect(found?.chatId).toBe(entity.chatId);
      expect(found?.soulId).toBe(entity.soulId);
      expect(found?.status).toBe("pending");
    });

    it("should store sense calls as JSON", async () => {
      const entity = createEntity();
      await repo.create(entity);

      const found = await repo.findById(entity.id);
      expect(found?.senseCalls).toHaveLength(1);
      expect(found?.senseCalls![0]!.name).toBe("execute_command");
    });

    it("should store context snapshot as JSON", async () => {
      const entity = createEntity({
        contextSnapshot: {
          messages: JSON.stringify([{ role: "user", content: "hello" }]),
          userInputs: [{ content: "hello", time: Date.now() }],
          brain: { provider: "ollama", model: "gemma3:1b" },
        },
      });
      await repo.create(entity);

      const found = await repo.findById(entity.id);
      expect(found?.contextSnapshot).not.toBeNull();
      expect(found?.contextSnapshot?.brain.provider).toBe("ollama");
    });
  });

  describe("findById", () => {
    it("should return null for non-existent id", async () => {
      const found = await repo.findById("non-existent");
      expect(found).toBeNull();
    });

    it("should find existing entity", async () => {
      const entity = createEntity({ id: "approval-find-test" });
      await repo.create(entity);

      const found = await repo.findById("approval-find-test");
      expect(found).not.toBeNull();
      expect(found?.id).toBe("approval-find-test");
    });
  });

  describe("findBySoulId", () => {
    it("should return empty array for non-existent soul", async () => {
      const found = await repo.findBySoulId("non-existent-soul");
      expect(found).toEqual([]);
    });

    it("should find all approvals for a soul", async () => {
      await repo.create(createEntity({ id: "approval-1", soulId: "soul-test" }));
      await repo.create(createEntity({ id: "approval-2", soulId: "soul-test" }));
      await repo.create(createEntity({ id: "approval-3", soulId: "other-soul" }));

      const found = await repo.findBySoulId("soul-test");
      expect(found).toHaveLength(2);
      expect(found.map((a) => a.id).sort()).toEqual(["approval-1", "approval-2"]);
    });

    it("should return approvals sorted by created_at DESC", async () => {
      const baseTime = Date.now();
      await repo.create(
        createEntity({ id: "approval-old", soulId: "soul-sort", createdAt: baseTime }),
      );
      await repo.create(
        createEntity({ id: "approval-new", soulId: "soul-sort", createdAt: baseTime + 1000 }),
      );

      const found = await repo.findBySoulId("soul-sort");
      expect(found[0]!.id).toBe("approval-new");
      expect(found[1]!.id).toBe("approval-old");
    });
  });

  describe("findByStatus", () => {
    it("should return empty array for non-existent status", async () => {
      const found = await repo.findByStatus("completed");
      expect(found).toEqual([]);
    });

    it("should find approvals by status", async () => {
      await repo.create(createEntity({ id: "approval-pending", status: "pending" }));
      await repo.create(createEntity({ id: "approval-ack", status: "acknowledged" }));
      await repo.create(createEntity({ id: "approval-done", status: "completed" }));

      const pending = await repo.findByStatus("pending");
      expect(pending).toHaveLength(1);
      expect(pending[0]!.id).toBe("approval-pending");

      const completed = await repo.findByStatus("completed");
      expect(completed).toHaveLength(1);
      expect(completed[0]!.id).toBe("approval-done");
    });
  });

  describe("update", () => {
    it("should update status", async () => {
      const entity = createEntity({ id: "approval-update-test" });
      await repo.create(entity);

      await repo.update("approval-update-test", { status: "acknowledged" });

      const found = await repo.findById("approval-update-test");
      expect(found?.status).toBe("acknowledged");
    });

    it("should update sense calls", async () => {
      const entity = createEntity({ id: "approval-update-calls" });
      await repo.create(entity);

      const newCalls = [
        {
          id: "call-1",
          name: "read_file",
          arguments: JSON.stringify({ path: "/test" }),
          approved: true,
          triggeredAt: Date.now(),
        },
      ];
      await repo.update("approval-update-calls", { senseCalls: newCalls });

      const found = await repo.findById("approval-update-calls");
      expect(found?.senseCalls).toHaveLength(1);
      expect(found?.senseCalls![0]!.name).toBe("read_file");
      expect(found?.senseCalls![0]!.approved).toBe(true);
    });

    it("should update context snapshot", async () => {
      const entity = createEntity({ id: "approval-update-ctx" });
      await repo.create(entity);

      await repo.update("approval-update-ctx", {
        contextSnapshot: {
          messages: null,
          userInputs: [],
          brain: { provider: "openai", model: "gpt-4" },
        },
      });

      const found = await repo.findById("approval-update-ctx");
      expect(found?.contextSnapshot?.brain.provider).toBe("openai");
    });

    it("should update updatedAt timestamp", async () => {
      const entity = createEntity({ id: "approval-update-time" });
      await repo.create(entity);

      const newTime = Date.now() + 1000;
      await repo.update("approval-update-time", { updatedAt: newTime });

      const found = await repo.findById("approval-update-time");
      expect(found?.updatedAt).toBe(newTime);
    });

    it("should do nothing when no changes provided", async () => {
      const entity = createEntity({ id: "approval-no-change" });
      await repo.create(entity);

      await repo.update("approval-no-change", {});

      const found = await repo.findById("approval-no-change");
      expect(found?.status).toBe("pending");
    });
  });

  describe("delete", () => {
    it("should delete existing approval", async () => {
      const entity = createEntity({ id: "approval-delete-test" });
      await repo.create(entity);

      await repo.delete("approval-delete-test");

      const found = await repo.findById("approval-delete-test");
      expect(found).toBeNull();
    });

    it("should not throw for non-existent id", async () => {
      await expect(repo.delete("non-existent")).resolves.not.toThrow();
    });
  });
});