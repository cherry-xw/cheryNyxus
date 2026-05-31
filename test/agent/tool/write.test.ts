import { describe, it, expect, vi } from "vitest";
import writeTool from "@/agent/tool/write";
import { SupervisionLevel } from "@/core/config";

// Mock config - 使用正确的路径格式
vi.mock("@/utils/config", () => ({
  default: {},
}));

// Mock env
vi.mock("@/utils/env", () => ({
  getWorkDir: vi.fn(() => process.cwd()),
}));

// Mock hash generator
vi.mock("@/utils/hash", () => ({
  hashGenerator: vi.fn(() => "test-hash"),
}));

describe("Write Tool", () => {
  describe("tool definition", () => {
    it("should have correct name", () => {
      expect(writeTool.definition.function.name).toBe("write_file");
    });

    it("should have correct supervision level", () => {
      expect(writeTool.supervisionLevel).toBe(SupervisionLevel.manual);
    });

    it("should have valid schema", () => {
      expect(writeTool.definition.function.parameters).toBeDefined();
    });

    it("should have description", () => {
      expect(writeTool.definition.function.description).toBeDefined();
    });
  });
});