import { describe, it, expect, beforeEach, vi } from "vitest";
import { z } from "zod";
import { sense } from "@/core/sense/senseCreator";
import { SupervisionLevel } from "@/core/config";

describe("senseRegistry", () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  async function getRegistry() {
    return await import("@/core/sense/senseRegistry");
  }

  function createSense(name: string, level?: SupervisionLevel) {
    return sense(
      name,
      `Test ${name}`,
      z.object({}),
      async () => ({ content: "ok", hash: "" }),
      level,
    );
  }

  describe("registerSenses / getSense", () => {
    it("registers and retrieves by name", async () => {
      const { registerSenses, getSense } = await getRegistry();
      const s = createSense("alpha");
      registerSenses([s]);
      expect(getSense("alpha")).toBe(s);
    });

    it("getSense returns undefined for unregistered name", async () => {
      const { getSense } = await getRegistry();
      expect(getSense("missing")).toBeUndefined();
    });

    it("registers multiple senses", async () => {
      const { registerSenses, getSense } = await getRegistry();
      registerSenses([createSense("a"), createSense("b")]);
      expect(getSense("a")).toBeDefined();
      expect(getSense("b")).toBeDefined();
    });

    it("overwrites same-named sense on re-register", async () => {
      const { registerSenses, getSense } = await getRegistry();
      const s1 = createSense("dup");
      const s2 = createSense("dup");
      registerSenses([s1]);
      registerSenses([s2]);
      expect(getSense("dup")).toBe(s2);
    });

    it("skips entries without definition.function.name", async () => {
      const { registerSenses, getSense } = await getRegistry();
      registerSenses([
        null as any,
        undefined as any,
        { definition: {} } as any,
        createSense("valid"),
      ]);
      expect(getSense("valid")).toBeDefined();
    });
  });

  describe("resetSenses", () => {
    it("clears the registry", async () => {
      const { registerSenses, getSense, resetSenses } = await getRegistry();
      registerSenses([createSense("x")]);
      expect(getSense("x")).toBeDefined();

      resetSenses();
      expect(getSense("x")).toBeUndefined();
    });

    it("allows re-registering after reset", async () => {
      const { registerSenses, getSense, resetSenses } = await getRegistry();
      registerSenses([createSense("y")]);
      resetSenses();
      registerSenses([createSense("z")]);
      expect(getSense("z")).toBeDefined();
      expect(getSense("y")).toBeUndefined();
    });
  });
});
