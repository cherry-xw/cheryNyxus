import { describe, it, expect, beforeEach, vi } from "vitest";
import { SenseManager } from "@/core/sense/senseManager";
import {
  registerSenseAdapter,
  senseAdapterRegistry,
  type SenseAdapter,
} from "@/core/sense/adapter";
import { registerSenses } from "@/core/sense/senseRegistry";
import { sense } from "@/core/sense/senseCreator";
import { SupervisionLevel } from "@/core/config";
import { z } from "zod";
import type { SenseGroupConfig } from "@/utils/config";

// Mock SenseAdapter
const mockAdapter: SenseAdapter<unknown, unknown> = {
  buildSenses: () => [],
  buildSenseCallMessage: () => ({ role: "assistant" }),
  buildSenseResponseMessage: () => ({ role: "tool" }),
  senseCalls: () => [],
  extractSenseCallDeltas: () => [],
};

describe("SenseManager", () => {
  beforeEach(() => {
    senseAdapterRegistry.clear();
    registerSenseAdapter("test-provider", mockAdapter);
  });

  describe("constructor", () => {
    it("creates instance with registered adapter", () => {
      const manager = new SenseManager("test-provider");
      expect(manager).toBeDefined();
      expect(manager.getAdapter()).toBe(mockAdapter);
    });

    it("throws error for unregistered provider", () => {
      expect(() => new SenseManager("unknown-provider")).toThrow(
        'Sense adapter for provider "unknown-provider" not registered'
      );
    });
  });

  describe("add", () => {
    it("adds single sense", () => {
      const manager = new SenseManager("test-provider");
      const testSense = sense(
        "single_sense",
        "Single sense",
        z.object({}),
        async () => ({ content: "ok", hash: "" }),
      );

      manager.add(testSense);

      expect(manager.getAll().length).toBe(1);
      expect(manager.get("single_sense")).toBe(testSense);
    });

    it("adds multiple senses", () => {
      const manager = new SenseManager("test-provider");
      const sense1 = sense("sense1", "First", z.object({}), async () => ({ content: "", hash: "" }));
      const sense2 = sense("sense2", "Second", z.object({}), async () => ({ content: "", hash: "" }));

      manager.add([sense1, sense2]);

      expect(manager.getAll().length).toBe(2);
      expect(manager.get("sense1")).toBe(sense1);
      expect(manager.get("sense2")).toBe(sense2);
    });

    it("allows adding senses incrementally", () => {
      const manager = new SenseManager("test-provider");
      const sense1 = sense("s1", "", z.object({}), async () => ({ content: "", hash: "" }));
      const sense2 = sense("s2", "", z.object({}), async () => ({ content: "", hash: "" }));

      manager.add(sense1);
      manager.add(sense2);

      expect(manager.getAll().length).toBe(2);
    });
  });

  describe("get", () => {
    it("returns sense by name", () => {
      const manager = new SenseManager("test-provider");
      const testSense = sense("get_test", "", z.object({}), async () => ({ content: "", hash: "" }));
      manager.add(testSense);

      expect(manager.get("get_test")).toBe(testSense);
    });

    it("returns undefined for unknown sense", () => {
      const manager = new SenseManager("test-provider");

      expect(manager.get("unknown")).toBeUndefined();
    });
  });

  describe("execute", () => {
    it("executes sense and returns result", async () => {
      const manager = new SenseManager("test-provider");
      const testSense = sense(
        "exec_test",
        "Execute test",
        z.object({ input: z.string() }),
        async ({ input }) => ({ content: `result: ${input}`, hash: "hash123" }),
      );
      manager.add(testSense);

      const sharedData = new Map<string, Map<string, unknown>>();
      const result = await manager.execute("exec_test", { input: "test" }, sharedData);

      expect(result.content).toBe("result: test");
      expect(result.hash).toBe("hash123");
    });

    it("returns error for unknown sense", async () => {
      const manager = new SenseManager("test-provider");
      const sharedData = new Map<string, Map<string, unknown>>();

      const result = await manager.execute("unknown", {}, sharedData);

      expect(result.content).toContain('Error: Sense "unknown" not found');
      expect(result.hash).toBe("");
    });

    it("passes senseSharedData to executor", async () => {
      const manager = new SenseManager("test-provider");
      const testSense = sense(
        "shared_test",
        "",
        z.object({}),
        async (_, data) => ({
          content: `has data: ${data.size > 0}`,
          hash: "",
        }),
      );
      manager.add(testSense);

      const sharedData = new Map();
      sharedData.set("key", new Map());

      const result = await manager.execute("shared_test", {}, sharedData);
      expect(result.content).toBe("has data: true");
    });
  });

  describe("getAll", () => {
    it("returns all added senses", () => {
      const manager = new SenseManager("test-provider");
      const sense1 = sense("a", "", z.object({}), async () => ({ content: "", hash: "" }));
      const sense2 = sense("b", "", z.object({}), async () => ({ content: "", hash: "" }));

      manager.add([sense1, sense2]);

      const all = manager.getAll();
      expect(all).toHaveLength(2);
      expect(all).toContain(sense1);
      expect(all).toContain(sense2);
    });

    it("returns empty array when no senses added", () => {
      const manager = new SenseManager("test-provider");
      expect(manager.getAll()).toHaveLength(0);
    });
  });

  describe("getAdapter", () => {
    it("returns the registered adapter", () => {
      const manager = new SenseManager("test-provider");
      expect(manager.getAdapter()).toBe(mockAdapter);
    });
  });

  describe("setSupervision", () => {
    it("overrides sense supervision level", () => {
      const manager = new SenseManager("test-provider");
      const testSense = sense(
        "supervision_override",
        "Test",
        z.object({}),
        async () => ({ content: "", hash: "" }),
        SupervisionLevel.auto,
      );
      manager.add(testSense);

      manager.setSupervision("supervision_override", SupervisionLevel.manual);

      expect(testSense.supervisionLevel).toBe(SupervisionLevel.manual);
    });

    it("does nothing for non-existent sense", () => {
      const manager = new SenseManager("test-provider");
      expect(() => manager.setSupervision("non_existent", SupervisionLevel.auto)).not.toThrow();
    });
  });

  describe("loadFromGroups", () => {
    it("loads senses from single group", () => {
      const manager = new SenseManager("test-provider");
      const sense1 = sense("g1_sense", "Group1", z.object({}), async () => ({ content: "", hash: "" }));
      registerSenses([sense1]);

      const senseGroups: Record<string, SenseGroupConfig> = {
        group1: { senses: ["g1_sense"] },
      };

      manager.loadFromGroups(["group1"], senseGroups, SupervisionLevel.auto);

      expect(manager.get("g1_sense")).toBe(sense1);
      expect(sense1.supervisionLevel).toBe(SupervisionLevel.auto);
    });

    it("loads senses from multiple groups with dedup (later overrides)", () => {
      const manager = new SenseManager("test-provider");
      const sense1v1 = sense("shared", "V1", z.object({}), async () => ({ content: "v1", hash: "" }));
      const sense1v2 = sense("shared", "V2", z.object({}), async () => ({ content: "v2", hash: "" }));
      registerSenses([sense1v1]);
      // Re-register overrides
      registerSenses([sense1v2]);

      const senseGroups: Record<string, SenseGroupConfig> = {
        group1: { senses: ["shared"] },
        group2: { senses: ["shared"] },
      };

      manager.loadFromGroups(["group1", "group2"], senseGroups, SupervisionLevel.confirm);

      // 后加载覆盖前加载
      expect(manager.get("shared")).toBe(sense1v2);
    });

    it("applies group-level supervision override", () => {
      const manager = new SenseManager("test-provider");
      const sense1 = sense(
        "g_sense",
        "Test",
        z.object({}),
        async () => ({ content: "", hash: "" }),
        SupervisionLevel.auto, // 感官自身声明
      );
      registerSenses([sense1]);

      const senseGroups: Record<string, SenseGroupConfig> = {
        strict: { senses: ["g_sense"], supervision: SupervisionLevel.manual },
      };

      manager.loadFromGroups(["strict"], senseGroups, SupervisionLevel.confirm);

      // 组级别覆盖感官自身声明
      expect(sense1.supervisionLevel).toBe(SupervisionLevel.manual);
    });

    it("skips missing groups with warning", () => {
      const manager = new SenseManager("test-provider");
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      manager.loadFromGroups(["nonexistent"], {}, SupervisionLevel.auto);

      expect(consoleSpy).toHaveBeenCalledWith('Sense group "nonexistent" not found, skipping');
      expect(manager.getAll()).toHaveLength(0);

      consoleSpy.mockRestore();
    });

    it("handles empty group names", () => {
      const manager = new SenseManager("test-provider");

      manager.loadFromGroups([], undefined, SupervisionLevel.auto);

      expect(manager.getAll()).toHaveLength(0);
    });
  });
});