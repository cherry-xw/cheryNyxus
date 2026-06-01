import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { tool } from "@/core/tool/toolCreator";
import { SupervisionLevel } from "@/core/config";

describe("toolRegistry", () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  async function getRegistry() {
    const mod = await import("@/core/tool/toolRegistry");
    return mod;
  }

  function createTestTool(name: string, level?: SupervisionLevel) {
    return tool(
      name,
      `Test tool ${name}`,
      z.object({}),
      async () => ({ content: "ok", hash: "" }),
      level,
    );
  }

  describe("registerTool", () => {
    it("should register a valid tool", async () => {
      const { registerTool, getTool } = await getRegistry();
      const t = createTestTool("reg_test");
      registerTool(t);

      expect(getTool("reg_test")).toBe(t);
    });

    it("should register tool supervision level", async () => {
      const { registerTool, getToolSupervision } = await getRegistry();
      const t = createTestTool("supervision_test", SupervisionLevel.confirm);
      registerTool(t);

      expect(getToolSupervision("supervision_test")).toBe(SupervisionLevel.confirm);
    });

    it("should handle tool with missing definition gracefully", async () => {
      const { registerTool, getTool } = await getRegistry();
      registerTool({} as any);

      expect(getTool(undefined as any)).toBeUndefined();
    });

    it("should overwrite tool with same name", async () => {
      const { registerTool, getTool } = await getRegistry();
      const t1 = createTestTool("dup_tool");
      const t2 = createTestTool("dup_tool");
      registerTool(t1);
      registerTool(t2);

      expect(getTool("dup_tool")).toBe(t2);
    });
  });

  describe("registerTools", () => {
    it("should register multiple tools", async () => {
      const { registerTools, getTool } = await getRegistry();
      const tools = [createTestTool("batch1"), createTestTool("batch2")];
      registerTools(tools);

      expect(getTool("batch1")).toBeDefined();
      expect(getTool("batch2")).toBeDefined();
    });
  });

  describe("getTool", () => {
    it("should return undefined for non-existent tool", async () => {
      const { getTool } = await getRegistry();
      expect(getTool("non_existent")).toBeUndefined();
    });
  });

  describe("getTools", () => {
    it("should return only existing tools", async () => {
      const { registerTool, getTools } = await getRegistry();
      const t = createTestTool("existing");
      registerTool(t);

      const result = getTools(["existing", "non_existent"]);
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(t);
    });

    it("should return empty array for empty input", async () => {
      const { getTools } = await getRegistry();
      expect(getTools([])).toHaveLength(0);
    });
  });

  describe("getToolSupervision", () => {
    it("should return undefined for non-existent tool", async () => {
      const { getToolSupervision } = await getRegistry();
      expect(getToolSupervision("non_existent")).toBeUndefined();
    });
  });

  describe("getAllToolNames", () => {
    it("should return all registered tool names", async () => {
      const { registerTool, getAllToolNames } = await getRegistry();
      registerTool(createTestTool("name1"));
      registerTool(createTestTool("name2"));

      const names = getAllToolNames();
      expect(names).toContain("name1");
      expect(names).toContain("name2");
    });
  });
});
