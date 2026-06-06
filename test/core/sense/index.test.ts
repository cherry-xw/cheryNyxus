import { describe, it, expect } from "vitest";
import * as senseIndex from "@/core/sense/index";

describe("sense index exports", () => {
  it("exports senseCreator", () => {
    expect(senseIndex.sense).toBeDefined();
    expect(typeof senseIndex.sense).toBe("function");
  });

  it("exports SenseManager", () => {
    expect(senseIndex.SenseManager).toBeDefined();
    expect(typeof senseIndex.SenseManager).toBe("function");
  });

  it("exports registerSenseAdapter", () => {
    expect(senseIndex.registerSenseAdapter).toBeDefined();
    expect(typeof senseIndex.registerSenseAdapter).toBe("function");
  });

  it("exports getSenseAdapter", () => {
    expect(senseIndex.getSenseAdapter).toBeDefined();
    expect(typeof senseIndex.getSenseAdapter).toBe("function");
  });
});