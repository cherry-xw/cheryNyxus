import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { createTempDir, cleanupTempDir } from "@test/helpers/tempDir";

describe("db/soul", () => {
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

  describe("createSoul", () => {
    it("should create a soul", async () => {
      const { createSoul } = await import("@/db/soul.js");
      const data = {
        agentName: "test-agent",
        provider: "ollama",
        model: "gemma3:1b",
      };
      const soul = createSoul("soul-1", data);

      expect(soul.id).toBe("soul-1");
      expect(soul.agent_name).toBe("test-agent");
      expect(soul.provider).toBe("ollama");
      expect(soul.model).toBe("gemma3:1b");
      expect(soul.sense_group).toBeNull();
      expect(soul.created_at).toBeDefined();
      expect(soul.updated_at).toBeDefined();
    });

    it("should create a soul with string sense group", async () => {
      const { createSoul } = await import("@/db/soul.js");
      const data = {
        agentName: "test-agent",
        provider: "ollama",
        model: "gemma3:1b",
        senseGroup: "safe",
      };
      const soul = createSoul("soul-2", data);

      expect(soul.sense_group).toBe("safe");
    });

    it("should create a soul with array sense group", async () => {
      const { createSoul } = await import("@/db/soul.js");
      const data = {
        agentName: "test-agent",
        provider: "ollama",
        model: "gemma3:1b",
        senseGroup: ["safe", "unsafe"],
      };
      const soul = createSoul("soul-3", data);

      expect(soul.sense_group).toBe(JSON.stringify(["safe", "unsafe"]));
    });

    it("should persist soul to database", async () => {
      const { createSoul, getSoul } = await import("@/db/soul.js");
      const data = {
        agentName: "persist-agent",
        provider: "openai",
        model: "gpt-4",
      };
      createSoul("soul-persist", data);

      const soul = getSoul("soul-persist");
      expect(soul).toBeDefined();
      expect(soul?.agent_name).toBe("persist-agent");
      expect(soul?.provider).toBe("openai");
      expect(soul?.model).toBe("gpt-4");
    });
  });

  describe("getSoul", () => {
    it("should return undefined for non-existent soul", async () => {
      const { getSoul } = await import("@/db/soul.js");
      const soul = getSoul("non-existent");
      expect(soul).toBeUndefined();
    });

    it("should return existing soul", async () => {
      const { createSoul, getSoul } = await import("@/db/soul.js");
      createSoul("soul-get-test", {
        agentName: "get-agent",
        provider: "ollama",
        model: "gemma3:1b",
      });

      const soul = getSoul("soul-get-test");
      expect(soul).toBeDefined();
      expect(soul?.id).toBe("soul-get-test");
      expect(soul?.agent_name).toBe("get-agent");
    });
  });

  describe("listSouls", () => {
    it("should return empty array when no souls", async () => {
      const { listSouls } = await import("@/db/soul.js");
      const souls = listSouls();
      expect(souls).toEqual([]);
    });

    it("should return all souls", async () => {
      const { createSoul, listSouls } = await import("@/db/soul.js");
      createSoul("soul-list-1", {
        agentName: "agent-1",
        provider: "ollama",
        model: "gemma3:1b",
      });
      createSoul("soul-list-2", {
        agentName: "agent-2",
        provider: "openai",
        model: "gpt-4",
      });

      const souls = listSouls();
      expect(souls).toHaveLength(2);
    });

    it("should return souls sorted by updated_at DESC", async () => {
      const { createSoul, listSouls } = await import("@/db/soul.js");
      createSoul("soul-old", {
        agentName: "old-agent",
        provider: "ollama",
        model: "gemma3:1b",
      });
      await new Promise((r) => setTimeout(r, 10));
      createSoul("soul-new", {
        agentName: "new-agent",
        provider: "ollama",
        model: "gemma3:1b",
      });

      const souls = listSouls();
      expect(souls[0]!.id).toBe("soul-new");
      expect(souls[1]!.id).toBe("soul-old");
    });
  });

  describe("updateSoul", () => {
    it("should update updated_at timestamp", async () => {
      const { createSoul, updateSoul, getSoul } = await import("@/db/soul.js");
      const soul = createSoul("soul-update", {
        agentName: "update-agent",
        provider: "ollama",
        model: "gemma3:1b",
      });
      const originalTime = soul.updated_at;

      await new Promise((r) => setTimeout(r, 10));
      updateSoul("soul-update");

      const updated = getSoul("soul-update");
      expect(updated?.updated_at).toBeGreaterThan(originalTime);
    });
  });

  describe("deleteSoul", () => {
    it("should delete soul", async () => {
      const { createSoul, deleteSoul, getSoul } = await import("@/db/soul.js");
      createSoul("soul-delete", {
        agentName: "delete-agent",
        provider: "ollama",
        model: "gemma3:1b",
      });
      deleteSoul("soul-delete");

      const soul = getSoul("soul-delete");
      expect(soul).toBeUndefined();
    });

    it("should not throw for non-existent soul", async () => {
      const { deleteSoul } = await import("@/db/soul.js");
      expect(() => deleteSoul("non-existent")).not.toThrow();
    });
  });

  describe("parseSoulRow", () => {
    it("should parse soul row without sense group", async () => {
      const { parseSoulRow } = await import("@/db/soul.js");
      const row = {
        id: "soul-parse-1",
        agent_name: "parse-agent",
        provider: "ollama",
        model: "gemma3:1b",
        sense_group: null,
        created_at: Date.now(),
        updated_at: Date.now(),
      };

      const data = parseSoulRow(row);
      expect(data.id).toBe("soul-parse-1");
      expect(data.agentName).toBe("parse-agent");
      expect(data.provider).toBe("ollama");
      expect(data.model).toBe("gemma3:1b");
      expect(data.senseGroup).toBeUndefined();
      expect(data.createdAt).toBe(row.created_at);
    });

    it("should parse soul row with string sense group", async () => {
      const { parseSoulRow } = await import("@/db/soul.js");
      const row = {
        id: "soul-parse-2",
        agent_name: "parse-agent",
        provider: "ollama",
        model: "gemma3:1b",
        sense_group: "safe",
        created_at: Date.now(),
        updated_at: Date.now(),
      };

      const data = parseSoulRow(row);
      expect(data.senseGroup).toBe("safe");
    });

    it("should parse soul row with array sense group", async () => {
      const { parseSoulRow } = await import("@/db/soul.js");
      const row = {
        id: "soul-parse-3",
        agent_name: "parse-agent",
        provider: "ollama",
        model: "gemma3:1b",
        sense_group: JSON.stringify(["safe", "unsafe"]),
        created_at: Date.now(),
        updated_at: Date.now(),
      };

      const data = parseSoulRow(row);
      expect(data.senseGroup).toEqual(["safe", "unsafe"]);
    });
  });
});