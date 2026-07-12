/**
 * 恢复流程测试（docs/interaction.md 流程 D + chat.resume + chat.send 撤回）。
 *
 * 覆盖：
 * - 不完整流程：confirm pending 中断 → chat.get canResume:true + DB pending sense 语义
 * - 恢复继续流程：chat.resume Case1（末尾 pending sense）→ 重发 interrupt → 审批 → 完成
 * - 恢复响应回滚流程：chat.get 恢复场景 → chat.send 触发 staged.reverse + DB revoked
 *
 * pending 构造：发 confirm send，收到 interrupt 后关闭连接（模拟中断/超时），
 * server connectionManager.close → abort approval → pending sense 保持 content=NULL。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startApp, stopApp, type AppHandle } from "./helpers/harness.js";
import { FlowRpcClient } from "./helpers/rpcClient.js";
import { dbMessages, isPendingSense } from "./helpers/dbAssert.js";
import { summarize } from "./helpers/eventsAssert.js";
import { clearChatRuntime } from "@/service/chat/runtime.js";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 创建一个 confirm pending chat：发 send 等 interrupt 后关闭连接（不审批）。
 * 关闭后 server abort approval，pending sense 保留 content=NULL。
 */
async function createPendingChat(app: AppHandle, chatId: string, brain: string): Promise<void> {
  const c = new FlowRpcClient(app.url);
  await c.connect();
  await c.call("chat.create", { chatId, brain, senseGroup: "confirm_senses" });
  const flow = c.beginStream("chat.send", { chatId, prompt: "写文件" });
  await flow.waitFor(
    (e) => e.kind === "notification" && (e as { type: string }).type === "interrupt",
  );
  c.close();
  // 等 server 检测 close → connectionManager.close → abort approval
  await delay(300);
}

