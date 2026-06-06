import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CompiledSenseInfo } from "@/core/sense/compiler/index.js";
import { z } from "zod";
import { sense } from "@/core/sense/senseCreator";
import { SupervisionLevel } from "@/core/config";

// Mock console.log to capture output
const consoleLogs: string[] = [];
const originalLog = console.log;

beforeEach(() => {
  consoleLogs.length = 0;
  console.log = vi.fn((...args) => {
    consoleLogs.push(args.map(a => String(a)).join(" "));
  });
});

afterEach(() => {
  console.log = originalLog;
});

describe("compileSensesReporter", () => {
  describe("reportSenseCompileResult", () => {
    it("should handle empty results", async () => {
      const { reportSenseCompileResult } = await import("@/agent/sense/compileToolsReporter.js");
      const summary = { succeeded: [], failed: [] };
      const testResults = new Map();

      expect(() => reportSenseCompileResult(summary, testResults)).not.toThrow();
    });

    it("should handle compile failures", async () => {
      const { reportSenseCompileResult } = await import("@/agent/sense/compileToolsReporter.js");
      const summary = {
        succeeded: [],
        failed: [{ sourcePath: "/test/bad.ts", fileName: "bad.ts", type: "syntax" as const, message: "syntax error" }],
      };
      const testResults = new Map();

      reportSenseCompileResult(summary, testResults);

      // Should show compile failure details
      const output = consoleLogs.join("\n");
      expect(output).toContain("编译失败");
      expect(output).toContain("bad.ts");
      expect(output).toContain("syntax error");
    });

    it("should handle succeeded with no tests", async () => {
      const { reportSenseCompileResult } = await import("@/agent/sense/compileToolsReporter.js");
      const info: CompiledSenseInfo = {
        compiledPath: "/dist/test.js",
        sourcePath: "/test/test.ts",
        testCases: [],
      };
      const summary = { succeeded: [info], failed: [] };
      const testResults = new Map();

      reportSenseCompileResult(summary, testResults);

      const output = consoleLogs.join("\n");
      expect(output).toContain("1 编译成功");
    });

    it("should handle passed tests with testInfo", async () => {
      const { reportSenseCompileResult } = await import("@/agent/sense/compileToolsReporter.js");
      const info: CompiledSenseInfo = {
        compiledPath: "/dist/test.js",
        sourcePath: "/test/test.ts",
        testCases: [{ input: { a: 1 }, output: { content: "ok", hash: "" } }],
      };
      const summary = { succeeded: [info], failed: [] };
      const testResults = new Map([
        ["/test/test.ts", { detail: { passed: true, passedCount: 1, totalCount: 1, failures: [] } }],
      ]);

      reportSenseCompileResult(summary, testResults);

      const output = consoleLogs.join("\n");
      expect(output).toContain("✓");
      expect(output).toContain("1/1");
      expect(output).toContain("1 通过");
    });

    it("should handle failed tests with testInfo", async () => {
      const { reportSenseCompileResult } = await import("@/agent/sense/compileToolsReporter.js");
      const info: CompiledSenseInfo = {
        compiledPath: "/dist/test.js",
        sourcePath: "/test/test.ts",
        testCases: [
          { input: { a: 1 }, output: { content: "expected", hash: "" } },
          { input: { b: 2 }, output: { content: "expected2", hash: "" } },
        ],
      };
      const summary = { succeeded: [info], failed: [] };
      const testResults = new Map([
        ["/test/test.ts", {
          detail: {
            passed: false,
            passedCount: 1,
            totalCount: 2,
            failures: [{ input: { b: 2 }, expected: { content: "expected2", hash: "" }, actual: { content: "actual", hash: "" } }],
          },
        }],
      ]);

      reportSenseCompileResult(summary, testResults);

      const output = consoleLogs.join("\n");
      expect(output).toContain("✗");
      expect(output).toContain("1/2");
      expect(output).toContain("1 失败");
      expect(output).toContain("测试失败");
      expect(output).toContain("input:");
      expect(output).toContain("expected:");
      expect(output).toContain("actual:");
    });

    it("should handle test failure with error message", async () => {
      const { reportSenseCompileResult } = await import("@/agent/sense/compileToolsReporter.js");
      const info: CompiledSenseInfo = {
        compiledPath: "/dist/test.js",
        sourcePath: "/test/error.ts",
        testCases: [{ input: { a: 1 }, output: { content: "ok", hash: "" } }],
      };
      const summary = { succeeded: [info], failed: [] };
      const testResults = new Map([
        ["/test/error.ts", {
          detail: {
            passed: false,
            passedCount: 0,
            totalCount: 1,
            failures: [],
            error: "Test execution error",
          },
        }],
      ]);

      reportSenseCompileResult(summary, testResults);

      const output = consoleLogs.join("\n");
      expect(output).toContain("执行异常");
      expect(output).toContain("Test execution error");
    });

    it("should handle multiple files with mixed results", async () => {
      const { reportSenseCompileResult } = await import("@/agent/sense/compileToolsReporter.js");
      const summary = {
        succeeded: [
          { compiledPath: "/dist/a.js", sourcePath: "/test/a.ts", testCases: [] },
          { compiledPath: "/dist/b.js", sourcePath: "/test/b.ts", testCases: [{ input: {}, output: { content: "", hash: "" } }] },
        ],
        failed: [
          { sourcePath: "/test/c.ts", fileName: "c.ts", type: "syntax" as const, message: "error" },
        ],
      };
      const testResults = new Map([
        ["/test/b.ts", { detail: { passed: true, passedCount: 1, totalCount: 1, failures: [] } }],
      ]);

      reportSenseCompileResult(summary, testResults);

      const output = consoleLogs.join("\n");
      expect(output).toContain("1 编译失败");
      expect(output).toContain("2 编译成功");
      expect(output).toContain("1 通过");
      // a.ts has no tests, c.ts failed compilation so no tests - total 2 无测试
      expect(output).toContain("2 无测试");
    });

    it("should format path correctly (show only filename)", async () => {
      const { reportSenseCompileResult } = await import("@/agent/sense/compileToolsReporter.js");
      const info: CompiledSenseInfo = {
        compiledPath: "/dist/deep/nested/path/test.js",
        sourcePath: "/very/deep/nested/path/mySense.ts",
        testCases: [],
      };
      const summary = { succeeded: [info], failed: [] };
      const testResults = new Map();

      reportSenseCompileResult(summary, testResults);

      const output = consoleLogs.join("\n");
      expect(output).toContain("mySense.ts");
      expect(output).not.toContain("/very/deep/nested/path/");
    });
  });

  describe("runSenseTestsAndCollect", () => {
    it("should handle tools with no test cases", async () => {
      const { runSenseTestsAndCollect } = await import("@/agent/sense/compileToolsReporter.js");
      const infos: CompiledSenseInfo[] = [{
        compiledPath: "/dist/notest.js",
        sourcePath: "/test/notest.ts",
        testCases: [],
      }];

      const results = await runSenseTestsAndCollect(infos);
      expect(results.get("/test/notest.ts")).toBeDefined();
      expect(results.get("/test/notest.ts")!.detail.passed).toBe(true);
      expect(results.get("/test/notest.ts")!.detail.passedCount).toBe(0);
      expect(results.get("/test/notest.ts")!.detail.totalCount).toBe(0);
    });

    it("should handle import errors", async () => {
      const { runSenseTestsAndCollect } = await import("@/agent/sense/compileToolsReporter.js");
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

    it("should detect test failures", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const os = await import("os");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sense-test-"));
      const tmpFile = path.join(tmpDir, "test.js");

      // Create a sense module that returns different result than expected
      fs.writeFileSync(tmpFile, `
        export default {
          definition: { function: { name: "test", description: "", parameters: {} } },
          supervisionLevel: 0,
          executor: {
            schema: { parse: (v) => v },
            execute: async (input) => ({ content: "actual result", hash: "" })
          }
        };
      `);

      try {
        const { runSenseTestsAndCollect } = await import("@/agent/sense/compileToolsReporter.js");
        const infos: CompiledSenseInfo[] = [{
          compiledPath: tmpFile,
          sourcePath: "/test/test.ts",
          testCases: [{ input: { a: 1 }, output: { content: "expected result", hash: "" } }],
        }];

        const results = await runSenseTestsAndCollect(infos);
        const detail = results.get("/test/test.ts")!.detail;
        expect(detail.passed).toBe(false);
        expect(detail.failures.length).toBe(1);
        expect(detail.failures[0].expected.content).toBe("expected result");
        expect(detail.failures[0].actual.content).toBe("actual result");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("should handle multiple test cases with mixed results", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const os = await import("os");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sense-test-"));
      const tmpFile = path.join(tmpDir, "test.js");

      // Create a module that passes some tests and fails others
      fs.writeFileSync(tmpFile, `
        export default {
          definition: { function: { name: "multi_test", description: "", parameters: {} } },
          supervisionLevel: 0,
          executor: {
            schema: { parse: (v) => v },
            execute: async (input) => ({ content: "result: " + input.value, hash: "" })
          }
        };
      `);

      try {
        const { runSenseTestsAndCollect } = await import("@/agent/sense/compileToolsReporter.js");
        const infos: CompiledSenseInfo[] = [{
          compiledPath: tmpFile,
          sourcePath: "/test/multi.ts",
          testCases: [
            { input: { value: 1 }, output: { content: "result: 1", hash: "" } },
            { input: { value: 2 }, output: { content: "wrong", hash: "" } },
            { input: { value: 3 }, output: { content: "result: 3", hash: "" } },
          ],
        }];

        const results = await runSenseTestsAndCollect(infos);
        const detail = results.get("/test/multi.ts")!.detail;
        expect(detail.passed).toBe(false);
        expect(detail.passedCount).toBe(2);
        expect(detail.totalCount).toBe(3);
        expect(detail.failures.length).toBe(1);
        expect(detail.failures[0].input).toEqual({ value: 2 });
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});