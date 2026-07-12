/**
 * AgentBuilder 门面测试：build/configureRuntime/init/run 链 + 门面方法转发 + 错误守卫。
 *
 * 复用 flows/fixtures config + bootstrapForTests。深度 Middleware 方法测试见 middleware/index.test。
 */
import { describe, it, expect, beforeAll } from "vitest";
import { AgentBuilder } from "@/agent/builder.js";
import type { LLMResponse } from "@/core/message/adapter.js";
import { bootstrapForTests } from "./helpers/agentHarness.js";
import { collectChunks, hasDone, messageCreated } from "./helpers/chunkAssert.js";

describe("AgentBuilder 链式调用", () => {
  beforeAll(async () => {
    await bootstrapForTests();
  });

  it("build() 返回 this", () => {
    const b = new AgentBuilder();
    expect(b.build()).toBe(b);
  });

  it("configureRuntime 返回 this（build 后）", () => {
    const b = new AgentBuilder().build();
    expect(b.configureRuntime({ brain: "mock_content", senseGroup: "auto_senses" })).toBe(b);
  });

  it("init 返回 this", () => {
    const b = new AgentBuilder().build().configureRuntime({ brain: "mock_content", senseGroup: "auto_senses" });
    expect(b.init("chat-1")).toBe(b);
  });

  it("链式 build().configureRuntime().init() 一气呵成", () => {
    const b = new AgentBuilder()
      .build()
      .configureRuntime({ brain: "mock_content", senseGroup: "auto_senses" })
      .init("chat-chain");
    expect(b).toBeInstanceOf(AgentBuilder);
  });
});

describe("AgentBuilder 错误守卫", () => {
  beforeAll(async () => {
    await bootstrapForTests();
  });

  it("未 build 调 configureRuntime → throw（合法 selection 使 resolve 通过，requireAgent 抛未构建）", () => {
    const b = new AgentBuilder();
    expect(() => b.configureRuntime({ brain: "mock_content", senseGroup: "auto_senses" })).toThrow("未构建");
  });

  it("未 build 调 init → throw", () => {
    const b = new AgentBuilder();
    expect(() => b.init("x")).toThrow("未构建");
  });

  it("未 build 调 run → throw", () => {
    const b = new AgentBuilder();
    expect(() => b.run("x")).toThrow("未构建");
  });
});

describe("AgentBuilder 集成（门面转发 Middleware）", () => {
  beforeAll(async () => {
    await bootstrapForTests();
  });

  it("完整链 build→configure→init→run（content-only）→ done", async () => {
    const b = new AgentBuilder()
      .build()
      .configureRuntime({ brain: "mock_content", senseGroup: "auto_senses" })
      .init("chat-integration");
    const chunks = await collectChunks(b.run("集成"));
    expect(hasDone(chunks)).toBe(true);
    expect(messageCreated(chunks).some((m) => m.message.role === "assistant")).toBe(true);
  });

  it("init 注入 system prompt（缺省 messages）", () => {
    const b = new AgentBuilder()
      .build()
      .configureRuntime({ brain: "mock_content", senseGroup: "auto_senses" })
      .init("chat-sys");
    const msgs = b.getMessages();
    expect(msgs.some((m) => m.role === "system")).toBe(true);
  });

  it("init 接收自定义 history（非空时不注入 system）", () => {
    const history: LLMResponse[] = [
      { id: "custom-sys", role: "system", content: "custom", createdAt: 0, updateAt: 0 },
    ];
    const b = new AgentBuilder()
      .build()
      .configureRuntime({ brain: "mock_content", senseGroup: "auto_senses" })
      .init("chat-custom", history);
    expect(b.getMessages()[0]!.content).toBe("custom");
  });

  it("getMessages 返回数组", () => {
    const b = new AgentBuilder().build().configureRuntime({ brain: "mock_content", senseGroup: "auto_senses" }).init("chat-msg");
    expect(Array.isArray(b.getMessages())).toBe(true);
  });

  it("isRunning 初始 false", () => {
    const b = new AgentBuilder().build().configureRuntime({ brain: "mock_content", senseGroup: "auto_senses" }).init("chat-run");
    expect(b.isRunning()).toBe(false);
  });

  it("revokeTrailingCycle 门面（无未完成周期 → 空）", () => {
    const b = new AgentBuilder().build().configureRuntime({ brain: "mock_content", senseGroup: "auto_senses" }).init("chat-rev");
    expect(b.revokeTrailingCycle()).toEqual([]);
  });

  it("abort 门面不抛错", () => {
    const b = new AgentBuilder().build().configureRuntime({ brain: "mock_content", senseGroup: "auto_senses" }).init("chat-abort");
    expect(() => b.abort()).not.toThrow();
  });
});
