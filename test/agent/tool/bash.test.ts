import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import bashTool from "@/agent/tool/bash";
import { SupervisionLevel } from "@/core/config";
import type { ToolSharedData } from "@/core/tool";

vi.mock("@/utils/config", () => ({
  default: {
    global: {
      tool_execute_timeout: 30000,
      bash_log_retention_hours: 24,
    },
  },
}));

vi.mock("@/utils/logger/bashLogger", () => ({
  createBashLogPath: vi.fn(() => "/tmp/test-log.log"),
  createLogStream: vi.fn(() => ({
    write: vi.fn(),
    end: vi.fn(),
  })),
  formatBashLogHeader: vi.fn(() => "Header"),
  getLogSize: vi.fn(() => 1024),
  shouldShowPartialLog: vi.fn(() => false),
  getLogSizeThreshold: vi.fn(() => 10240),
  formatLogSize: vi.fn((size: number) => `${size}B`),
  cleanOldBashLogs: vi.fn(),
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

    it("should have description", () => {
      expect(bashTool.definition.function.description).toBeDefined();
    });
  });

  describe("executor", () => {
    const sharedData: ToolSharedData = new Map();
    let cleanOldBashLogs: ReturnType<typeof vi.fn>;

    beforeAll(async () => {
      const mod = await import("@/utils/logger/bashLogger");
      cleanOldBashLogs = vi.mocked(mod.cleanOldBashLogs);
    });

    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("should execute command successfully (exit code 0)", async () => {
      const result = await bashTool.executor.execute(
        { command: "echo hello", description: "test echo" },
        sharedData,
      );

      expect(result.content).toContain("状态: success");
      expect(result.content).toContain("退出码: 0");
      expect(result.content).toContain("hello");
      expect(result.hash).toBe("");
      expect(cleanOldBashLogs).toHaveBeenCalledWith(24);
    });

    it("should handle command failure (non-zero exit code)", async () => {
      const result = await bashTool.executor.execute(
        { command: "exit 1", description: "test failure" },
        sharedData,
      );

      expect(result.content).toContain("状态: error");
      expect(result.content).toContain("退出码: 1");
    });

    it("should capture both stdout and stderr", async () => {
      const result = await bashTool.executor.execute(
        { command: "echo out && echo err >&2", description: "test output" },
        sharedData,
      );

      expect(result.content).toContain("out");
      expect(result.content).toContain("err");
    });

    it("should include duration in output", async () => {
      const result = await bashTool.executor.execute(
        { command: "echo test", description: "test duration" },
        sharedData,
      );

      expect(result.content).toContain("执行时长:");
      expect(result.content).toContain("ms");
    });

    it("should include process ID in output", async () => {
      const result = await bashTool.executor.execute(
        { command: "echo test", description: "test pid" },
        sharedData,
      );

      expect(result.content).toContain("进程ID:");
    });

    it("should handle spawn error", async () => {
      const result = await bashTool.executor.execute(
        { command: "nonexistent_command_xyz_12345", description: "test error" },
        sharedData,
      );

      expect(result.content).toContain("状态: error");
    });

    it("should call cleanOldBashLogs before execution", async () => {
      await bashTool.executor.execute(
        { command: "echo test", description: "test clean" },
        sharedData,
      );

      expect(cleanOldBashLogs).toHaveBeenCalledTimes(1);
    });

    it("should truncate long output (>30 lines)", async () => {
      const result = await bashTool.executor.execute(
        { command: "seq 50", description: "test long output" },
        sharedData,
      );

      expect(result.content).toContain("省略");
    });

    it("should not truncate short output (<=30 lines)", async () => {
      const result = await bashTool.executor.execute(
        { command: "seq 10", description: "test short output" },
        sharedData,
      );

      expect(result.content).not.toContain("省略");
    });
  });
});
