import { describe, it, expect } from "vitest";

describe("core/tool/compiler/index", () => {
  it("should export compileSenses", async () => {
    const mod = await import("@/core/sense/compiler/index.js");
    expect(mod.compileSenses).toBeDefined();
    expect(typeof mod.compileSenses).toBe("function");
  });

  it("should export parseTestCases", async () => {
    const mod = await import("@/core/sense/compiler/index.js");
    expect(mod.parseTestCases).toBeDefined();
    expect(typeof mod.parseTestCases).toBe("function");
  });

  it("should export type definitions", async () => {
    const mod = await import("@/core/sense/compiler/index.js");
    // These are type-only exports, just verify module loads
    expect(mod).toBeDefined();
  });
});
