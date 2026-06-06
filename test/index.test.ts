import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockWss = { close: vi.fn() };
const mockCloseDb = vi.fn();

vi.mock("@/service/index.js", () => ({
  startService: vi.fn(() => mockWss),
}));

vi.mock("@/db/index.js", () => ({
  closeDb: mockCloseDb,
}));

vi.mock("@/core/sense/compiler/index.js", () => ({
  compileSenses: vi.fn(),
  parseTestCases: vi.fn(),
}));

vi.mock("@/agent/sense/compileToolsReporter.js", () => ({
  runSenseTestsAndCollect: vi.fn(),
  reportSenseCompileResult: vi.fn(),
}));

describe("index.ts entry point", () => {
  const originalArgv = process.argv;
  const originalEnv = process.env;
  const originalExit = process.exit;
  const originalExitCode = Object.getOwnPropertyDescriptor(process, "exitCode");

  beforeEach(() => {
    vi.clearAllMocks();
    process.argv = [...originalArgv];
    mockWss.close.mockClear();
    mockCloseDb.mockClear();
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exit = originalExit;
    if (originalExitCode) {
      Object.defineProperty(process, "exitCode", originalExitCode);
    }
  });

  it("should start service with default port 8080", async () => {
    delete process.env.WS_PORT;
    process.argv = ["node", "index.js"];

    vi.resetModules();
    await import("@/index.js");
    const { startService } = await import("@/service/index.js");

    expect(startService).toHaveBeenCalledWith(8080);
  });

  it("should start service with custom WS_PORT", async () => {
    process.env.WS_PORT = "9090";
    process.argv = ["node", "index.js"];

    vi.resetModules();
    await import("@/index.js");
    const { startService } = await import("@/service/index.js");

    expect(startService).toHaveBeenCalledWith(9090);
    delete process.env.WS_PORT;
  });

  it("should handle compile-senses subcommand with no senses", async () => {
    process.argv = ["node", "index.js", "compile-senses"];

    vi.resetModules();
    const { compileSenses } = await import("@/core/sense/compiler/index.js");
    (compileSenses as any).mockResolvedValue({
      succeeded: [],
      failed: [],
    });

    await import("@/index.js");
    expect(compileSenses).toHaveBeenCalled();
  });

  it("should handle compile-senses with succeeded senses", async () => {
    process.argv = ["node", "index.js", "compile-senses"];

    vi.resetModules();
    const { compileSenses } = await import("@/core/sense/compiler/index.js");
    const { runSenseTestsAndCollect, reportSenseCompileResult } = await import(
      "@/agent/sense/compileToolsReporter.js"
    );

    (compileSenses as any).mockResolvedValue({
      succeeded: [{ name: "test-sense", path: "/path/to/sense.ts" }],
      failed: [],
    });

    (runSenseTestsAndCollect as any).mockResolvedValue(
      new Map([["test-sense", { detail: { passed: true, error: null } }]])
    );

    await import("@/index.js");

    expect(runSenseTestsAndCollect).toHaveBeenCalled();
    expect(reportSenseCompileResult).toHaveBeenCalled();
  });

  it("should set exitCode=1 when compile-senses has failures", async () => {
    process.argv = ["node", "index.js", "compile-senses"];

    vi.resetModules();
    const { compileSenses } = await import("@/core/sense/compiler/index.js");
    const { runSenseTestsAndCollect, reportSenseCompileResult } = await import(
      "@/agent/sense/compileToolsReporter.js"
    );

    (compileSenses as any).mockResolvedValue({
      succeeded: [],
      failed: [{ name: "bad-sense", error: "compile error" }],
    });

    (runSenseTestsAndCollect as any).mockResolvedValue(new Map());
    (reportSenseCompileResult as any).mockImplementation(() => {});

    await import("@/index.js");

    expect(process.exitCode).toBe(1);
  });

  it("should set exitCode=1 when test results have failures", async () => {
    process.argv = ["node", "index.js", "compile-senses"];

    vi.resetModules();
    const { compileSenses } = await import("@/core/sense/compiler/index.js");
    const { runSenseTestsAndCollect, reportSenseCompileResult } = await import(
      "@/agent/sense/compileToolsReporter.js"
    );

    (compileSenses as any).mockResolvedValue({
      succeeded: [{ name: "test-sense", path: "/path/to/sense.ts" }],
      failed: [],
    });

    (runSenseTestsAndCollect as any).mockResolvedValue(
      new Map([["test-sense", { detail: { passed: false, error: "test failed" } }]])
    );
    (reportSenseCompileResult as any).mockImplementation(() => {});

    await import("@/index.js");

    expect(process.exitCode).toBe(1);
  });

  it("should handle SIGINT signal", async () => {
    process.argv = ["node", "index.js"];

    // Mock process.exit before importing
    const exitMock = vi.fn();
    process.exit = exitMock as any;

    vi.resetModules();
    await import("@/index.js");

    // Trigger SIGINT handler
    process.emit("SIGINT" as any);

    expect(mockWss.close).toHaveBeenCalled();
    expect(mockCloseDb).toHaveBeenCalled();
    expect(exitMock).toHaveBeenCalledWith(0);
  });

  it("should handle SIGTERM signal", async () => {
    process.argv = ["node", "index.js"];

    // Mock process.exit before importing
    const exitMock = vi.fn();
    process.exit = exitMock as any;

    vi.resetModules();
    await import("@/index.js");

    // Trigger SIGTERM handler
    process.emit("SIGTERM" as any);

    expect(mockWss.close).toHaveBeenCalled();
    expect(mockCloseDb).toHaveBeenCalled();
    expect(exitMock).toHaveBeenCalledWith(0);
  });

  it("should handle main() error and exit with code 1", async () => {
    process.argv = ["node", "index.js"];

    vi.resetModules();
    const { startService } = await import("@/service/index.js");
    (startService as any).mockImplementation(() => {
      throw new Error("Service failed to start");
    });

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitMock = vi.fn();
    process.exit = exitMock as any;

    await import("@/index.js");

    // Wait for microtask queue to flush (main() is async)
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(consoleErrorSpy).toHaveBeenCalledWith("启动失败:", "Service failed to start");
    expect(exitMock).toHaveBeenCalledWith(1);

    consoleErrorSpy.mockRestore();
  });
});