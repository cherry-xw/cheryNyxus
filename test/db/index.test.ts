import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// config 单例在 setup.ts 中固定 db_dir 指向 fixtures，跨文件并行会污染。
// 每 db 测试文件 vi.mock config，把 db_dir 重定向到独立 tempDir（见 testDb.ts）。
const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    global: { db_dir: "" },
    llm: { brain: {} },
    sense_groups: {},
  },
}));

vi.mock("@/utils/config.js", () => ({ default: mockConfig }));

import { getSoulDb, getMonthlyDb, closeAllDbs } from "@/db/index.js";
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

describe("db/index", () => {
  describe("getSoulDb", () => {
    it("returns singleton instance across calls", () => {
      const a = getSoulDb();
      const b = getSoulDb();
      expect(a).toBe(b);
    });

    it("initializes chats table with message_count column", () => {
      const db = getSoulDb();
      const cols = db.prepare("PRAGMA table_info(chats)").all() as { name: string }[];
      const names = cols.map((c) => c.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "id",
          "messages_month",
          "created_at",
          "updated_at",
          "metadata",
          "message_count",
        ]),
      );
    });

    it("enables WAL journal mode", () => {
      const db = getSoulDb();
      const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
      expect(row.journal_mode.toLowerCase()).toBe("wal");
    });

    it("enables foreign_keys pragma", () => {
      const db = getSoulDb();
      const row = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
      expect(row.foreign_keys).toBe(1);
    });
  });

  describe("getMonthlyDb", () => {
    it("returns singleton per yearMonth", () => {
      const a = getMonthlyDb("2026-06");
      const b = getMonthlyDb("2026-06");
      expect(a).toBe(b);
    });

    it("returns distinct instance for different month", () => {
      const a = getMonthlyDb("2026-06");
      const b = getMonthlyDb("2026-07");
      expect(a).not.toBe(b);
    });

    it("initializes messages table (revoked + sense_calls) and chat index", () => {
      const db = getMonthlyDb("2026-06");
      const cols = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
      const names = cols.map((c) => c.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "id",
          "chat_id",
          "role",
          "content",
          "thinking",
          "sense_calls",
          "hash",
          "replace_state",
          "replace_by",
          "replace_content",
          "original_content",
          "revoked",
          "created_at",
        ]),
      );

      const indexes = db.prepare("PRAGMA index_list(messages)").all() as { name: string }[];
      expect(indexes.some((i) => i.name === "idx_messages_chat")).toBe(true);
    });

    it("enables WAL journal mode", () => {
      const db = getMonthlyDb("2026-06");
      const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
      expect(row.journal_mode.toLowerCase()).toBe("wal");
    });
  });

  describe("closeAllDbs", () => {
    it("clears cache so next getSoulDb returns a new instance", () => {
      const a = getSoulDb();
      getMonthlyDb("2026-06");
      closeAllDbs();
      const b = getSoulDb();
      expect(b).not.toBe(a);
    });

    it("clears monthly cache so next getMonthlyDb returns a new instance", () => {
      const a = getMonthlyDb("2026-06");
      closeAllDbs();
      const b = getMonthlyDb("2026-06");
      expect(b).not.toBe(a);
    });

    it("does not throw when no db initialized", () => {
      expect(() => closeAllDbs()).not.toThrow();
    });
  });
});
