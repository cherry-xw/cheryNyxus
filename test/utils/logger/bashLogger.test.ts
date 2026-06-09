import { describe, it, expect, vi, beforeEach } from "vitest";
import { logger } from "@/utils/logger/index.js";

vi.mock("@/utils/logger/index.js", () => ({
  initLogger: vi.fn(),
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    write: vi.fn(),
    close: vi.fn(),
    getConfig: vi.fn(),
    setConfig: vi.fn(),
    tools: {
      createBashLogPath: vi.fn((_pid: number, startTime: number) =>
        `/tmp/cheryClaw-bash-logs/${startTime}-12345.log`),
      formatBashLogHeader: vi.fn((info: { pid: number; command: string; status: string }) =>
        `---\nPID: ${info.pid}\nCommand: ${info.command}\nStatus: ${info.status}\n---\n`),
      cleanOldBashLogs: vi.fn(),
      getBashLogDir: vi.fn(() => "/tmp/cheryClaw-bash-logs"),
      getLogDirectory: vi.fn((name: string) => `/tmp/${name}`),
      createLogFilePath: vi.fn((dir: string, file: string) => `/tmp/${dir}/${file}`),
      getLogSize: vi.fn(() => 0),
      shouldShowPartialLog: vi.fn(() => false),
      getLogSizeThreshold: vi.fn(() => 10240),
      formatLogSize: vi.fn((b: number) => `${b}B`),
      createLogStream: vi.fn(),
      cleanOldLogFiles: vi.fn(),
    },
  },
}));

const tools = logger.tools;

describe("bashLogger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should create bash log path with pid and timestamp", () => {
    const path = tools.createBashLogPath(12345, 1000000);
    expect(path).toContain("1000000-12345.log");
  });

  it("should format log header with required fields", () => {
    const header = tools.formatBashLogHeader({
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

  it("should include description in header when provided", () => {
    const header = tools.formatBashLogHeader({
      pid: 12345,
      command: "ls",
      startTime: Date.now(),
      logPath: "/tmp/test.log",
      status: "running",
      description: "list files",
    });
    expect(header).toContain("Description: list files");
  });

  it("should expose all tools functions", () => {
    expect(tools.createLogStream).toBeDefined();
    expect(tools.formatLogSize).toBeDefined();
    expect(tools.getLogSize).toBeDefined();
    expect(tools.getLogSizeThreshold).toBeDefined();
    expect(tools.shouldShowPartialLog).toBeDefined();
  });
});
