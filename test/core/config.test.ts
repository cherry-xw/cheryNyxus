import { describe, it, expect } from "vitest";
import { SupervisionLevel } from "@/core/config";

describe("SupervisionLevel", () => {
  it("has correct enum values", () => {
    expect(SupervisionLevel.auto).toBe(0);
    expect(SupervisionLevel.smart).toBe(1);
    expect(SupervisionLevel.manual).toBe(2);
  });

  it("auto is lowest level", () => {
    expect(SupervisionLevel.auto).toBeLessThan(SupervisionLevel.smart);
    expect(SupervisionLevel.auto).toBeLessThan(SupervisionLevel.manual);
  });

  it("smart is middle level", () => {
    expect(SupervisionLevel.smart).toBeGreaterThan(SupervisionLevel.auto);
    expect(SupervisionLevel.smart).toBeLessThan(SupervisionLevel.manual);
  });

  it("manual is highest level", () => {
    expect(SupervisionLevel.manual).toBeGreaterThan(SupervisionLevel.auto);
    expect(SupervisionLevel.manual).toBeGreaterThan(SupervisionLevel.smart);
  });
});
