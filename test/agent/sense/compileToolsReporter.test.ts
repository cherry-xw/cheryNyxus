/**
 * compileToolsReporter 测试：reportSenseCompileResult + runSenseTestsAndCollect。
 *
 * reportSenseCompileResult 主要是 logger 格式化输出（断言不抛错 + 各分支覆盖）。
 * runSenseTestsAndCollect 动态 import compiledPath，测 error/empty 路径。
 */
import { describe, it, expect } from "vitest";
import {
  reportSenseCompileResult,
  runSenseTestsAndCollect,
} from "@/agent/sense/compileToolsReporter.js";
import type {
  CompiledSenseInfo,
  SenseCompileSummary,
} from "@/core/sense/compiler/index.js";

function makeInfo(partial: Partial<CompiledSenseInfo>): CompiledSenseInfo {
  return partial as unknown as CompiledSenseInfo;
}

describe("reportSenseCompileResult", () => {
  it("编译成功 + 测试通过 → 不抛错", () => {
    const summary: SenseCompileSummary = {
      succeeded: [
        makeInfo({ sourcePath: "a.ts", compiledPath: "/a.js", testCases: [{ input: {}, output: { content: "", hash: "" } }] }),
      ],
      failed: [],
    } as SenseCompileSummary;
    const testResults = new Map([
      ["a.ts", { detail: { passed: true, passedCount: 1, totalCount: 1, failures: [] } }],
    ]);
    expect(() => reportSenseCompileResult(summary, testResults)).not.toThrow();
  });

  it("编译失败 + 测试失败 → 不抛错", () => {
    const summary: SenseCompileSummary = {
      succeeded: [
        makeInfo({ sourcePath: "b.ts", compiledPath: "/b.js", testCases: [{ input: {}, output: { content: "x", hash: "" } }] }),
      ],
      failed: [{ sourcePath: "c.ts", message: "syntax error" }],
    } as unknown as SenseCompileSummary;
    const testResults = new Map([
      ["b.ts", {
        detail: {
          passed: false, passedCount: 0, totalCount: 1,
          failures: [{ input: {}, expected: { content: "x", hash: "" }, actual: { content: "y", hash: "" } }],
        },
      }],
    ]);
    expect(() => reportSenseCompileResult(summary, testResults)).not.toThrow();
  });

  it("无 testCases → 测试列显示「-」不抛错", () => {
    const summary: SenseCompileSummary = {
      succeeded: [makeInfo({ sourcePath: "d.ts", compiledPath: "/d.js", testCases: [] })],
      failed: [],
    } as SenseCompileSummary;
    expect(() => reportSenseCompileResult(summary, new Map())).not.toThrow();
  });
});

describe("runSenseTestsAndCollect", () => {
  it("compiledPath 无效 → detail.error 填充", async () => {
    const infos = [
      makeInfo({ sourcePath: "bad.ts", compiledPath: "/nonexistent/path/x.js", testCases: [{ input: {}, output: { content: "", hash: "" } }] }),
    ];
    const r = await runSenseTestsAndCollect(infos);
    const d = r.get("bad.ts")?.detail;
    expect(d?.passed).toBe(false);
    expect(d?.error).toBeTruthy();
  });

  it("空 testCases → passed true，count 0", async () => {
    const infos = [makeInfo({ sourcePath: "empty.ts", compiledPath: "/x.js", testCases: [] })];
    const r = await runSenseTestsAndCollect(infos);
    const d = r.get("empty.ts")?.detail;
    expect(d?.passed).toBe(true);
    expect(d?.passedCount).toBe(0);
    expect(d?.totalCount).toBe(0);
  });
});
