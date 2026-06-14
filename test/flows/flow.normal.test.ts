/**
 * 正常完整流程测试（docs/interaction.md 流程 A/B/C）。
 *
 * 覆盖：
 * - 流程A：纯文本（content-only，无 sense）
 * - 流程B：auto sense（read_file:auto，自动执行，needsApproval:false）
 * - 流程C-accept：confirm sense（write_file:confirm，accept）
 * - 流程C-reject：confirm sense reject
 *
 * 双重断言：RPC 事件流（docs/websocket.md）+ DB 存储（docs/database.md）
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startApp, stopApp, type AppHandle } from "./helpers/harness.js";
import { FlowRpcClient } from "./helpers/rpcClient.js";
import { dbMessages, dbVisibleMessages } from "./helpers/dbAssert.js";
import {
  summarize,
  findNotification,
  findStaged,
  collectStreamContent,
} from "./helpers/eventsAssert.js";

describe("正常完整流程", () => {
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

  // ===== 流程A：纯文本 =====
  it("流程A：content-only（无 sense 调用）", async () => {
    const chatId = "normal-content";
    await client.call("chat.create", {
      chatId,
      brain: "mock_content",
      senseGroups: ["auto_senses"],
    });

    const flow = client.beginStream("chat.send", { chatId, prompt: "你好" });
    const result = await flow.done();

    expect(result.response.success).toBe(true);
    const s = summarize(result.events);
    expect(s.notifications).toContain("consumed");
    expect(s.notifications).toContain("done");
    expect(s.staged).toContain("thinking_end");
    expect(s.staged).toContain("content_end");
    expect(s.staged).not.toContain("sense_end"); // 纯文本无 sense

    // DB：system + user + assistant
    const msgs = dbMessages(chatId);
    expect(msgs.some((m) => m.role === "user")).toBe(true);
    const assistant = msgs.find((m) => m.role === "assistant");
    expect(assistant?.content).toContain("纯文本回复");
  });

  // ===== 流程B：auto sense =====
  it("流程B：auto sense（read_file:auto，自动执行）", async () => {
    const chatId = "normal-auto";
    await client.call("chat.create", {
      chatId,
      brain: "mock_auto",
      senseGroups: ["auto_senses"],
    });

    const flow = client.beginStream("chat.send", { chatId, prompt: "读文件" });

    // interrupt（auto：needsApproval=false, supervisionLevel=0）
    const interrupt = await flow.waitFor(
      (e) => e.kind === "notification" && (e as { type: string }).type === "interrupt",
    );
    const interruptData = (interrupt as unknown as { data: Record<string, unknown> }).data;
    expect(interruptData.needsApproval).toBe(false);
    expect(interruptData.supervisionLevel).toBe(0); // auto
    expect(interruptData.senseName).toBe("read_file");

    // auto 直接 accept（无需 client 审批）
    const accept = await flow.waitFor(
      (e) => e.kind === "notification" && (e as { type: string }).type === "accept",
    );
    expect((accept as unknown as { data: { senseName: string } }).data.senseName).toBe("read_file");

    const result = await flow.done();
    expect(result.response.success).toBe(true);

    const s = summarize(result.events);
    expect(s.notifications).toContain("consumed");
    expect(s.notifications).toContain("interrupt");
    expect(s.notifications).toContain("accept");
    expect(s.notifications).toContain("done");
    expect(s.staged).toContain("sense_end");

    // DB：assistant(senseCalls) + sense(done read_file 结果) + assistant(第二轮)
    const visible = dbVisibleMessages(chatId);
    const assistantWithSense = visible.find(
      (m) => m.role === "assistant" && m.senseCall && m.senseCall.length > 0,
    );
    expect(assistantWithSense?.senseCall?.[0]?.name).toBe("read_file");

    const senseMsg = visible.find((m) => m.role === "sense");
    expect(senseMsg).toBeDefined();
    expect(senseMsg?.content).toBeTruthy(); // done sense 非空（read_file 结果）
  });

  // ===== 流程C-accept：confirm sense accept =====
  it("流程C-accept：confirm sense（write_file:confirm）→ accept", async () => {
    const chatId = "normal-confirm-accept";
    await client.call("chat.create", {
      chatId,
      brain: "mock_confirm",
      senseGroups: ["confirm_senses"],
    });

    const flow = client.beginStream("chat.send", { chatId, prompt: "写文件" });

    const interrupt = await flow.waitFor(
      (e) => e.kind === "notification" && (e as { type: string }).type === "interrupt",
    );
    const interruptData = (interrupt as unknown as { data: Record<string, unknown> }).data;
    expect(interruptData.needsApproval).toBe(true);
    expect(interruptData.supervisionLevel).toBe(1); // confirm
    const approvalId = interruptData.approvalId as string;

    // 发 accept 审批
    const approvalRes = await client.approval(approvalId, "accept");
    expect(approvalRes.success).toBe(true);

    const accept = await flow.waitFor(
      (e) => e.kind === "notification" && (e as { type: string }).type === "accept",
    );
    expect((accept as unknown as { data: { senseName: string } }).data.senseName).toBe("write_file");

    const result = await flow.done();
    expect(result.response.success).toBe(true);

    // DB：sense 消息 done（write_file 执行结果）
    const visible = dbVisibleMessages(chatId);
    const senseMsg = visible.find((m) => m.role === "sense");
    expect(senseMsg?.content).toBeTruthy();
  });

  // ===== 流程C-reject：confirm sense reject =====
  it("流程C-reject：confirm sense → reject", async () => {
    const chatId = "normal-confirm-reject";
    await client.call("chat.create", {
      chatId,
      brain: "mock_confirm_reject",
      senseGroups: ["confirm_senses"],
    });

    const flow = client.beginStream("chat.send", { chatId, prompt: "写文件" });

    const interrupt = await flow.waitFor(
      (e) => e.kind === "notification" && (e as { type: string }).type === "interrupt",
    );
    const approvalId = (interrupt as unknown as { data: { approvalId: string } }).data.approvalId;

    await client.approval(approvalId, "reject", "危险操作");

    const rejected = await flow.waitFor(
      (e) => e.kind === "notification" && (e as { type: string }).type === "rejected",
    );
    expect((rejected as unknown as { data: { reason: string } }).data.reason).toContain("危险操作");

    const result = await flow.done();
    expect(result.response.success).toBe(true);

    const s = summarize(result.events);
    expect(s.notifications).toContain("rejected");
    expect(s.notifications).toContain("done");
    // reject 后仍走第二轮 LLM（loop 继续），有第二轮 content
    const contentEnds = result.events.filter(
      (e) => e.kind === "chunk" && (e as { type: string }).type === "staged"
        && (e as { data: { type: string } }).data.type === "content_end",
    );
    expect(contentEnds.length).toBeGreaterThanOrEqual(1);
  });
});
