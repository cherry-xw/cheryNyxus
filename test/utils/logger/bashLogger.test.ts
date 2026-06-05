import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/utils/logger/fileLogger.js", () => ({
  getLogDirectory: vi.fn((name: string) => `/tmp/${name}`),
  createLogFilePath: vi.fn((dir: string, file: string) => `/tmp/${dir}/${file}`),
  createLogStream: vi.fn(),
  formatLogSize: vi.fn((bytes: number) => `${bytes}B`),
  getLogSize: vi.fn(() => 0),
  getLogSizeThreshold: vi.fn(() => 10240),
  shouldShowPartialLog: vi.fn(() => false),
  cleanOldLogFiles: vi.fn(),
}));

describe("bashLogger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should create bash log path with pid and timestamp", async () => {
    const { createBashLogPath } = await import("@/utils/logger/bashLogger.js");
    const path = createBashLogPath(12345, 1000000);
    expect(path).toContain("1000000-12345.log");
  });

  it("should format log header with required fields", async () => {
    const { formatBashLogHeader } = await import("@/utils/logger/bashLogger.js");
    const header = formatBashLogHeader({
      pid: 12345,
      command: "ls -la",
      startTime: Date.now(),
      logPath: "/tmp/test.log",
      status: "running",
    });
    expect(header).toContain("PID: 12345");
    expect(header).toContain("Command: ls -la");
    expect(header).toContain("Status: running");
  });

  it("should include description in header when provided", async () => {
    const { formatBashLogHeader } = await import("@/utils/logger/bashLogger.js");
    const header = formatBashLogHeader({
      pid: 12345,
      command: "ls",
      startTime: Date.now(),
      logPath: "/tmp/test.log",
      status: "running",
      description: "list files",
    });
    expect(header).toContain("Description: list files");
  });

  it("should re-export fileLogger functions", async () => {
    const mod = await import("@/utils/logger/bashLogger.js");
    expect(mod.createLogStream).toBeDefined();
    expect(mod.formatLogSize).toBeDefined();
    expect(mod.getLogSize).toBeDefined();
    expect(mod.getLogSizeThreshold).toBeDefined();
    expect(mod.shouldShowPartialLog).toBeDefined();
  });
});
