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

vi.mock("@/agent/sense/compileSensesReporter.js", () => ({
  runSenseTestsAndCollect: vi.fn(),
  reportSenseCompileResult: vi.fn(),
}));

describe("index.ts entry point", () => {
  const originalArgv = process.argv;
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.argv = [...originalArgv];
  });

  afterEach(() => {
    process.argv = originalArgv;
  });

  it("should start service with default port 8080", async () => {
    delete process.env.WS_PORT;
    process.argv = ["node", "index.js"];

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

  it("should handle compile-tools subcommand", async () => {
    process.argv = ["node", "index.js", "compile-tools"];

    vi.resetModules();
    const { compileSenses } = await import("@/core/sense/compiler/index.js");
    (compileSenses as any).mockResolvedValue({
      succeeded: [],
      failed: [],
    });

    await import("@/index.js");
    expect(compileSenses).toHaveBeenCalled();
  });
});
