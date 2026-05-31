import { describe, it, expect, beforeEach } from "vitest";
import { tool, type ToolFunction, type ToolResult } from "@/core/tool/toolCreator";
import { SupervisionLevel } from "@/core/config";
import { z } from "zod";

describe("tool factory function", () => {
  describe("definition generation", () => {
    it("creates correct function definition", () => {
      const testTool = tool(
        "test_tool",
        "A test tool",
        z.object({ path: z.string() }),
        async () => ({ content: "ok", hash: "" }),
      );

      expect(testTool.definition.type).toBe("function");
      expect(testTool.definition.function.name).toBe("test_tool");
      expect(testTool.definition.function.description).toBe("A test tool");
      expect(testTool.definition.function.parameters.type).toBe("object");
      expect(testTool.definition.function.parameters.required).toEqual(["path"]);
      expect(testTool.definition.function.strict).toBe(true);
    });

    it("creates correct schema for multiple parameters", () => {
      const testTool = tool(
        "multi_params",
        "Tool with multiple params",
        z.object({
          path: z.string(),
          count: z.number(),
          enabled: z.boolean().optional(),
        }),
        async () => ({ content: "ok", hash: "" }),
      );

      expect(testTool.definition.function.parameters.required).toEqual(["path", "count"]);
    });

    it("handles optional parameters", () => {
      const testTool = tool(
        "optional_params",
        "Tool with optional params",
        z.object({
          required: z.string(),
          optional: z.string().optional(),
        }),
        async () => ({ content: "ok", hash: "" }),
      );

      expect(testTool.definition.function.parameters.required).toEqual(["required"]);
    });
  });

  describe("executor creation", () => {
    it("creates executor with correct schema", () => {
      const schema = z.object({ input: z.string() });
      const testTool = tool(
        "schema_test",
        "Test schema",
        schema,
        async () => ({ content: "ok", hash: "" }),
      );

      expect(testTool.executor.schema).toBe(schema);
    });

    it("executor execute function returns ToolResult", async () => {
      const testTool = tool(
        "executor_test",
        "Test executor",
        z.object({ msg: z.string() }),
        async ({ msg }) => ({ content: `received: ${msg}`, hash: "test-hash" }),
      );

      const result = await testTool.executor.execute({ msg: "hello" }, new Map());
      expect(result).toHaveProperty("content");
      expect(result).toHaveProperty("hash");
      expect(result.content).toBe("received: hello");
      expect(result.hash).toBe("test-hash");
    });

    it("executor receives toolSharedData", async () => {
      const sharedData = new Map<string, Map<string, unknown>>();
      sharedData.set("test", new Map([["key", "value"]]));

      const testTool = tool(
        "shared_data_test",
        "Test shared data",
        z.object({}),
        async (_, data) => ({
          content: JSON.stringify(Array.from(data.entries())),
          hash: "",
        }),
      );

      const result = await testTool.executor.execute({}, sharedData);
      expect(result.content).toContain("test");
    });
  });

  describe("supervision level", () => {
    it("defaults to confirm level", () => {
      const testTool = tool(
        "default_level",
        "Default supervision",
        z.object({}),
        async () => ({ content: "ok", hash: "" }),
      );

      expect(testTool.supervisionLevel).toBe(SupervisionLevel.confirm);
    });

    it("accepts custom supervision level", () => {
      const autoTool = tool(
        "auto_tool",
        "Auto execution",
        z.object({}),
        async () => ({ content: "ok", hash: "" }),
        SupervisionLevel.auto,
      );

      const manualTool = tool(
        "manual_tool",
        "Manual execution",
        z.object({}),
        async () => ({ content: "ok", hash: "" }),
        SupervisionLevel.manual,
      );

      expect(autoTool.supervisionLevel).toBe(SupervisionLevel.auto);
      expect(manualTool.supervisionLevel).toBe(SupervisionLevel.manual);
    });
  });
});