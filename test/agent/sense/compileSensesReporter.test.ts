import { describe, it, expect, vi } from "vitest";
import type { CompiledSenseInfo } from "@/core/sense/compiler/index.js";
import type { TestResultDetail } from "@/agent/sense/index.js";

vi.mock("@/agent/sense/index.js", () => ({
  runSenseTests: vi.fn(),
}));

describe("compileSensesReporter", () => {
  it("reportSenseCompileResult should handle empty results", async () => {
    const { reportSenseCompileResult } = await import("@/agent/sense/compileSensesReporter.js");
    const summary = { succeeded: [], failed: [] };
    const testResults = new Map();

    expect(() => reportSenseCompileResult(summary, testResults)).not.toThrow();
  });

  it("reportSenseCompileResult should handle compile failures", async () => {
    const { reportSenseCompileResult } = await import("@/agent/sense/compileSensesReporter.js");
    const summary = {
      succeeded: [],
      failed: [{ sourcePath: "/test/bad.ts", fileName: "bad.ts", type: "syntax" as const, message: "syntax error" }],
    };
    const testResults = new Map();

    expect(() => reportSenseCompileResult(summary, testResults)).not.toThrow();
  });

  it("reportSenseCompileResult should handle succeeded with no tests", async () => {
    const { reportSenseCompileResult } = await import("@/agent/sense/compileSensesReporter.js");
    const info: CompiledSenseInfo = {
      compiledPath: "/dist/test.js",
      sourcePath: "/test/test.ts",
      testCases: [],
    };
    const summary = { succeeded: [info], failed: [] };
    const testResults = new Map();

    expect(() => reportSenseCompileResult(summary, testResults)).not.toThrow();
  });

  it("runSenseTestsAndCollect should handle tools with no test cases", async () => {
    const { runSenseTestsAndCollect } = await import("@/agent/sense/compileSensesReporter.js");
    const infos: CompiledSenseInfo[] = [{
      compiledPath: "/dist/notest.js",
      sourcePath: "/test/notest.ts",
      testCases: [],
    }];

    const results = await runSenseTestsAndCollect(infos);
    expect(results.get("/test/notest.ts")).toBeDefined();
    expect(results.get("/test/notest.ts")!.detail.passed).toBe(true);
  });

  it("runSenseTestsAndCollect should handle import errors", async () => {
    const { runSenseTestsAndCollect } = await import("@/agent/sense/compileSensesReporter.js");
    const infos: CompiledSenseInfo[] = [{
      compiledPath: "/nonexistent/path.js",
      sourcePath: "/test/broken.ts",
      testCases: [{ input: { a: 1 }, output: { content: "ok", hash: "" } }],
    }];

    const results = await runSenseTestsAndCollect(infos);
    const detail = results.get("/test/broken.ts")!.detail;
    expect(detail.passed).toBe(false);
    expect(detail.error).toBeDefined();
  });
});
