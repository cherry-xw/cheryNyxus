import { describe, it, expect } from "vitest";
import * as toolIndex from "@/core/sense/index";

describe("tool index exports", () => {
  it("exports senseCreator", () => {
    expect(toolIndex.tool).toBeDefined();
    expect(typeof toolIndex.tool).toBe("function");
  });

  it("exports SenseManager", () => {
    expect(toolIndex.SenseManager).toBeDefined();
    expect(typeof toolIndex.SenseManager).toBe("function");
  });

  it("exports registerSenseAdapter", () => {
    expect(toolIndex.registerSenseAdapter).toBeDefined();
    expect(typeof toolIndex.registerSenseAdapter).toBe("function");
  });

  it("exports getSenseAdapter", () => {
    expect(toolIndex.getSenseAdapter).toBeDefined();
    expect(typeof toolIndex.getSenseAdapter).toBe("function");
  });
});