import { describe, it, expect } from "vitest";
import { SupervisionLevel } from "@/core/config";

describe("SupervisionLevel", () => {
  it("has correct enum values", () => {
    expect(SupervisionLevel.auto).toBe(0);
    expect(SupervisionLevel.confirm).toBe(1);
    expect(SupervisionLevel.manual).toBe(2);
  });

  it("auto is lowest level", () => {
    expect(SupervisionLevel.auto).toBeLessThan(SupervisionLevel.confirm);
    expect(SupervisionLevel.auto).toBeLessThan(SupervisionLevel.manual);
  });

  it("confirm is middle level", () => {
    expect(SupervisionLevel.confirm).toBeGreaterThan(SupervisionLevel.auto);
    expect(SupervisionLevel.confirm).toBeLessThan(SupervisionLevel.manual);
  });

  it("manual is highest level", () => {
    expect(SupervisionLevel.manual).toBeGreaterThan(SupervisionLevel.auto);
    expect(SupervisionLevel.manual).toBeGreaterThan(SupervisionLevel.confirm);
  });
});