/**
 * agent/sense/index 测试：reloadSenses + runSenseTests。
 *
 * 覆盖：
 * - reloadSenses 注册 4 内置 senses（read_file/write_file/execute_command/skill）
 * - reset 后 reload 恢复
 * - runSenseTests：全过 / 部分失败 / execute 抛错
 */
import { describe, it, expect } from "vitest";
import { reloadSenses, runSenseTests } from "@/agent/sense/index.js";
import { getSense, resetSenses } from "@/core/sense/index.js";
import { createTestSense } from "../helpers/fakeContext.js";
import type { TestCase } from "@/core/sense/compiler/types.js";

describe("reloadSenses", () => {
  it("注册 4 个内置 senses", async () => {
    await reloadSenses();
    expect(getSense("read_file")).toBeDefined();
    expect(getSense("write_file")).toBeDefined();
    expect(getSense("execute_command")).toBeDefined();
    expect(getSense("skill")).toBeDefined();
  });

  it("reset 后重新 reload 恢复", async () => {
    await reloadSenses();
    expect(getSense("read_file")).toBeDefined();
    resetSenses();
    expect(getSense("read_file")).toBeUndefined();
    await reloadSenses();
    expect(getSense("read_file")).toBeDefined();
  });

  it("重复 reloadSenses 安全（幂等）", async () => {
    await reloadSenses();
    await reloadSenses();
    expect(getSense("read_file")).toBeDefined();
  });
});

describe("runSenseTests", () => {
  it("全过 → passed true", async () => {
    const s = createTestSense("calc", async (input) => ({ content: String(Number(input.x) * 2), hash: "" }));
    const tcs: TestCase[] = [{ input: { x: 2 }, output: { content: "4", hash: "" } }];
    const r = await runSenseTests(s, tcs);
    expect(r.passed).toBe(true);
    expect(r.passedCount).toBe(1);
    expect(r.totalCount).toBe(1);
  });

  it("部分失败 → failures 非空", async () => {
    const s = createTestSense("calc", async (input) => ({ content: String(Number(input.x) * 2), hash: "" }));
    const tcs: TestCase[] = [
      { input: { x: 2 }, output: { content: "4", hash: "" } },
      { input: { x: 3 }, output: { content: "99", hash: "" } },
    ];
    const r = await runSenseTests(s, tcs);
    expect(r.passed).toBe(false);
    expect(r.passedCount).toBe(1);
    expect(r.failures.length).toBe(1);
    expect(r.failures[0]!.expected).toEqual({ content: "99", hash: "" });
  });

  it("execute 抛错 → error 填充", async () => {
    const s = createTestSense("boom", async () => {
      throw new Error("exec boom");
    });
    const r = await runSenseTests(s, [{ input: {}, output: { content: "", hash: "" } }]);
    expect(r.passed).toBe(false);
    expect(r.error).toContain("exec boom");
  });
});
