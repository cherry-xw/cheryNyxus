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

  describe("unregisterSenses", () => {
    it("removes specified senses by name", async () => {
      const { registerSenses, getSense, unregisterSenses } = await getRegistry();
      registerSenses([createSense("a"), createSense("b"), createSense("c")]);
      unregisterSenses(["a", "c"]);
      expect(getSense("a")).toBeUndefined();
      expect(getSense("b")).toBeDefined();
      expect(getSense("c")).toBeUndefined();
    });

    it("is no-op for names not in registry", async () => {
      const { registerSenses, getSense, unregisterSenses } = await getRegistry();
      registerSenses([createSense("a")]);
      expect(() => unregisterSenses(["nonexistent", "also-gone"])).not.toThrow();
      expect(getSense("a")).toBeDefined();
    });

    it("unregister then re-register works", async () => {
      const { registerSenses, getSense, unregisterSenses } = await getRegistry();
      registerSenses([createSense("x")]);
      unregisterSenses(["x"]);
      expect(getSense("x")).toBeUndefined();
      registerSenses([createSense("x")]);
      expect(getSense("x")).toBeDefined();
    });
  });

  describe("getSenseRegistryVersion", () => {
    it("starts at 0 and increments on register", async () => {
      const { registerSenses, getSenseRegistryVersion } = await getRegistry();
      const v0 = getSenseRegistryVersion();
      registerSenses([createSense("v1")]);
      const v1 = getSenseRegistryVersion();
      expect(v1).toBeGreaterThan(v0);
    });

    it("increments on reset", async () => {
      const { registerSenses, resetSenses, getSenseRegistryVersion } = await getRegistry();
      registerSenses([createSense("v1")]);
      const v1 = getSenseRegistryVersion();
      resetSenses();
      const v2 = getSenseRegistryVersion();
      expect(v2).toBeGreaterThan(v1);
    });

    it("increments on unregister", async () => {
      const { registerSenses, unregisterSenses, getSenseRegistryVersion } = await getRegistry();
      registerSenses([createSense("v1")]);
      const v1 = getSenseRegistryVersion();
      unregisterSenses(["v1"]);
      const v2 = getSenseRegistryVersion();
      expect(v2).toBeGreaterThan(v1);
    });
  });

  describe("sense name aliases", () => {
    it("getSense falls back to alias for spawn_subagent → spawn_role", async () => {
      const { registerSenses, getSense } = await getRegistry();
      const roleSense = createSense("spawn_role");
      registerSenses([roleSense]);
      // Direct lookup works
      expect(getSense("spawn_role")).toBe(roleSense);
      // Alias lookup falls back
      expect(getSense("spawn_subagent")).toBe(roleSense);
    });

    it("getSense falls back to alias for destroy_subagent → destroy_role", async () => {
      const { registerSenses, getSense } = await getRegistry();
      const roleSense = createSense("destroy_role");
      registerSenses([roleSense]);
      expect(getSense("destroy_subagent")).toBe(roleSense);
    });

    it("direct match takes priority over alias", async () => {
      const { registerSenses, getSense } = await getRegistry();
      const directSense = createSense("spawn_subagent");
      const roleSense = createSense("spawn_role");
      registerSenses([directSense, roleSense]);
      // Direct match wins
      expect(getSense("spawn_subagent")).toBe(directSense);
    });

    it("non-aliased unknown name returns undefined", async () => {
      const { getSense } = await getRegistry();
      expect(getSense("totally_unknown")).toBeUndefined();
    });
  });
});
