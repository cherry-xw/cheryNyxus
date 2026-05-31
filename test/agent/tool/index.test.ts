import { describe, it, expect, vi, beforeEach } from "vitest";
import { SupervisionLevel } from "@/core/config";
import { registerToolAdapter, toolAdapterRegistry } from "@/core/tool/adapter";
import { ToolManager } from "@/core/tool/toolManager";
import { tool } from "@/core/tool/toolCreator";
import { z } from "zod";

// Mock ToolAdapter
const mockToolAdapter = {
  buildTools: vi.fn((tools: any[]) => tools.map((t: any) => t.definition)),
  buildToolCallMessage: vi.fn((content: string, toolCalls: any[]) => ({ role: "assistant", content, toolCalls })),
  buildToolResponseMessage: vi.fn((id: string, result: string) => ({ role: "tool", toolCallId: id, content: result })),
  extractToolCalls: vi.fn(() => []),
  assembleToolCallChunks: vi.fn(() => []),
};

describe("Tool Index", () => {
  beforeEach(() => {
    toolAdapterRegistry.clear();
    registerToolAdapter("test-provider", mockToolAdapter as any);
  });

  describe("ToolManager integration", () => {
    it("should create ToolManager instance", () => {
      const manager = new ToolManager("test-provider");
      expect(manager).toBeDefined();
    });

    it("should add tools", () => {
      const manager = new ToolManager("test-provider");
      const testTool = tool(
        "test_tool",
        "Test tool",
        z.object({}),
        async () => ({ content: "result", hash: "" }),
        SupervisionLevel.auto,
      );

      manager.add([testTool]);
      expect(manager.getAll().length).toBe(1);
    });

    it("should get tool by name", () => {
      const manager = new ToolManager("test-provider");
      const testTool = tool(
        "get_test",
        "Get test",
        z.object({}),
        async () => ({ content: "", hash: "" }),
        SupervisionLevel.auto,
      );

      manager.add([testTool]);
      const result = manager.get("get_test");
      expect(result).toBe(testTool);
    });

    it("should return undefined for nonexistent tool", () => {
      const manager = new ToolManager("test-provider");
      const result = manager.get("nonexistent_tool");
      expect(result).toBeUndefined();
    });

    it("should execute tool", async () => {
      const manager = new ToolManager("test-provider");
      const testTool = tool(
        "exec_test",
        "Exec test",
        z.object({}),
        async () => ({ content: "execution result", hash: "test-hash" }),
        SupervisionLevel.auto,
      );

      manager.add([testTool]);
      const result = await manager.execute("exec_test", {}, new Map());
      expect(result.content).toBe("execution result");
      expect(result.hash).toBe("test-hash");
    });
  });

  describe("SupervisionLevel enum", () => {
    it("auto should be 0", () => {
      expect(SupervisionLevel.auto).toBe(0);
    });

    it("confirm should be 1", () => {
      expect(SupervisionLevel.confirm).toBe(1);
    });

    it("manual should be 2", () => {
      expect(SupervisionLevel.manual).toBe(2);
    });
  });
});