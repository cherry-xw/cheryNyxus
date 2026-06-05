import { describe, it, expect } from "vitest";

describe("core/tool/compiler/index", () => {
  it("should export compileTools", async () => {
    const mod = await import("@/core/tool/compiler/index.js");
    expect(mod.compileTools).toBeDefined();
    expect(typeof mod.compileTools).toBe("function");
  });

  it("should export parseTestCases", async () => {
    const mod = await import("@/core/tool/compiler/index.js");
    expect(mod.parseTestCases).toBeDefined();
    expect(typeof mod.parseTestCases).toBe("function");
  });

  it("should export type definitions", async () => {
    const mod = await import("@/core/tool/compiler/index.js");
    // These are type-only exports, just verify module loads
    expect(mod).toBeDefined();
  });
});
