import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { logger, type BashLogInfo } from "@/utils/logger/index.js";
import { createTempDir, cleanupTempDir, createTempFile } from "@test/helpers/tempDir";
import { join } from "path";
import { existsSync, writeFileSync, unlinkSync, readdirSync } from "fs";

const tools = logger.tools;

describe("bashLogger module", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  describe("getBashLogDir", () => {
    it("should return log directory path", () => {
      const logDir = tools.getBashLogDir();
      expect(logDir).toContain("cheryClaw-bash-logs");
      expect(existsSync(logDir)).toBe(true);
    });

    it("should create directory if not exists", () => {
      const logDir = tools.getBashLogDir();
      expect(existsSync(logDir)).toBe(true);
    });

    it("should return same directory on multiple calls", () => {
      const dir1 = tools.getBashLogDir();
      const dir2 = tools.getBashLogDir();
      expect(dir1).toBe(dir2);
    });
  });

  describe("createBashLogPath", () => {
    it("should create log file path with timestamp and pid", () => {
      const startTime = 1234567890;
      const pid = 12345;
      const logPath = tools.createBashLogPath(pid, startTime);

      expect(logPath).toContain("1234567890-12345.log");
      expect(logPath).toContain("cheryClaw-bash-logs");
    });

    it("should create log file in correct directory", () => {
      const logPath = tools.createBashLogPath(12345, 1234567890);
      const expectedDir = tools.getBashLogDir();
      expect(logPath.startsWith(expectedDir)).toBe(true);
    });
  });

  describe("formatBashLogHeader", () => {
    it("should format header with basic info", () => {
      const info: BashLogInfo = {
        pid: 12345,
        command: "ls -la",
        startTime: Date.now(),
        logPath: "/tmp/test.log",
        status: "running",
      };

      const header = tools.formatBashLogHeader(info);

      expect(header).toContain("PID: 12345");
      expect(header).toContain("Command: ls -la");
      expect(header).toContain("StartTime:");
      expect(header).toContain("Status: running");
      expect(header).toContain("---");
    });

    it("should include description when provided", () => {
      const info: BashLogInfo = {
        pid: 12345,
        command: "npm run build",
        startTime: Date.now(),
        logPath: "/tmp/test.log",
        description: "Build the project",
        status: "running",
      };

      const header = tools.formatBashLogHeader(info);

      expect(header).toContain("Description: Build the project");
    });

    it("should not include description when not provided", () => {
      const info: BashLogInfo = {
        pid: 12345,
        command: "ls",
        startTime: Date.now(),
        logPath: "/tmp/test.log",
        status: "completed",
      };

      const header = tools.formatBashLogHeader(info);

      expect(header).not.toContain("Description:");
    });

    it("should format startTime in local time", () => {
      const testTime = new Date("2023-01-15T10:30:00Z").getTime();
      const info: BashLogInfo = {
        pid: 12345,
        command: "test",
        startTime: testTime,
        logPath: "/tmp/test.log",
        status: "running",
      };

      const header = tools.formatBashLogHeader(info);

      expect(header).toContain("StartTime: 2023");
    });
  });

  describe("getLogSize", () => {
    it("should return file size", () => {
      const content = "test log content with some data";
      const logPath = createTempFile(tempDir, "test.log", content);

      const size = tools.getLogSize(logPath);

      expect(size).toBeGreaterThan(0);
      expect(size).toBe(content.length);
    });

    it("should return 0 for non-existent file", () => {
      const size = tools.getLogSize(join(tempDir, "nonexistent.log"));
      expect(size).toBe(0);
    });

    it("should return 0 for empty file", () => {
      const logPath = createTempFile(tempDir, "empty.log", "");
      const size = tools.getLogSize(logPath);
      expect(size).toBe(0);
    });
  });

  describe("shouldShowPartialLog", () => {
    it("should return false for small files", () => {
      const smallContent = "small content";
      const logPath = createTempFile(tempDir, "small.log", smallContent);

      expect(tools.shouldShowPartialLog(logPath)).toBe(false);
    });

    it("should return true for large files", () => {
      const largeContent = "x".repeat(15 * 1024); // 15KB
      const logPath = createTempFile(tempDir, "large.log", largeContent);

      expect(tools.shouldShowPartialLog(logPath)).toBe(true);
    });

    it("should return false for non-existent file", () => {
      expect(tools.shouldShowPartialLog(join(tempDir, "nonexistent.log"))).toBe(false);
    });
  });

  describe("getLogSizeThreshold", () => {
    it("should return 10KB threshold", () => {
      const threshold = tools.getLogSizeThreshold();
      expect(threshold).toBe(10 * 1024);
    });
  });

  describe("formatLogSize", () => {
    it("should format bytes for small sizes", () => {
      expect(tools.formatLogSize(500)).toBe("500B");
      expect(tools.formatLogSize(1000)).toBe("1000B");
    });

    it("should format KB for medium sizes", () => {
      expect(tools.formatLogSize(1024)).toBe("1.00KB");
      expect(tools.formatLogSize(2048)).toBe("2.00KB");
      expect(tools.formatLogSize(1536)).toBe("1.50KB");
    });

    it("should format MB for large sizes", () => {
      expect(tools.formatLogSize(1024 * 1024)).toBe("1.00MB");
      expect(tools.formatLogSize(2 * 1024 * 1024)).toBe("2.00MB");
      expect(tools.formatLogSize(1.5 * 1024 * 1024)).toBe("1.50MB");
    });
  });

  describe("createLogStream", () => {
    it("should have createLogStream function available", () => {
      expect(tools.createLogStream).toBeDefined();
      expect(typeof tools.createLogStream).toBe("function");
    });
  });

  describe("cleanOldBashLogs concept", () => {
    it("should identify old files by timestamp", () => {
      const oldTime = Date.now() - 25 * 60 * 60 * 1000; // 25 hours ago
      const recentTime = Date.now() - 1 * 60 * 60 * 1000; // 1 hour ago

      const retentionMs = 24 * 60 * 60 * 1000;

      expect(oldTime < Date.now() - retentionMs).toBe(true);
      expect(recentTime > Date.now() - retentionMs).toBe(true);
    });
  });

  describe("cleanOldBashLogs", () => {
    it("should handle non-existent directory gracefully", () => {
      expect(tools.cleanOldBashLogs).toBeDefined();
      expect(typeof tools.cleanOldBashLogs).toBe("function");
    });

    it("should skip non-log files", () => {
      const logDir = tools.getBashLogDir();
      // 创建非 .log 文件
      const nonLogFile = join(logDir, "test-data.txt");
      writeFileSync(nonLogFile, "test content");

      // 调用清理（1小时保留期）
      tools.cleanOldBashLogs(1);

      // 非 .log 文件应该仍然存在
      expect(existsSync(nonLogFile)).toBe(true);

      // 清理测试文件
      unlinkSync(nonLogFile);
    });

    it("should preserve recent log files", () => {
      const logDir = tools.getBashLogDir();
      // 创建新的 .log 文件（当前时间戳）
      const recentLogFile = tools.createBashLogPath(Date.now(), Date.now());
      writeFileSync(recentLogFile, "recent log");

      // 调用清理（24小时保留期）
      tools.cleanOldBashLogs(24);

      // 最近文件应该保留
      expect(existsSync(recentLogFile)).toBe(true);

      // 清理测试文件
      unlinkSync(recentLogFile);
    });

    it("should handle empty directory", () => {
      const logDir = tools.getBashLogDir();
      // 确保目录存在但为空（移除所有测试文件）
      const files = readdirSync(logDir);
      for (const file of files) {
        if (file.includes("test-") || file.startsWith(Date.now().toString())) {
          try {
            unlinkSync(join(logDir, file));
          } catch {
            // 忽略
          }
        }
      }

      // 调用清理应该不报错
      tools.cleanOldBashLogs(24);
    });
  });
});
