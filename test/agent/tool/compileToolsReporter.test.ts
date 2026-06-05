import { describe, it, expect, vi } from "vitest";
import type { CompiledToolInfo } from "@/core/tool/compiler/index.js";
import type { TestResultDetail } from "@/agent/tool/index.js";

vi.mock("@/agent/tool/index.js", () => ({
  runToolTests: vi.fn(),
}));

describe("compileToolsReporter", () => {
  it("reportToolCompileResult should handle empty results", async () => {
    const { reportToolCompileResult } = await import("@/agent/tool/compileToolsReporter.js");
    const summary = { succeeded: [], failed: [] };
    const testResults = new Map();

    expect(() => reportToolCompileResult(summary, testResults)).not.toThrow();
  });

  it("reportToolCompileResult should handle compile failures", async () => {
    const { reportToolCompileResult } = await import("@/agent/tool/compileToolsReporter.js");
    const summary = {
      succeeded: [],
      failed: [{ sourcePath: "/test/bad.ts", fileName: "bad.ts", type: "syntax" as const, message: "syntax error" }],
    };
    const testResults = new Map();

    expect(() => reportToolCompileResult(summary, testResults)).not.toThrow();
  });

  it("reportToolCompileResult should handle succeeded with no tests", async () => {
    const { reportToolCompileResult } = await import("@/agent/tool/compileToolsReporter.js");
    const info: CompiledToolInfo = {
      compiledPath: "/dist/test.js",
      sourcePath: "/test/test.ts",
      testCases: [],
    };
    const summary = { succeeded: [info], failed: [] };
    const testResults = new Map();

    expect(() => reportToolCompileResult(summary, testResults)).not.toThrow();
  });

  it("runToolTestsAndCollect should handle tools with no test cases", async () => {
    const { runToolTestsAndCollect } = await import("@/agent/tool/compileToolsReporter.js");
    const infos: CompiledToolInfo[] = [{
      compiledPath: "/dist/notest.js",
      sourcePath: "/test/notest.ts",
      testCases: [],
    }];

    const results = await runToolTestsAndCollect(infos);
    expect(results.get("/test/notest.ts")).toBeDefined();
    expect(results.get("/test/notest.ts")!.detail.passed).toBe(true);
  });

  it("runToolTestsAndCollect should handle import errors", async () => {
    const { runToolTestsAndCollect } = await import("@/agent/tool/compileToolsReporter.js");
    const infos: CompiledToolInfo[] = [{
      compiledPath: "/nonexistent/path.js",
      sourcePath: "/test/broken.ts",
      testCases: [{ input: { a: 1 }, output: { content: "ok", hash: "" } }],
    }];

    const results = await runToolTestsAndCollect(infos);
    const detail = results.get("/test/broken.ts")!.detail;
    expect(detail.passed).toBe(false);
    expect(detail.error).toBeDefined();
  });
});
