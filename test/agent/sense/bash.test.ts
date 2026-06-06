import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from "vitest";
import bashTool from "@/agent/sense/bash";
import { SupervisionLevel } from "@/core/config";
import type { ToolSharedData } from "@/core/sense";

// Mock with correct import path
vi.mock("@/utils/bashLogger.js", () => ({
  createBashLogPath: vi.fn(() => "/tmp/test-log.log"),
  formatBashLogHeader: vi.fn(() => "Header"),
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
    let createBashLogPath: ReturnType<typeof vi.fn>;

    beforeAll(async () => {
      const mod = await import("@/utils/bashLogger.js");
      cleanOldBashLogs = vi.mocked(mod.cleanOldBashLogs);
      createBashLogPath = vi.mocked(mod.createBashLogPath);
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

    it("should handle timeout and create log file", async () => {
      // Use a command that sleeps longer than the timeout
      // The mock returns 30000ms timeout, but actual config is used
      // We need to test with a command that will actually timeout
      vi.useFakeTimers();

      const executePromise = bashTool.executor.execute(
        { command: "sleep 100", description: "test timeout" },
        sharedData,
      );

      // Advance timers past the timeout (30000ms)
      await vi.advanceTimersByTimeAsync(35000);

      const result = await executePromise;

      expect(result.content).toContain("状态: timeout");
      expect(result.content).toContain("日志路径:");
      expect(result.content).toContain("说明: 进程进入后台运行");
      expect(result.content).not.toContain("退出码:");
      expect(createBashLogPath).toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("should include log path in output for timeout", async () => {
      vi.useFakeTimers();
      createBashLogPath.mockReturnValue("/tmp/custom-timeout.log");

      const executePromise = bashTool.executor.execute(
        { command: "sleep 100", description: "timeout with log" },
        sharedData,
      );

      await vi.advanceTimersByTimeAsync(35000);

      const result = await executePromise;

      expect(result.content).toContain("/tmp/custom-timeout.log");
      expect(result.content).toContain("read_file");

      vi.useRealTimers();
    });

    it("should handle exit code undefined (signal kill)", async () => {
      // Commands killed by signal may have null exit code
      const result = await bashTool.executor.execute(
        { command: "sh -c 'kill -9 $$'", description: "signal kill" },
        sharedData,
      );

      // Exit code may be undefined or non-zero
      expect(result.content).toContain("状态:");
      // Should not crash, no exit code line if undefined
    });

    it("should handle command that exits quickly", async () => {
      const result = await bashTool.executor.execute(
        { command: "true", description: "quick success" },
        sharedData,
      );

      expect(result.content).toContain("状态: success");
      expect(result.content).toContain("退出码: 0");
    });
  });
});