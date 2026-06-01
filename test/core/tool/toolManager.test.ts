import { describe, it, expect, beforeEach, vi } from "vitest";
import { ToolManager } from "@/core/tool/toolManager";
import {
  registerToolAdapter,
  toolAdapterRegistry,
  type ToolAdapter,
  type ToolCallData,
} from "@/core/tool/adapter";
import { tool, type ToolResult } from "@/core/tool/toolCreator";
import { SupervisionLevel } from "@/core/config";
import { z, type ZodType } from "zod";

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
});