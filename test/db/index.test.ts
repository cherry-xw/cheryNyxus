import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { existsSync } from "fs";
import { join } from "path";
import { createTempDir, cleanupTempDir } from "@test/helpers/tempDir";

describe("db/index", () => {
  let tempDir: string;
  const tempDirs: string[] = [];

  beforeEach(() => {
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

  describe("getDb", () => {
    it("should create .chery directory and database file when needed", async () => {
      const { getDb } = await import("@/db/index.js");
      getDb();

      const dbPath = join(tempDir, ".chery", "data.db");
      expect(existsSync(join(tempDir, ".chery"))).toBe(true);
      expect(existsSync(dbPath)).toBe(true);
    });

    it("should return same instance on repeated calls (singleton)", async () => {
      const { getDb } = await import("@/db/index.js");
      const db1 = getDb();
      const db2 = getDb();
      expect(db1).toBe(db2);
    });
  });

  describe("initTables", () => {
    it("should create threads table", async () => {
      const { getDb } = await import("@/db/index.js");
      const db = getDb();

      const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='threads'").get();
      expect(table).toBeDefined();
    });

    it("should create messages table", async () => {
      const { getDb } = await import("@/db/index.js");
      const db = getDb();

      const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'").get();
      expect(table).toBeDefined();
    });

    it("should create idx_messages_thread index", async () => {
      const { getDb } = await import("@/db/index.js");
      const db = getDb();

      const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_messages_thread'").get();
      expect(idx).toBeDefined();
    });

    it("should create idx_threads_session index", async () => {
      const { getDb } = await import("@/db/index.js");
      const db = getDb();

      const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_threads_session'").get();
      expect(idx).toBeDefined();
    });
  });

  describe("closeDb", () => {
    it("should close and reset singleton (next getDb returns new instance)", async () => {
      const { getDb, closeDb } = await import("@/db/index.js");
      const db1 = getDb();
      closeDb();

      // Re-import to get fresh module state
      vi.resetModules();
      const { getDb: getDb2 } = await import("@/db/index.js");
      const db2 = getDb2();
      expect(db2).not.toBe(db1);
    });

    it("should be safe when no db exists", async () => {
      const { closeDb } = await import("@/db/index.js");
      expect(() => closeDb()).not.toThrow();
    });
  });

  describe("WAL journal mode", () => {
    it("should set WAL journal mode", async () => {
      const { getDb } = await import("@/db/index.js");
      const db = getDb();

      const row = db.pragma("journal_mode")[0];
      expect(row.journal_mode).toBe("wal");
    });
  });
});
