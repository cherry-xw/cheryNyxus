import { describe, it, expect } from "vitest";
import * as senseIndex from "@/core/sense/index";

describe("sense index exports", () => {
  it("exports sense factory", () => {
    expect(senseIndex.sense).toBeDefined();
    expect(typeof senseIndex.sense).toBe("function");
  });

  it("exports sense registry functions", () => {
    expect(senseIndex.registerSenses).toBeDefined();
    expect(senseIndex.resetSenses).toBeDefined();
    expect(senseIndex.getSense).toBeDefined();
  });

  it("exports sense adapter registry", () => {
    expect(senseIndex.registerSenseAdapter).toBeDefined();
    expect(senseIndex.getSenseAdapter).toBeDefined();
    expect(senseIndex.senseAdapterRegistry).toBeDefined();
  });

  it("exports approval registry functions", () => {
    expect(senseIndex.createApproval).toBeDefined();
    expect(senseIndex.resolveApproval).toBeDefined();
    expect(senseIndex.rejectApproval).toBeDefined();
  });

  it("does NOT export SenseManager (removed in refactor)", () => {
    expect((senseIndex as any).SenseManager).toBeUndefined();
  });
});
