/**
 * user in loop 流程测试：loop 运行中用户再次输入。
 *
 * 验证 send.ts:57 `isRunning()` 短路入队语义：
 * - 第一条 chat.send 触发 loop（confirm write_file 卡审批 = 确定性 isRunning 窗口）
 * - 第二条 chat.send 到达时 isRunning=true → 仅入队 ctx.soul.userInputs，非流式响应
 * - accept 审批后 loop 继续，下轮 checkpoint 消费第二条 user（[checkpoint.ts:28-67]）
 * - 断言：双 consumed notification + DB 双 user + 第二条 send 非流式 success
 *
 * requestId 冲突处理：第二条 send 用 UUID（非 chatId），与第一条 flow 的 pending state 隔离。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "crypto";
import { startApp, stopApp, type AppHandle } from "./helpers/harness.js";
import { FlowRpcClient } from "./helpers/rpcClient.js";
import { dbVisibleMessages } from "./helpers/dbAssert.js";

describe("user in loop 流程", () => {
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

  it("运行中再 send → 入队 → 下轮 checkpoint 消费 → DB 双 user", async () => {
    const chatId = "userloop-1";
    await client.call("chat.create", {
      chatId,
      brain: "mock_userloop",
      senseGroups: ["confirm_senses"],
    });

    // 第一条 send：开流但不 await done
    const flow = client.beginStream("chat.send", { chatId, prompt: "第一条消息" });

    // 等 confirm interrupt（轮2 write_file）卡住 loop → isRunning=true 窗口
    const interrupt = await flow.waitFor(
      (e) => e.kind === "notification" && (e as { type: string }).type === "interrupt",
    );
    expect(interrupt).toBeDefined();
    const approvalId = (interrupt as unknown as { data: { approvalId: string } }).data.approvalId;

    // 第二条 send：运行中 → isRunning 短路入队，非流式响应。
    // 用 UUID 作 requestId，避免与第一条 flow（id=chatId）pending state 冲突。
    const secondRes = await client.call(
      "chat.send",
      { chatId, prompt: "第二条消息" },
      randomUUID(),
    );
    expect(secondRes.success).toBe(true);

    // accept 审批 → loop 继续（iter3），checkpoint 消费第二条 user
    await client.approval(approvalId, "accept");

    const result = await flow.done();
    expect(result.response.success).toBe(true);

    // 第一条 flow events 含 2 个 consumed：
    // iter1 消费「第一条消息」(count=1) + iter3 消费「第二条消息」(count=1)
    const consumeds = result.events.filter(
      (e) => e.kind === "notification" && (e as { type: string }).type === "consumed",
    );
    expect(consumeds.length).toBe(2);

    // done 必达
    const dones = result.events.filter(
      (e) => e.kind === "notification" && (e as { type: string }).type === "done",
    );
    expect(dones.length).toBe(1);

    // DB 双 user，内容可见（未撤回）
    const visible = dbVisibleMessages(chatId);
    const users = visible.filter((m) => m.role === "user");
    expect(users.length).toBe(2);
    expect(users.some((m) => m.content === "第一条消息")).toBe(true);
    expect(users.some((m) => m.content === "第二条消息")).toBe(true);
  });
});
