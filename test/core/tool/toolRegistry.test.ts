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

  describe("getTools", () => {
    it("should return only existing tools", async () => {
      const { registerTools, getTools } = await getRegistry();
      const t = createTestTool("existing");
      registerTools([t]);

      const result = getTools(["existing", "non_existent"]);
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(t);
    });

    it("should return empty array for empty input", async () => {
      const { getTools } = await getRegistry();
      expect(getTools([])).toHaveLength(0);
    });
  });
});