describe("恢复流程", () => {
  let app: AppHandle;

  beforeAll(async () => {
    app = await startApp();
  });

  afterAll(async () => {
    await stopApp(app);
  });

  // ===== 不完整流程：canResume =====
  it("不完整流程：confirm pending 中断 → chat.get canResume:true", async () => {
    const chatId = "recover-main";
    await createPendingChat(app, chatId, "mock_recover_2");

    // DB 断言：abort 后 assistant 已自动落库（问题2 修复：observer finally flush 兜底，
    // checkpoint finally 的 assistant effect 在 gen.return() 时不被消费，由 observer finally 同步落库）
    const msgs = dbMessages(chatId);
    const visible = msgs.filter((m) => !m.revoked);
    const assistantMsgs = visible.filter((m) => m.role === "assistant");
    expect(assistantMsgs.length).toBeGreaterThan(0);
    // abort 前已产生的 assistant 含 write_file senseCall（revokeTrailingCycle 前置条件）
    expect(assistantMsgs[assistantMsgs.length - 1]!.senseCall?.length).toBeGreaterThan(0);
    // 末条为 pending sense（content 空）
    const last = visible[visible.length - 1];
    expect(last?.role).toBe("sense");
    expect(isPendingSense(last!)).toBe(true); // role=sense 且 content 空

    // chat.get 流式回显历史 + canResume
    const c = new FlowRpcClient(app.url);
    await c.connect();
    const flow = c.beginStream("chat.get", { chatId });
    const result = await flow.done();

    expect(result.response.success).toBe(true);
    expect((result.response.data as { canResume: boolean }).canResume).toBe(true);

    // chat.get 事件：历史 staged（含 role）+ loaded notification
    const s = summarize(result.events);
    expect(s.notifications).toContain("loaded");
    expect(s.staged).toContain("sense_end"); // pending sense 历史回显
    c.close();
  });

  // ===== 恢复继续流程：resume Case1 =====
  it("恢复继续：chat.resume Case1（末尾 pending sense）→ 重发 interrupt → 审批 → 完成", async () => {
    // 复用上一个测试创建的 pending chat（recover-main）
    const chatId = "recover-main";
    // abort 后旧 generator 挂起（isRunningFlag 残留），清 runtime 缓存重建 builder
    // 模拟 docs 流程D：服务重启后 chat.create 重建 runtime（isRunningFlag 复位）
    clearChatRuntime(chatId);
    const c = new FlowRpcClient(app.url);
    await c.connect();
    // runtime.set 重建 runtime（ensureChat 新 builder + loadHistory pending），不 createChat 避免冲突
    await c.call("runtime.set", { chatId, brain: "mock_recover_2", senseGroup: "confirm_senses" });

    const flow = c.beginStream("chat.resume", { chatId });

    // Case1：pending sense 重发 interrupt（confirm，needsApproval:true）
    const interrupt = await flow.waitFor(
      (e) => e.kind === "notification" && (e as { type: string }).type === "interrupt",
    );
    const interruptData = (interrupt as unknown as { data: Record<string, unknown> }).data;
    expect(interruptData.needsApproval).toBe(true);
    const approvalId = interruptData.approvalId as string;

    // 审批 accept → 恢复执行
    await c.approval(approvalId, "accept");
    await flow.waitFor(
      (e) => e.kind === "notification" && (e as { type: string }).type === "accept",
    );

    // DB 断言：原 pending sense 被填充（content 非空，done）
    // accept notification 在 recovery update（fillApprovalResult）之后发出，此时 DB 已更新
    const msgs = dbMessages(chatId);
    const senseMsgs = msgs.filter((m) => m.role === "sense");
    const filledSense = senseMsgs.find((m) => m.content && m.content.length > 0);
    expect(filledSense).toBeDefined(); // pending → done

    // resume 后 loop 第二轮 LLM：messages 含 abort 前落库的 assistant(senseCalls)，
    // mock 索引 assistant count=1 → script[1] content（问题3 随问题2 修复：assistant 落库后
    // 索引正确推进，不再重放 turn0 触发二次 confirm）。await done 验证完整恢复链路。
    await flow.waitFor(
      (e) => e.kind === "notification" && (e as { type: string }).type === "done",
    );
    const result = await flow.done();
    expect(result.response.success).toBe(true);
    c.close();
  });

  // ===== 恢复响应回滚流程：chat.send staged.reverse =====
  it("恢复响应回滚：chat.get 恢复场景 → chat.send 触发 staged.reverse + DB revoked", async () => {
    const chatId = "recover-revoke";
    // 真实 abort 流程：send confirm → interrupt → 关闭。
    // 问题2 修复后 assistant 自动落库，revokeTrailingCycle 能找到前置 assistant(senseCalls)。
    await createPendingChat(app, chatId, "mock_recover_3");

    // 验证 abort 后 DB 含未撤回的 assistant(senseCalls)（revokeTrailingCycle 前置条件）
    const beforeMsgs = dbMessages(chatId);
    const beforeAssistant = beforeMsgs.filter((m) => m.role === "assistant" && !m.revoked);
    expect(beforeAssistant.length).toBeGreaterThan(0);

    clearChatRuntime(chatId);
    const c = new FlowRpcClient(app.url);
    await c.connect();
    await c.call("runtime.set", { chatId, brain: "mock_recover_3", senseGroup: "confirm_senses" });
    const flow = c.beginStream("chat.send", { chatId, prompt: "重新处理" });

    // 撤回 chunk（staged type=reverse, messageIds）
    const reverse = await flow.waitFor(
      (e) =>
        e.kind === "chunk" &&
        (e as { type: string }).type === "staged" &&
        (e as { data: { type: string } }).data.type === "reverse",
    );
    const reverseData = (reverse as unknown as { data: { messageIds: string[] } }).data;
    expect(reverseData.messageIds.length).toBeGreaterThan(0);

    // 撤回后重跑触发 confirm interrupt（turn0 重放）→ accept 让流程完成
    const interrupt = await flow.waitFor(
      (e) => e.kind === "notification" && (e as { type: string }).type === "interrupt",
    );
    const approvalId = (interrupt as unknown as { data: { approvalId: string } }).data.approvalId;
    await c.approval(approvalId, "accept");
    await flow.waitFor(
      (e) => e.kind === "notification" && (e as { type: string }).type === "done",
    );

    const result = await flow.done();
    expect(result.response.success).toBe(true);

    // DB 断言：被撤回的消息 revoked=1（assistant + pending sense，整个周期）
    const msgs = dbMessages(chatId);
    const revoked = msgs.filter((m) => m.revoked);
    expect(revoked.length).toBeGreaterThanOrEqual(2);
    const s = summarize(result.events);
    expect(s.staged).toContain("reverse");
    c.close();
  });
});
