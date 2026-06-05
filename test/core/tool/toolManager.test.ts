import { describe, it, expect, beforeEach, vi } from "vitest";
import { ToolManager } from "@/core/tool/toolManager";
import {
  registerToolAdapter,
  toolAdapterRegistry,
  type ToolAdapter,
} from "@/core/tool/adapter";
import { registerTools } from "@/core/tool/toolRegistry";
import { tool } from "@/core/tool/toolCreator";
import { SupervisionLevel } from "@/core/config";
import { z } from "zod";
import type { ToolGroupConfig } from "@/utils/config";

// Mock ToolAdapter
const mockAdapter: ToolAdapter<unknown, unknown> = {
  buildTools: () => [],
  buildToolCallMessage: () => ({ role: "assistant" }),
  buildToolResponseMessage: () => ({ role: "tool" }),
  extractToolCalls: () => [],
  assembleToolCallChunks: () => [],
};

describe("ToolManager", () => {
  beforeEach(() => {
    toolAdapterRegistry.clear();
    registerToolAdapter("test-provider", mockAdapter);
  });

  describe("constructor", () => {
    it("creates instance with registered adapter", () => {
      const manager = new ToolManager("test-provider");
      expect(manager).toBeDefined();
      expect(manager.getAdapter()).toBe(mockAdapter);
    });

    it("throws error for unregistered provider", () => {
      expect(() => new ToolManager("unknown-provider")).toThrow(
        "Tool adapter for provider \"unknown-provider\" not registered"
      );
    });
  });

  describe("add", () => {
    it("adds single tool", () => {
      const manager = new ToolManager("test-provider");
      const testTool = tool(
        "single_tool",
        "Single tool",
        z.object({}),
        async () => ({ content: "ok", hash: "" }),
      );

      manager.add(testTool);

      expect(manager.getAll().length).toBe(1);
      expect(manager.get("single_tool")).toBe(testTool);
    });

    it("adds multiple tools", () => {
      const manager = new ToolManager("test-provider");
      const tool1 = tool("tool1", "First", z.object({}), async () => ({ content: "", hash: "" }));
      const tool2 = tool("tool2", "Second", z.object({}), async () => ({ content: "", hash: "" }));

      manager.add([tool1, tool2]);

      expect(manager.getAll().length).toBe(2);
      expect(manager.get("tool1")).toBe(tool1);
      expect(manager.get("tool2")).toBe(tool2);
    });

    it("allows adding tools incrementally", () => {
      const manager = new ToolManager("test-provider");
      const tool1 = tool("t1", "", z.object({}), async () => ({ content: "", hash: "" }));
      const tool2 = tool("t2", "", z.object({}), async () => ({ content: "", hash: "" }));

      manager.add(tool1);
      manager.add(tool2);

      expect(manager.getAll().length).toBe(2);
    });
  });

  describe("get", () => {
    it("returns tool by name", () => {
      const manager = new ToolManager("test-provider");
      const testTool = tool("get_test", "", z.object({}), async () => ({ content: "", hash: "" }));
      manager.add(testTool);

      expect(manager.get("get_test")).toBe(testTool);
    });

    it("returns undefined for unknown tool", () => {
      const manager = new ToolManager("test-provider");

      expect(manager.get("unknown")).toBeUndefined();
    });
  });

  describe("execute", () => {
    it("executes tool and returns result", async () => {
      const manager = new ToolManager("test-provider");
      const testTool = tool(
        "exec_test",
        "Execute test",
        z.object({ input: z.string() }),
        async ({ input }) => ({ content: `result: ${input}`, hash: "hash123" }),
      );
      manager.add(testTool);

      const sharedData = new Map<string, Map<string, unknown>>();
      const result = await manager.execute("exec_test", { input: "test" }, sharedData);

      expect(result.content).toBe("result: test");
      expect(result.hash).toBe("hash123");
    });

    it("returns error for unknown tool", async () => {
      const manager = new ToolManager("test-provider");
      const sharedData = new Map<string, Map<string, unknown>>();

      const result = await manager.execute("unknown", {}, sharedData);

      expect(result.content).toContain("Error: Tool \"unknown\" not found");
      expect(result.hash).toBe("");
    });

    it("passes toolSharedData to executor", async () => {
      const manager = new ToolManager("test-provider");
      const testTool = tool(
        "shared_test",
        "",
        z.object({}),
        async (_, data) => ({
          content: `has data: ${data.size > 0}`,
          hash: "",
        }),
      );
      manager.add(testTool);

      const sharedData = new Map();
      sharedData.set("key", new Map());

      const result = await manager.execute("shared_test", {}, sharedData);
      expect(result.content).toBe("has data: true");
    });
  });

  describe("getAll", () => {
    it("returns all added tools", () => {
      const manager = new ToolManager("test-provider");
      const tool1 = tool("a", "", z.object({}), async () => ({ content: "", hash: "" }));
      const tool2 = tool("b", "", z.object({}), async () => ({ content: "", hash: "" }));

      manager.add([tool1, tool2]);

      const all = manager.getAll();
      expect(all).toHaveLength(2);
      expect(all).toContain(tool1);
      expect(all).toContain(tool2);
    });

    it("returns empty array when no tools added", () => {
      const manager = new ToolManager("test-provider");
      expect(manager.getAll()).toHaveLength(0);
    });
  });

  describe("getAdapter", () => {
    it("returns the registered adapter", () => {
      const manager = new ToolManager("test-provider");
      expect(manager.getAdapter()).toBe(mockAdapter);
    });
  });

  describe("setSupervision", () => {
    it("overrides tool supervision level", () => {
      const manager = new ToolManager("test-provider");
      const testTool = tool(
        "supervision_override",
        "Test",
        z.object({}),
        async () => ({ content: "", hash: "" }),
        SupervisionLevel.auto,
      );
      manager.add(testTool);

      manager.setSupervision("supervision_override", SupervisionLevel.manual);

      expect(testTool.supervisionLevel).toBe(SupervisionLevel.manual);
    });

    it("does nothing for non-existent tool", () => {
      const manager = new ToolManager("test-provider");
      expect(() => manager.setSupervision("non_existent", SupervisionLevel.auto)).not.toThrow();
    });
  });

  describe("fillSupervisionDefault", () => {
    it("fills undefined supervision levels with provided level", () => {
      const manager = new ToolManager("test-provider");
      const testTool = tool(
        "no_supervision",
        "Test",
        z.object({}),
        async () => ({ content: "", hash: "" }),
      );
      manager.add(testTool);

      expect(testTool.supervisionLevel).toBeUndefined();

      manager.fillSupervisionDefault(SupervisionLevel.confirm);

      expect(testTool.supervisionLevel).toBe(SupervisionLevel.confirm);
    });

    it("skips tools that already have a supervision level", () => {
      const manager = new ToolManager("test-provider");
      const testTool = tool(
        "has_supervision",
        "Test",
        z.object({}),
        async () => ({ content: "", hash: "" }),
        SupervisionLevel.manual,
      );
      manager.add(testTool);

      manager.fillSupervisionDefault(SupervisionLevel.auto);

      expect(testTool.supervisionLevel).toBe(SupervisionLevel.manual);
    });
  });

  describe("loadFromGroups", () => {
    it("loads tools from single group", () => {
      const manager = new ToolManager("test-provider");
      const tool1 = tool("g1_tool", "Group1", z.object({}), async () => ({ content: "", hash: "" }));
      registerTools([tool1]);

      const toolGroups: Record<string, ToolGroupConfig> = {
        group1: { tools: ["g1_tool"] },
      };

      manager.loadFromGroups(["group1"], toolGroups, SupervisionLevel.auto);

      expect(manager.get("g1_tool")).toBe(tool1);
      expect(tool1.supervisionLevel).toBe(SupervisionLevel.auto);
    });

    it("loads tools from multiple groups with dedup (later overrides)", () => {
      const manager = new ToolManager("test-provider");
      const tool1v1 = tool("shared", "V1", z.object({}), async () => ({ content: "v1", hash: "" }));
      const tool1v2 = tool("shared", "V2", z.object({}), async () => ({ content: "v2", hash: "" }));
      registerTools([tool1v1]);
      // Re-register overrides
      registerTools([tool1v2]);

      const toolGroups: Record<string, ToolGroupConfig> = {
        group1: { tools: ["shared"] },
        group2: { tools: ["shared"] },
      };

      manager.loadFromGroups(["group1", "group2"], toolGroups, SupervisionLevel.confirm);

      // 后加载覆盖前加载
      expect(manager.get("shared")).toBe(tool1v2);
    });

    it("applies group-level supervision override", () => {
      const manager = new ToolManager("test-provider");
      const tool1 = tool(
        "g_tool",
        "Test",
        z.object({}),
        async () => ({ content: "", hash: "" }),
        SupervisionLevel.auto, // 工具自身声明
      );
      registerTools([tool1]);

      const toolGroups: Record<string, ToolGroupConfig> = {
        strict: { tools: ["g_tool"], supervision: SupervisionLevel.manual },
      };

      manager.loadFromGroups(["strict"], toolGroups, SupervisionLevel.confirm);

      // 组级别覆盖工具自身声明
      expect(tool1.supervisionLevel).toBe(SupervisionLevel.manual);
    });

    it("skips missing groups with warning", () => {
      const manager = new ToolManager("test-provider");
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      manager.loadFromGroups(["nonexistent"], {}, SupervisionLevel.auto);

      expect(consoleSpy).toHaveBeenCalledWith('Tool group "nonexistent" not found, skipping');
      expect(manager.getAll()).toHaveLength(0);

      consoleSpy.mockRestore();
    });

    it("handles empty group names", () => {
      const manager = new ToolManager("test-provider");

      manager.loadFromGroups([], undefined, SupervisionLevel.auto);

      expect(manager.getAll()).toHaveLength(0);
    });
  });
});