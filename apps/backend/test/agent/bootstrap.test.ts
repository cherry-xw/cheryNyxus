/**
 * bootstrapAgentRuntime 测试：启动期注册 provider + 内置 senses。
 *
 * 覆盖：
 * - 注册 3 provider（mock/openai/ollama）+ 4 内置 senses
 * - 幂等（重复调用安全）
 */
import { describe, it, expect, beforeAll } from "vitest";
import { bootstrapAgentRuntime } from "@/agent/bootstrap.js";
import { getLLMAdapter } from "@/core/llm/adapter.js";
import { getSense } from "@/core/sense/index.js";

describe("bootstrapAgentRuntime", () => {
  beforeAll(async () => {
    await bootstrapAgentRuntime();
  });

  it("注册 3 provider adapter", () => {
    expect(getLLMAdapter("mock")).toBeDefined();
    expect(getLLMAdapter("openai")).toBeDefined();
    expect(getLLMAdapter("ollama")).toBeDefined();
  });

  it("注册 4 内置 senses", () => {
    expect(getSense("read_file")).toBeDefined();
    expect(getSense("write_file")).toBeDefined();
    expect(getSense("execute_command")).toBeDefined();
    expect(getSense("skill")).toBeDefined();
  });

  it("幂等：重复调用安全", async () => {
    await bootstrapAgentRuntime();
    await bootstrapAgentRuntime();
    expect(getLLMAdapter("mock")).toBeDefined();
    expect(getSense("read_file")).toBeDefined();
  });
});
