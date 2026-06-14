/**
 * SPIKE：验证集成测试核心链路（config 隔离 / bootstrap / startService / WS client / 二进制帧 / DB）。
 * 跑通后再扩展各流程测试。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startApp, stopApp, type AppHandle } from "./helpers/harness.js";
import { FlowRpcClient } from "./helpers/rpcClient.js";
import { dbMessages } from "./helpers/dbAssert.js";

describe("spike: 核心链路验证", () => {
  let app: AppHandle;
  let client: FlowRpcClient;

  beforeAll(async () => {
    app = await startApp();
    client = new FlowRpcClient(app.url);
    await client.connect();
  });

  afterAll(async () => {
    client.close();
    await stopApp(app);
  });

  it("brain.list 返回 mock brains", async () => {
    const res = await client.call("brain.list", {});
    expect(res.success).toBe(true);
    const data = res.data as { brains: Array<{ name: string; provider: string }> };
    const names = data.brains.map((b) => b.name);
    expect(names).toContain("mock_content");
    expect(names).toContain("mock_auto");
    expect(names).toContain("mock_confirm");
  });

  it("content-only flow：chat.create + chat.send + DB 持久化", async () => {
    const chatId = "spike-content";
    const create = await client.call("chat.create", {
      chatId,
      brain: "mock_content",
      senseGroups: ["auto_senses"],
    });
    expect(create.success).toBe(true);
    expect((create.data as { chatId: string }).chatId).toBe(chatId);

    const flow = client.beginStream("chat.send", { chatId, prompt: "你好" });

    // 验证 consumed 通知
    const consumed = await flow.waitFor(
      (e) => e.kind === "notification" && (e as { type: string }).type === "consumed",
    );
    expect((consumed as unknown as { data: { count: number } }).data.count).toBe(1);

    const result = await flow.done();
    expect(result.response.success).toBe(true);

    // 事件分类断言（notification.type / staged.data.type / stream chunk）
    const notifTypes = result.events
      .filter((e) => e.kind === "notification")
      .map((e) => (e as { type: string }).type);
    const stagedTypes = result.events
      .filter((e) => e.kind === "chunk" && (e as { type: string }).type === "staged")
      .map((e) => (e as { data: { type: string } }).data.type);
    const streamCount = result.events.filter(
      (e) => e.kind === "chunk" && (e as { type: string }).type === "stream",
    ).length;

    expect(notifTypes).toContain("consumed");
    expect(notifTypes).toContain("done");
    expect(stagedTypes).toContain("thinking_end");
    expect(stagedTypes).toContain("content_end");
    expect(streamCount).toBeGreaterThan(0);

    // DB 断言：system + user + assistant 消息
    const msgs = dbMessages(chatId);
    const roles = msgs.map((m) => m.role);
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");
    const assistant = msgs.find((m) => m.role === "assistant");
    expect(assistant?.content).toContain("纯文本回复");
  });
});
