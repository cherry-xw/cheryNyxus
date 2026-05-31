import { describe, it, expect, beforeEach } from "vitest";
import {
  toolAdapterRegistry,
  registerToolAdapter,
  getToolAdapter,
  type ToolAdapter,
  type ToolCallData,
  type ToolFunction,
} from "@/core/tool/adapter";
import type { Tool, ToolResult, ToolSharedData } from "@/core/tool/toolCreator";
import { z, type ZodType } from "zod";

// Mock ToolAdapter
const mockAdapter: ToolAdapter<unknown, unknown> = {
  buildTools: (tools: Tool<ZodType>[]) => tools.map((t) => t.definition),
  buildToolCallMessage: (content: string, toolCalls: ToolCallData[]) => ({
    role: "assistant",
    content,
    toolCalls,
  }),
  buildToolResponseMessage: (id: string, result: string) => ({
    role: "tool",
    toolCallId: id,
    content: result,
  }),
  extractToolCalls: () => [],
  assembleToolCallChunks: () => [],
};

describe("Tool Adapter Registry", () => {
  beforeEach(() => {
    // Clear registry before each test
    toolAdapterRegistry.clear();
  });

  describe("registerToolAdapter", () => {
    it("registers adapter for provider", () => {
      registerToolAdapter("test-provider", mockAdapter);

      expect(toolAdapterRegistry.has("test-provider")).toBe(true);
      expect(toolAdapterRegistry.get("test-provider")).toBe(mockAdapter);
    });

    it("allows multiple providers", () => {
      registerToolAdapter("provider-a", mockAdapter);
      registerToolAdapter("provider-b", mockAdapter);

      expect(toolAdapterRegistry.size).toBe(2);
    });

    it("overwrites existing adapter", () => {
      registerToolAdapter("provider", mockAdapter);

      const newAdapter: ToolAdapter<unknown, unknown> = {
        ...mockAdapter,
        buildTools: () => [],
      };
      registerToolAdapter("provider", newAdapter);

      expect(toolAdapterRegistry.get("provider")).toBe(newAdapter);
    });
  });

  describe("getToolAdapter", () => {
    it("returns registered adapter", () => {
      registerToolAdapter("provider", mockAdapter);

      const retrieved = getToolAdapter("provider");
      expect(retrieved).toBe(mockAdapter);
    });

    it("returns undefined for unregistered provider", () => {
      const retrieved = getToolAdapter("unknown-provider");
      expect(retrieved).toBeUndefined();
    });
  });

  describe("ToolAdapter interface", () => {
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

    it("buildToolCallMessage creates assistant message", () => {
      const toolCalls: ToolCallData[] = [
        { tid: "call-1", name: "test", arguments: "{}" },
      ];

      const message = mockAdapter.buildToolCallMessage("content", toolCalls);
      expect(message).toHaveProperty("role", "assistant");
      expect(message).toHaveProperty("content", "content");
    });

    it("buildToolResponseMessage creates tool message", () => {
      const message = mockAdapter.buildToolResponseMessage("id-1", "result");
      expect(message).toHaveProperty("role", "tool");
      expect(message).toHaveProperty("toolCallId", "id-1");
    });

    it("extractToolCalls returns array", () => {
      const calls = mockAdapter.extractToolCalls({});
      expect(Array.isArray(calls)).toBe(true);
    });

    it("assembleToolCallChunks returns result", () => {
      const result = mockAdapter.assembleToolCallChunks([]);
      expect(result).toBeDefined();
    });
  });
});