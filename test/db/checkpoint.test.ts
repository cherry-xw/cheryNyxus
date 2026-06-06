import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { join } from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { SQLiteCheckpointRepository, type CheckpointEntity } from "@/db/checkpoint.js";

describe("db/checkpoint", () => {
  let tempDir: string;
  let db: Database.Database;
  let repo: SQLiteCheckpointRepository;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "cheryclaw-checkpoint-test-"));
    const dbPath = join(tempDir, "test.db");
    db = new Database(dbPath);
    repo = new SQLiteCheckpointRepository(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createEntity(overrides?: Partial<CheckpointEntity>): CheckpointEntity {
    const now = Date.now();
    return {
      id: "checkpoint-1",
      soulId: "soul-1",
      chatId: "chat-1",
      phase: "thinking",
      pendingSenses: "[]",
      thinkingAccumulated: "Thinking...",
      contentAccumulated: "Content...",
      messages: JSON.stringify([{ role: "user", content: "hello" }]),
      createdAt: now,
      ...overrides,
    };
  }

  describe("create", () => {
    it("should create checkpoint entity", async () => {
      const entity = createEntity();
      await repo.create(entity);

      const found = await repo.findLatest(entity.soulId, entity.chatId);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(entity.id);
      expect(found?.soulId).toBe(entity.soulId);
      expect(found?.chatId).toBe(entity.chatId);
    });

    it("should store all checkpoint fields", async () => {
      const entity = createEntity({
        id: "checkpoint-fields",
        phase: "content",
        pendingSenses: JSON.stringify([{ id: "call-1", name: "execute_command" }]),
        thinkingAccumulated: "Accumulated thinking",
        contentAccumulated: "Accumulated content",
        messages: JSON.stringify([
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi" },
        ]),
      });
      await repo.create(entity);

      const found = await repo.findLatest(entity.soulId, entity.chatId);
      expect(found?.phase).toBe("content");
      expect(found?.thinkingAccumulated).toBe("Accumulated thinking");
      expect(found?.contentAccumulated).toBe("Accumulated content");
      expect(found?.pendingSenses).toBe(entity.pendingSenses);
      expect(found?.messages).toBe(entity.messages);
    });
  });

  describe("findLatest", () => {
    it("should return null when no checkpoints exist", async () => {
      const found = await repo.findLatest("soul-nonexistent", "chat-nonexistent");
      expect(found).toBeNull();
    });

    it("should return most recent checkpoint", async () => {
      const baseTime = Date.now();
      await repo.create(
        createEntity({
          id: "checkpoint-old",
          createdAt: baseTime,
        }),
      );
      await repo.create(
        createEntity({
          id: "checkpoint-new",
          createdAt: baseTime + 1000,
        }),
      );

      const found = await repo.findLatest("soul-1", "chat-1");
      expect(found?.id).toBe("checkpoint-new");
    });

    it("should return checkpoint for specific chat", async () => {
      await repo.create(
        createEntity({
          id: "checkpoint-chat-a",
          chatId: "chat-a",
        }),
      );
      await repo.create(
        createEntity({
          id: "checkpoint-chat-b",
          chatId: "chat-b",
        }),
      );

      const found = await repo.findLatest("soul-1", "chat-a");
      expect(found?.id).toBe("checkpoint-chat-a");
    });
  });

  describe("findBySoulId", () => {
    it("should return empty array for non-existent soul", async () => {
      const found = await repo.findBySoulId("non-existent-soul");
      expect(found).toEqual([]);
    });

    it("should return all checkpoints for a soul", async () => {
      await repo.create(
        createEntity({
          id: "checkpoint-soul-1",
          soulId: "soul-test",
        }),
      );
      await repo.create(
        createEntity({
          id: "checkpoint-soul-2",
          soulId: "soul-test",
        }),
      );
      await repo.create(
        createEntity({
          id: "checkpoint-other",
          soulId: "other-soul",
        }),
      );

      const found = await repo.findBySoulId("soul-test");
      expect(found).toHaveLength(2);
      expect(found.map((c) => c.id).sort()).toEqual(["checkpoint-soul-1", "checkpoint-soul-2"]);
    });

    it("should return checkpoints sorted by created_at DESC", async () => {
      const baseTime = Date.now();
      await repo.create(
        createEntity({
          id: "checkpoint-old",
          soulId: "soul-sort",
          createdAt: baseTime,
        }),
      );
      await repo.create(
        createEntity({
          id: "checkpoint-new",
          soulId: "soul-sort",
          createdAt: baseTime + 1000,
        }),
      );

      const found = await repo.findBySoulId("soul-sort");
      expect(found[0]!.id).toBe("checkpoint-new");
      expect(found[1]!.id).toBe("checkpoint-old");
    });
  });

  describe("delete", () => {
    it("should delete existing checkpoint", async () => {
      const entity = createEntity({ id: "checkpoint-delete" });
      await repo.create(entity);

      await repo.delete("checkpoint-delete");

      const found = await repo.findLatest(entity.soulId, entity.chatId);
      expect(found).toBeNull();
    });

    it("should not throw for non-existent id", async () => {
      await expect(repo.delete("non-existent")).resolves.not.toThrow();
    });
  });

  describe("cleanup", () => {
    it("should delete all checkpoints for a soul/chat pair", async () => {
      await repo.create(
        createEntity({
          id: "checkpoint-cleanup-1",
          soulId: "soul-cleanup",
          chatId: "chat-cleanup",
        }),
      );
      await repo.create(
        createEntity({
          id: "checkpoint-cleanup-2",
          soulId: "soul-cleanup",
          chatId: "chat-cleanup",
        }),
      );
      await repo.create(
        createEntity({
          id: "checkpoint-keep",
          soulId: "soul-cleanup",
          chatId: "chat-other",
        }),
      );

      await repo.cleanup("soul-cleanup", "chat-cleanup");

      const remaining = await repo.findBySoulId("soul-cleanup");
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.id).toBe("checkpoint-keep");
    });

    it("should not throw for non-existent soul/chat", async () => {
      await expect(repo.cleanup("non-existent", "non-existent")).resolves.not.toThrow();
    });
  });

  describe("table initialization", () => {
    it("should create checkpoints table with correct schema", () => {
      const tableInfo = db.prepare("PRAGMA table_info(checkpoints)").all() as Array<{
        name: string;
        type: string;
      }>;
      const columns = tableInfo.map((col) => col.name);

      expect(columns).toContain("id");
      expect(columns).toContain("soul_id");
      expect(columns).toContain("chat_id");
      expect(columns).toContain("phase");
      expect(columns).toContain("pending_senses");
      expect(columns).toContain("thinking_accumulated");
      expect(columns).toContain("content_accumulated");
      expect(columns).toContain("messages");
      expect(columns).toContain("created_at");
    });

    it("should create indexes", () => {
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='checkpoints'")
        .all() as Array<{ name: string }>;
      const indexNames = indexes.map((idx) => idx.name);

      expect(indexNames).toContain("idx_checkpoints_chat");
      expect(indexNames).toContain("idx_checkpoints_soul");
    });
  });
});