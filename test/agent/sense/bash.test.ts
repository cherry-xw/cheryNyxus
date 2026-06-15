/**
 * execute_command (bash) sense 测试（执行器单元，真实 spawn）。
 *
 * 覆盖：
 * - 成功命令（echo）→ 状态 success + exitCode 0
 * - 失败命令（exit 1）→ 状态 error
 * - description 出现在 content
 * - hash 为空（bash 无去重 hash）
 * - output 超过 30 行 → 截断（含「省略」）
 * - supervision = manual
 */
import { describe, it, expect, beforeEach } from "vitest";
import bashSense from "@/agent/sense/bash.js";
import { SupervisionLevel } from "@/core/config.js";

const exec = bashSense.executor.execute.bind(bashSense.executor);
const sharedData = new Map<string, Map<string, unknown>>();

describe("execute_command sense 定义", () => {
  it("name = execute_command，supervision = manual", () => {
    expect(bashSense.definition.function.name).toBe("execute_command");
    expect(bashSense.supervisionLevel).toBe(SupervisionLevel.manual);
  });
});

describe("execute_command 执行", () => {
  beforeEach(() => sharedData.clear());

  it("echo 成功 → 状态 success + 含输出", async () => {
    const r = await exec({ command: "echo bash_test_output", description: "打印测试" }, sharedData);
    expect(r.content).toContain("状态: success");
    expect(r.content).toContain("bash_test_output");
    expect(r.content).toContain("退出码: 0");
  });

  it("失败命令（exit 1）→ 状态 error", async () => {
    const r = await exec({ command: "exit 1", description: "失败" }, sharedData);
    expect(r.content).toContain("状态: error");
  });

  it("成功命令含退出码与进程ID", async () => {
    const r = await exec({ command: "echo d", description: "独一无二的描述XYZ" }, sharedData);
    expect(r.content).toContain("状态: success");
    expect(r.content).toContain("退出码: 0");
    expect(r.content).toContain("进程ID:");
  });

  it("hash 为空", async () => {
    const r = await exec({ command: "echo h", description: "x" }, sharedData);
    expect(r.hash).toBe("");
  });

  it("output 超过 30 行 → 截断（含「省略」）", async () => {
    const r = await exec({ command: "seq 1 50", description: "多行输出" }, sharedData);
    expect(r.content).toContain("省略");
  });

  it("stderr 也计入 output", async () => {
    const r = await exec({ command: "echo err >&2", description: "stderr" }, sharedData);
    expect(r.content).toContain("err");
  });
});
