import { describe, it, expect, beforeEach } from "vitest";
import {
  senseAdapterRegistry,
  registerSenseAdapter,
  getSenseAdapter,
  type SenseAdapter,
  type SenseCallData,
  type SenseFunction,
} from "@/core/sense/adapter";
import type { Sense, SenseResult } from "@/core/sense/senseCreator";
import { z, type ZodType } from "zod";

const mockAdapter: SenseAdapter<unknown> = {
  buildSenses: (senses) => senses.map((s) => s.definition),
  senseCalls: () => [],
  extractSenseCallDeltas: () => [],
};

describe("Sense Adapter Registry", () => {
  beforeEach(() => {
    senseAdapterRegistry.clear();
  });

  describe("registerSenseAdapter", () => {
    it("registers adapter for provider", () => {
      registerSenseAdapter("test-provider", mockAdapter);
      expect(senseAdapterRegistry.has("test-provider")).toBe(true);
      expect(getSenseAdapter("test-provider")).toBe(mockAdapter);
    });

    it("allows multiple providers", () => {
      registerSenseAdapter("provider-a", mockAdapter);
      registerSenseAdapter("provider-b", mockAdapter);
      expect(senseAdapterRegistry.size).toBe(2);
    });

    it("overwrites existing adapter", () => {
      registerSenseAdapter("provider", mockAdapter);
      const next: SenseAdapter<unknown> = {
        ...mockAdapter,
        buildSenses: () => [],
      };
      registerSenseAdapter("provider", next);
      expect(getSenseAdapter("provider")).toBe(next);
    });
  });

  describe("getSenseAdapter", () => {
    it("returns registered adapter", () => {
      registerSenseAdapter("provider", mockAdapter);
      expect(getSenseAdapter("provider")).toBe(mockAdapter);
    });

    it("returns undefined for unregistered provider", () => {
      expect(getSenseAdapter("unknown-provider")).toBeUndefined();
    });
  });

  describe("SenseAdapter interface (3 methods)", () => {
    it("buildSenses returns SenseFunction[] from Sense[]", () => {
      const def: SenseFunction = {
        type: "function",
        function: {
          name: "test",
          description: "test",
          parameters: {
            type: "object",
            properties: {},
            required: [],
            additionalProperties: false,
          },
        },
      };
      const s: Sense<ZodType> = {
        definition: def,
        executor: {
          schema: z.object({}),
          execute: async (): Promise<SenseResult> => ({ content: "", hash: "" }),
        },
        supervisionLevel: 1,
      };

      const out = mockAdapter.buildSenses([s]);
      expect(Array.isArray(out)).toBe(true);
      expect(out[0]).toBe(def);
    });

    it("senseCalls returns array", () => {
      const calls = mockAdapter.senseCalls({});
      expect(Array.isArray(calls)).toBe(true);
    });

    it("extractSenseCallDeltas returns array", () => {
      const out = mockAdapter.extractSenseCallDeltas({});
      expect(Array.isArray(out)).toBe(true);
    });

    it("SenseCallData requires id, optional index/name", () => {
      const data: SenseCallData = { id: "call-1", arguments: "{}" };
      expect(data.id).toBe("call-1");
      expect(data.arguments).toBe("{}");
    });
  });
});
