import { describe, it, expect, beforeEach } from "vitest";
import {
  senseAdapterRegistry,
  registerSenseAdapter,
  getSenseAdapter,
  type SenseAdapter,
  type SenseCallData,
  type SenseFunction,
} from "@/core/sense/adapter";
import type { Sense, SenseResult, SenseSharedData } from "@/core/sense/senseCreator";
import { z, type ZodType } from "zod";

// Mock SenseAdapter
const mockAdapter: SenseAdapter<unknown, unknown> = {
  buildSenses: (senses: Sense<ZodType>[]) => senses.map((s) => s.definition),
  buildSenseCallMessage: (content: string, senseCalls: SenseCallData[]) => ({
    role: "assistant",
    content,
    senseCalls,
  }),
  buildSenseResponseMessage: (id: string, result: string) => ({
    role: "tool",
    toolCallId: id,
    content: result,
  }),
  senseCalls: () => [],
  extractSenseCallDeltas: () => [],
};

describe("Sense Adapter Registry", () => {
  beforeEach(() => {
    // Clear registry before each test
    senseAdapterRegistry.clear();
  });

  describe("registerSenseAdapter", () => {
    it("registers adapter for provider", () => {
      registerSenseAdapter("test-provider", mockAdapter);

      expect(senseAdapterRegistry.has("test-provider")).toBe(true);
      expect(senseAdapterRegistry.get("test-provider")).toBe(mockAdapter);
    });

    it("allows multiple providers", () => {
      registerSenseAdapter("provider-a", mockAdapter);
      registerSenseAdapter("provider-b", mockAdapter);

      expect(senseAdapterRegistry.size).toBe(2);
    });

    it("overwrites existing adapter", () => {
      registerSenseAdapter("provider", mockAdapter);

      const newAdapter: SenseAdapter<unknown, unknown> = {
        ...mockAdapter,
        buildSenses: () => [],
      };
      registerSenseAdapter("provider", newAdapter);

      expect(senseAdapterRegistry.get("provider")).toBe(newAdapter);
    });
  });

  describe("getSenseAdapter", () => {
    it("returns registered adapter", () => {
      registerSenseAdapter("provider", mockAdapter);

      const retrieved = getSenseAdapter("provider");
      expect(retrieved).toBe(mockAdapter);
    });

    it("returns undefined for unregistered provider", () => {
      const retrieved = getSenseAdapter("unknown-provider");
      expect(retrieved).toBeUndefined();
    });
  });

  describe("SenseAdapter interface", () => {
    it("buildSenses returns SenseFunction array", () => {
      const senseDefinition: SenseFunction = {
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

      const mockSense: Sense<ZodType> = {
        definition: senseDefinition,
        executor: {
          schema: z.object({}),
          execute: async (): Promise<SenseResult> => ({ content: "", hash: "" }),
        },
        supervisionLevel: 1,
      };

      const senses = mockAdapter.buildSenses([mockSense]);
      expect(Array.isArray(senses)).toBe(true);
      expect(senses[0]).toBe(senseDefinition);
    });

    it("buildSenseCallMessage creates assistant message", () => {
      const senseCalls: SenseCallData[] = [
        { id: "call-1", name: "test", arguments: "{}" },
      ];

      const message = mockAdapter.buildSenseCallMessage("content", senseCalls);
      expect(message).toHaveProperty("role", "assistant");
      expect(message).toHaveProperty("content", "content");
    });

    it("buildSenseResponseMessage creates tool message", () => {
      const message = mockAdapter.buildSenseResponseMessage("id-1", "result");
      expect(message).toHaveProperty("role", "tool");
      expect(message).toHaveProperty("toolCallId", "id-1");
    });

    it("senseCalls returns array", () => {
      const calls = mockAdapter.senseCalls({});
      expect(Array.isArray(calls)).toBe(true);
    });

    it("extractSenseCallDeltas returns result", () => {
      const result = mockAdapter.extractSenseCallDeltas({});
      expect(result).toBeDefined();
    });
  });
});