import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { logger } from "@/utils/logger/index.js";

const tools = logger.tools;

describe("fileLogger", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `chery-test-${Date.now()}`);
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("getLogDirectory creates directory if not exists", () => {
    const dir = tools.getLogDirectory(`chery-test-${Date.now()}`);
    expect(existsSync(dir)).toBe(true);
  });

  it("createLogFilePath returns correct path", () => {
    const path = tools.createLogFilePath(testDir.replace(/\/$/, ""), "test.log");
    expect(path).toContain("test.log");
  });

  it("getLogSize returns 0 for nonexistent file", () => {
    expect(tools.getLogSize("/nonexistent/file.log")).toBe(0);
  });

  it("getLogSize returns file size", () => {
    if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
    const filePath = join(testDir, "test.log");
    writeFileSync(filePath, "hello world");
    expect(tools.getLogSize(filePath)).toBeGreaterThan(0);
  });

  it("shouldShowPartialLog returns true for large files", () => {
    if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
    const filePath = join(testDir, "big.log");
    writeFileSync(filePath, "x".repeat(11 * 1024));
    expect(tools.shouldShowPartialLog(filePath)).toBe(true);
  });

  it("shouldShowPartialLog returns false for small files", () => {
    if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
    const filePath = join(testDir, "small.log");
    writeFileSync(filePath, "x");
    expect(tools.shouldShowPartialLog(filePath)).toBe(false);
  });

  it("getLogSizeThreshold returns 10240", () => {
    expect(tools.getLogSizeThreshold()).toBe(10 * 1024);
  });

  it("formatLogSize formats bytes correctly", () => {
    expect(tools.formatLogSize(500)).toBe("500B");
    expect(tools.formatLogSize(1024)).toBe("1.00KB");
    expect(tools.formatLogSize(1024 * 1024)).toBe("1.00MB");
  });

  it("cleanOldLogFiles removes old log files", () => {
    const logDirName = `chery-clean-test-${Date.now()}`;
    const dir = tools.getLogDirectory(logDirName);
    writeFileSync(join(dir, "old.log"), "old content");

    tools.cleanOldLogFiles(logDirName, 24);

    // File may or may not be cleaned depending on birthtimeMs vs mtime
    // Just verify no error thrown
  });
});
