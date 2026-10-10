import { describe, it, expect, beforeEach } from "vitest";
import { sense, type SenseFunction, type SenseResult } from "@/core/sense/senseCreator";
import { SupervisionLevel } from "@/core/config";
import { z } from "zod";

describe("sense factory function", () => {
  describe("definition generation", () => {
    it("creates correct function definition", () => {
      const testSense = sense(
        "test_sense",
        "A test sense",
        z.object({ path: z.string() }),
        async () => ({ content: "ok", hash: "" }),
      );

      expect(testSense.definition.type).toBe("function");
      expect(testSense.definition.function.name).toBe("test_sense");
      expect(testSense.definition.function.description).toBe("A test sense");
      expect(testSense.definition.function.parameters.type).toBe("object");
      expect(testSense.definition.function.parameters.required).toEqual(["path"]);
      // 源码 definition.function 不生成 strict 字段（仅 type/name/description/parameters）
    });

    it("creates correct schema for multiple parameters", () => {
      const testSense = sense(
        "multi_params",
        "Sense with multiple params",
        z.object({
          path: z.string(),
          count: z.number(),
          enabled: z.boolean().optional(),
        }),
        async () => ({ content: "ok", hash: "" }),
      );

      expect(testSense.definition.function.parameters.required).toEqual(["path", "count"]);
    });

    it("handles optional parameters", () => {
      const testSense = sense(
        "optional_params",
        "Sense with optional params",
        z.object({
          required: z.string(),
          optional: z.string().optional(),
        }),
        async () => ({ content: "ok", hash: "" }),
      );

      expect(testSense.definition.function.parameters.required).toEqual(["required"]);
    });
  });

  describe("executor creation", () => {
    it("creates executor with correct schema", () => {
      const schema = z.object({ input: z.string() });
      const testSense = sense(
        "schema_test",
        "Test schema",
        schema,
        async () => ({ content: "ok", hash: "" }),
      );

      expect(testSense.executor.schema).toBe(schema);
    });

    it("executor execute function returns SenseResult", async () => {
      const testSense = sense(
        "executor_test",
        "Test executor",
        z.object({ msg: z.string() }),
        async ({ msg }) => ({ content: `received: ${msg}`, hash: "test-hash" }),
      );

      const result = await testSense.executor.execute({ msg: "hello" }, new Map());
      expect(result).toHaveProperty("content");
      expect(result).toHaveProperty("hash");
      expect(result.content).toBe("received: hello");
      expect(result.hash).toBe("test-hash");
    });

    it("executor receives senseSharedData", async () => {
      const sharedData = new Map<string, Map<string, unknown>>();
      sharedData.set("test", new Map([["key", "value"]]));

      const testSense = sense(
        "shared_data_test",
        "Test shared data",
        z.object({}),
        async (_, data) => ({
          content: JSON.stringify(Array.from(data.entries())),
          hash: "",
        }),
      );

      const result = await testSense.executor.execute({}, sharedData);
      expect(result.content).toContain("test");
    });
  });

  describe("supervision level", () => {
    it("defaults to undefined when not specified", () => {
      const testSense = sense(
        "default_level",
        "Default supervision",
        z.object({}),
        async () => ({ content: "ok", hash: "" }),
      );

      expect(testSense.supervisionLevel).toBeUndefined();
    });

    it("accepts custom supervision level", () => {
      const autoSense = sense(
        "auto_sense",
        "Auto execution",
        z.object({}),
        async () => ({ content: "ok", hash: "" }),
        SupervisionLevel.auto,
      );

      const manualSense = sense(
        "manual_sense",
        "Manual execution",
        z.object({}),
        async () => ({ content: "ok", hash: "" }),
        SupervisionLevel.manual,
      );

      expect(autoSense.supervisionLevel).toBe(SupervisionLevel.auto);
      expect(manualSense.supervisionLevel).toBe(SupervisionLevel.manual);
    });
  });
});