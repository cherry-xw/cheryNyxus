import { describe, it, expect, beforeEach } from "vitest";
import {
  senseAdapterRegistry,
  registerSenseAdapter,
  getSenseAdapter,
  type SenseAdapter,
  type SenseCallData,
  type ToolFunction,
} from "@/core/sense/adapter";
import type { Tool, ToolResult, ToolSharedData } from "@/core/sense/senseCreator";
import { z, type ZodType } from "zod";

// Mock SenseAdapter
const mockAdapter: SenseAdapter<unknown, unknown> = {
  buildTools: (senses: Tool<ZodType>[]) => tools.map((t) => t.definition),
  buildSenseCallMessage: (content: string, senseCalls: SenseCallData[]) => ({
    role: "assistant",
    content,
    senseCalls,
  }),
  buildToolResponseMessage: (id: string, result: string) => ({
    role: "tool",
    toolCallId: id,
    content: result,
  }),
  extractSenseCalls: () => [],
  assembleSenseCallChunks: () => [],
};

describe("Tool Adapter Registry", () => {
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
        buildTools: () => [],
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
    it("buildTools returns ToolFunction array", () => {
      const toolDefinition: ToolFunction = {
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

      const mockTool: Tool<ZodType> = {
        definition: toolDefinition,
        executor: {
          schema: z.object({}),
          execute: async (): Promise<ToolResult> => ({ content: "", hash: "" }),
        },
        supervisionLevel: 1,
      };

      const tools = mockAdapter.buildTools([mockTool]);
      expect(Array.isArray(tools)).toBe(true);
      expect(tools[0]).toBe(toolDefinition);
    });

    it("buildSenseCallMessage creates assistant message", () => {
      const senseCalls: SenseCallData[] = [
        { tid: "call-1", name: "test", arguments: "{}" },
      ];

      const message = mockAdapter.buildSenseCallMessage("content", senseCalls);
      expect(message).toHaveProperty("role", "assistant");
      expect(message).toHaveProperty("content", "content");
    });

    it("buildToolResponseMessage creates tool message", () => {
      const message = mockAdapter.buildToolResponseMessage("id-1", "result");
      expect(message).toHaveProperty("role", "tool");
      expect(message).toHaveProperty("toolCallId", "id-1");
    });

    it("extractSenseCalls returns array", () => {
      const calls = mockAdapter.extractSenseCalls({});
      expect(Array.isArray(calls)).toBe(true);
    });

    it("assembleSenseCallChunks returns result", () => {
      const result = mockAdapter.assembleSenseCallChunks([]);
      expect(result).toBeDefined();
    });
  });
});