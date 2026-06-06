import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { tool } from "@/core/sense/senseCreator";
import { SupervisionLevel } from "@/core/config";

describe("senseRegistry", () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  async function getRegistry() {
    const mod = await import("@/core/sense/senseRegistry");
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

  describe("getSenses", () => {
    it("should return only existing tools", async () => {
      const { registerSenses, getSenses } = await getRegistry();
      const t = createTestTool("existing");
      registerSenses([t]);

      const result = getSenses(["existing", "non_existent"]);
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(t);
    });

    it("should return empty array for empty input", async () => {
      const { getSenses } = await getRegistry();
      expect(getSenses([])).toHaveLength(0);
    });
  });
});
