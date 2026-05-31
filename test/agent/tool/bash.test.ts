import { describe, it, expect, vi } from "vitest";
import bashTool from "@/agent/tool/bash";
import { SupervisionLevel } from "@/core/config";

// Mock config - 使用正确的路径格式
vi.mock("@/utils/config", () => ({
  default: {
    global: {
      tool_execute_timeout: 30000,
      bash_log_retention_hours: 24,
    },
  },
}));

// Mock env
vi.mock("@/utils/env", () => ({
  getWorkDir: vi.fn(() => process.cwd()),
}));

// Mock bashLogger
vi.mock("@/utils/bashLogger", () => ({
  createLogFile: vi.fn(() => "/tmp/test-log.log"),
  createLogStream: vi.fn(() => ({
    write: vi.fn(),
    end: vi.fn(),
  })),
  formatLogHeader: vi.fn(() => "Header"),
  getLogSize: vi.fn(() => 1024),
  shouldShowPartialLog: vi.fn(() => false),
  getLogSizeThreshold: vi.fn(() => 10240),
  formatLogSize: vi.fn((size: number) => `${size}B`),
  cleanOldLogs: vi.fn(),
}));

describe("Bash Tool", () => {
  describe("tool definition", () => {
    it("should have correct name", () => {
      expect(bashTool.definition.function.name).toBe("execute_command");
    });

    it("should have correct supervision level", () => {
      expect(bashTool.supervisionLevel).toBe(SupervisionLevel.manual);
    });

    it("should have valid schema", () => {
      expect(bashTool.definition.function.parameters).toBeDefined();
    });
  });

  describe("tool description", () => {
    it("should have description", () => {
      expect(bashTool.definition.function.description).toBeDefined();
    });
  });
});