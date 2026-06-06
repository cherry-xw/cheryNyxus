import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { sense } from "@/core/sense/senseCreator";
import { SupervisionLevel } from "@/core/config";

describe("senseRegistry", () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  async function getRegistry() {
    const mod = await import("@/core/sense/senseRegistry");
    return mod;
  }

  function createTestSense(name: string, level?: SupervisionLevel) {
    return sense(
      name,
      `Test sense ${name}`,
      z.object({}),
      async () => ({ content: "ok", hash: "" }),
      level,
    );
  }

  describe("getSenses", () => {
    it("should return only existing senses", async () => {
      const { registerSenses, getSenses } = await getRegistry();
      const s = createTestSense("existing");
      registerSenses([s]);

      const result = getSenses(["existing", "non_existent"]);
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(s);
    });

    it("should return empty array for empty input", async () => {
      const { getSenses } = await getRegistry();
      expect(getSenses([])).toHaveLength(0);
    });
  });
});
