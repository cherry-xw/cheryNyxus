/**
 * middleware/index 导出装配 + Middleware 类方法集成测试。
 *
 * 覆盖：
 * - defaultHandlers 结构（4 handler）+ 各 handler 导出
 * - createLoopHandler 返回函数
 * - 完整 Middleware send 集成（defaultHandlers 装配正确）
 * - Middleware.revokeTrailingCycle（撤回末尾周期）
 * - Middleware.hasPendingTrailingSense（pending 判定）
 * - Middleware 未 init/未 configureRuntime 校验
 */
import { describe, it, expect, beforeAll } from "vitest";
import Middleware, {
  defaultHandlers,
  createLoopHandler,
  checkpointMiddleware,
  chatMiddleware,
  senseMiddleware,
  retryMiddleware,
} from "@/agent/middleware/index.js";
import { SupervisionLevel } from "@/core/config.js";
import config from "@/utils/config.js";
import type { LLMResponse } from "@/core/message/adapter.js";
import { bootstrapForTests, createAgent, runSend } from "../helpers/agentHarness.js";
import { hasDone, messageCreated } from "../helpers/chunkAssert.js";

describe("middleware/index 导出与装配", () => {
  it("defaultHandlers 含 4 个 handler", () => {
    expect(defaultHandlers.length).toBe(4);
  });

  it("defaultHandlers 元素均为函数", () => {
    for (const h of defaultHandlers) expect(typeof h).toBe("function");
  });

  it("createLoopHandler 返回函数", () => {
    expect(typeof createLoopHandler(5)).toBe("function");
  });

  it("各 middleware 导出为函数", () => {
    expect(typeof checkpointMiddleware).toBe("function");
    expect(typeof chatMiddleware).toBe("function");
    expect(typeof senseMiddleware).toBe("function");
    expect(typeof retryMiddleware).toBe("function");
  });
});

describe("Middleware 类方法", () => {
  it("未 init 即 send → throw", () => {
    const mw = new Middleware(config.global, defaultHandlers, createLoopHandler(10));
    expect(async () => {
      for await (const _ of mw.send("x")) { _; }
    }).rejects.toThrow();
  });

  it("revokeTrailingCycle：撤回末尾 sense 群 + 前置 assistant(senseCalls)", () => {
    const history: LLMResponse[] = [
      { id: "sys", role: "system", content: "sys", createdAt: 0, updateAt: 0 },
      { id: "u1", role: "user", content: "hi", createdAt: 0, updateAt: 0 },
      { id: "as1", role: "assistant", content: "call", senseCalls: [{ id: "a", name: "read_file", arguments: "{}" }], createdAt: 0, updateAt: 0 },
      { id: "a", role: "sense", content: "done result", createdAt: 0, updateAt: 0 },
      { id: "b", role: "sense", content: "", createdAt: 0, updateAt: 0 },
    ];
    const mw = new Middleware(config.global, defaultHandlers, createLoopHandler(10));
    mw.init("revoke-chat", history);
    const revoked = mw.revokeTrailingCycle();
    expect(revoked).toContain("as1");
    expect(revoked).toContain("a");
    expect(revoked).toContain("b");
    const msgs = mw.getMessages();
    expect(msgs.find((m) => m.id === "as1")?.revoked).toBe(true);
    expect(msgs.find((m) => m.id === "b")?.revoked).toBe(true);
  });

  it("revokeTrailingCycle：末尾非 sense 群 → 返回空", () => {
    const history: LLMResponse[] = [
      { id: "u", role: "user", content: "hi", createdAt: 0, updateAt: 0 },
      { id: "a", role: "assistant", content: "reply", createdAt: 0, updateAt: 0 },
    ];
    const mw = new Middleware(config.global, defaultHandlers, createLoopHandler(10));
    mw.init("no-revoke", history);
    expect(mw.revokeTrailingCycle()).toEqual([]);
  });

  it("hasPendingTrailingSense：末尾 pending → true", () => {
    const history: LLMResponse[] = [
      { id: "as", role: "assistant", content: "c", senseCalls: [{ id: "p", name: "x", arguments: "{}" }], createdAt: 0, updateAt: 0 },
      { id: "p", role: "sense", content: "", createdAt: 0, updateAt: 0 },
    ];
    const mw = new Middleware(config.global, defaultHandlers, createLoopHandler(10));
    mw.init("pending-chat", history);
    expect(mw.hasPendingTrailingSense()).toBe(true);
  });

  it("hasPendingTrailingSense：全 done → false", () => {
    const history: LLMResponse[] = [
      { id: "as", role: "assistant", content: "c", senseCalls: [{ id: "d", name: "x", arguments: "{}" }], createdAt: 0, updateAt: 0 },
      { id: "d", role: "sense", content: "done", createdAt: 0, updateAt: 0 },
    ];
    const mw = new Middleware(config.global, defaultHandlers, createLoopHandler(10));
    mw.init("done-chat", history);
    expect(mw.hasPendingTrailingSense()).toBe(false);
  });

  it("init 幂等：重复 init 不重置 messages", () => {
    const mw = new Middleware(config.global, defaultHandlers, createLoopHandler(10));
    const r1 = mw.init("once", [{ id: "s", role: "system", content: "sys", createdAt: 0, updateAt: 0 }]);
    const r2 = mw.init("twice", [{ id: "s2", role: "system", content: "sys2", createdAt: 0, updateAt: 0 }]);
    expect(r1).toBe("once");
    expect(r2).toBeUndefined(); // 已 inited → 直接 return
    expect(mw.getMessages().length).toBe(1); // 不重复注入
  });

  it("isRunning 初始 false", () => {
    const mw = new Middleware(config.global, defaultHandlers, createLoopHandler(10));
    expect(mw.isRunning()).toBe(false);
  });
});

describe("完整 Middleware 集成（defaultHandlers 装配）", () => {
  beforeAll(async () => {
    await bootstrapForTests();
  });

  it("defaultHandlers 装配后 send content-only 完整流程", async () => {
    const agent = createAgent({ brain: "mock_content", senseGroups: ["auto_senses"] });
    const chunks = await runSend(agent, "集成测试");
    expect(hasDone(chunks)).toBe(true);
    expect(messageCreated(chunks).some((m) => m.message.role === "assistant")).toBe(true);
  });
});
