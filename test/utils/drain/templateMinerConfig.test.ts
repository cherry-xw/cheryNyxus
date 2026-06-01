import { describe, it, expect } from "vitest";
import { TemplateMinerConfig } from "@/utils/drain/templateMinerConfig";

describe("TemplateMinerConfig", () => {
  describe("constructor", () => {
    it("applies default values when no options provided", () => {
      const config = new TemplateMinerConfig();
      expect(config.drainSimTh).toBe(0.4);
      expect(config.drainDepth).toBe(4);
      expect(config.drainMaxChildren).toBe(100);
      expect(config.drainMaxClusters).toBeNull();
      expect(config.drainExtraDelimiters).toEqual([]);
      expect(config.parametrizeNumericTokens).toBe(true);
      expect(config.snapshotIntervalMinutes).toBe(1);
      expect(config.snapshotCompressState).toBe(true);
    });

    it("applies default values with empty object", () => {
      const config = new TemplateMinerConfig({});
      expect(config.drainSimTh).toBe(0.4);
      expect(config.drainDepth).toBe(4);
    });

    it("overrides provided options", () => {
      const config = new TemplateMinerConfig({
        drainSimTh: 0.8,
        drainDepth: 6,
        drainMaxChildren: 50,
        drainMaxClusters: 200,
        drainExtraDelimiters: [":", "="],
        parametrizeNumericTokens: false,
        snapshotIntervalMinutes: 5,
        snapshotCompressState: false,
      });

      expect(config.drainSimTh).toBe(0.8);
      expect(config.drainDepth).toBe(6);
      expect(config.drainMaxChildren).toBe(50);
      expect(config.drainMaxClusters).toBe(200);
      expect(config.drainExtraDelimiters).toEqual([":", "="]);
      expect(config.parametrizeNumericTokens).toBe(false);
      expect(config.snapshotIntervalMinutes).toBe(5);
      expect(config.snapshotCompressState).toBe(false);
    });

    it("allows partial overrides", () => {
      const config = new TemplateMinerConfig({ drainDepth: 8 });
      expect(config.drainDepth).toBe(8);
      expect(config.drainSimTh).toBe(0.4);
    });

    it("accepts null for drainMaxClusters", () => {
      const config = new TemplateMinerConfig({ drainMaxClusters: null });
      expect(config.drainMaxClusters).toBeNull();
    });
  });

  describe("fromObject", () => {
    it("creates config from valid plain object", () => {
      const config = TemplateMinerConfig.fromObject({
        drainSimTh: 0.6,
        drainDepth: 3,
        drainMaxChildren: 80,
        drainMaxClusters: 500,
        drainExtraDelimiters: ["|"],
        parametrizeNumericTokens: false,
        snapshotIntervalMinutes: 10,
        snapshotCompressState: false,
      });

      expect(config.drainSimTh).toBe(0.6);
      expect(config.drainDepth).toBe(3);
      expect(config.drainMaxChildren).toBe(80);
      expect(config.drainMaxClusters).toBe(500);
      expect(config.drainExtraDelimiters).toEqual(["|"]);
      expect(config.parametrizeNumericTokens).toBe(false);
      expect(config.snapshotIntervalMinutes).toBe(10);
      expect(config.snapshotCompressState).toBe(false);
    });

    it("falls back to defaults for missing fields", () => {
      const config = TemplateMinerConfig.fromObject({});
      expect(config.drainSimTh).toBe(0.4);
      expect(config.drainDepth).toBe(4);
      expect(config.drainMaxChildren).toBe(100);
      expect(config.drainMaxClusters).toBeNull();
      expect(config.drainExtraDelimiters).toEqual([]);
      expect(config.parametrizeNumericTokens).toBe(true);
      expect(config.snapshotIntervalMinutes).toBe(1);
      expect(config.snapshotCompressState).toBe(true);
    });

    it("rejects invalid number values (NaN)", () => {
      const config = TemplateMinerConfig.fromObject({
        drainSimTh: NaN,
        drainDepth: Infinity,
        drainMaxChildren: "not a number",
      });

      expect(config.drainSimTh).toBe(0.4);
      expect(config.drainDepth).toBe(4);
      expect(config.drainMaxChildren).toBe(100);
    });

    it("handles null drainMaxClusters", () => {
      const config = TemplateMinerConfig.fromObject({
        drainMaxClusters: null,
      });
      expect(config.drainMaxClusters).toBeNull();
    });

    it("rejects non-array drainExtraDelimiters", () => {
      const config = TemplateMinerConfig.fromObject({
        drainExtraDelimiters: "not-an-array",
      });
      expect(config.drainExtraDelimiters).toEqual([]);
    });

    it("rejects array with non-string items", () => {
      const config = TemplateMinerConfig.fromObject({
        drainExtraDelimiters: [":", 123, true],
      });
      expect(config.drainExtraDelimiters).toEqual([]);
    });

    it("rejects non-boolean parametrizeNumericTokens", () => {
      const config = TemplateMinerConfig.fromObject({
        parametrizeNumericTokens: "yes",
      });
      expect(config.parametrizeNumericTokens).toBe(true);
    });

    it("rejects non-boolean snapshotCompressState", () => {
      const config = TemplateMinerConfig.fromObject({
        snapshotCompressState: 1,
      });
      expect(config.snapshotCompressState).toBe(true);
    });

    it("handles undefined values", () => {
      const config = TemplateMinerConfig.fromObject({
        drainSimTh: undefined,
        drainDepth: undefined,
      });
      expect(config.drainSimTh).toBe(0.4);
      expect(config.drainDepth).toBe(4);
    });
  });
});
