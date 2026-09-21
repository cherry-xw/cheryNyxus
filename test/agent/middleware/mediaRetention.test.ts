/**
 * chatMiddleware 多模态多轮保留策略定向测试（P5c）。
 *
 * 覆盖：
 * - 近 MEDIA_RETENTION_TURNS 轮（最后几条带 marker 的 user 消息）图片全程重发（attachments 带 messageId 归属原消息）
 * - 更早轮次的图片转占位文本（模型上下文不再直接看到图，marker 不泄露）
 * - 上下文内重发图片总数上限（>10 张时最旧的转占位）
 * - 单轮新增上限（>5 张时最旧的转占位）
 * - 图片字节上限（累计 >16MB 时最旧的转占位）
 * - 资产缺失：marker 移除但无占位文本
 *
 * 通过 chatMiddleware 端到端触发 enrichMediaInputs（内部函数未导出），
 * 用 mock buildMessages 捕获传给 provider 的 history + attachments。
 */
import { describe, it, expect, vi } from "vitest";
import { chatMiddleware } from "@/agent/middleware/chat.js";
import type { LLMResponse, LLMAttachment } from "@/core/message/adapter.js";
import { SupervisionLevel } from "@/core/config.js";
import {
  createMockContext,
  createMockRuntime,
  mockLLMAdapter,
  mockMessageAdapter,
  mockSenseAdapter,
  makeNext,
} from "../helpers/fakeContext.js";
import { collectChunks } from "../helpers/chunkAssert.js";

const mediaMocks = vi.hoisted(() => ({
  readMediaAsset: vi.fn(),
  understandMediaReference: vi.fn(),
  mediaKindForMime: vi.fn(),
}));

vi.mock("@/service/media/index.js", () => mediaMocks);

const PLACEHOLDER = "[此前上传的图片已从当前上下文移除，如需再次查看请在历史消息中把它重新带入。]";

function msg(id: string, role: "user" | "assistant", content: string): LLMResponse {
  return { id, role, content, createdAt: 0, updateAt: 0 };
}

function runChatMiddleware(messages: LLMResponse[]) {
  let captured: { history: LLMResponse[]; attachments: LLMAttachment[] } | undefined;
  const buildMessages = vi.fn((history: LLMResponse[], attachments?: LLMAttachment[]) => {
    captured = { history, attachments: attachments ?? [] };
    return history;
  });
  const ctx = createMockContext({
    messages,
    runtime: createMockRuntime({
      brain: { capabilities: { input: { image: true, video: false, audio: false } } },
      adapters: {
        llmAdapter: mockLLMAdapter({ chat: vi.fn(async () => ({})) }),
        messageAdapter: mockMessageAdapter({ buildMessages, content: () => "" }),
        senseAdapter: mockSenseAdapter(),
      },
    }),
    global: { stream: false, thinking: false, supervision: SupervisionLevel.auto },
  });
  return { ctx, getCaptured: () => captured };
}

beforeEach(() => {
  mediaMocks.mediaKindForMime.mockImplementation((mime: string) =>
    mime.startsWith("image/") ? "image" : undefined,
  );
  mediaMocks.readMediaAsset.mockImplementation((filename: string) => ({
    data: Buffer.alloc(filename.startsWith("aaaa") ? 9 * 1024 * 1024 : 1024),
    mimeType: "image/png",
  }));
});

describe("chatMiddleware 多模态多轮保留", () => {
  it("近 3 轮带图 user 消息全部重发：attachments 按 messageId 归属，marker 从消息移除", async () => {
    const messages = [
      msg("u1", "user", "看图 [[media:aaa-1.png]]"),
      msg("a1", "assistant", "收到"),
      msg("u2", "user", "再看 [[media:bbb-2.png]]"),
      msg("a2", "assistant", "好"),
      msg("u3", "user", "还看 [[media:ccc-3.png]]"),
    ];
    const { ctx, getCaptured } = runChatMiddleware(messages);
    await collectChunks(chatMiddleware(ctx, makeNext([])));

    const cap = getCaptured()!;
    expect(cap.attachments.map((a) => a.messageId).sort()).toEqual(["u1", "u2", "u3"]);
    // 所有 marker 都已从发给模型的 history 移除（不泄露）
    const joined = cap.history.map((m) => m.content).join("\n");
    expect(joined).not.toContain("[[media:");
    expect(joined).not.toContain(PLACEHOLDER);
  });

  it("超过近 3 轮的更早图片转占位文本，marker 不泄露", async () => {
    const messages = [
      msg("u1", "user", "第一轮 [[media:aaa-1.png]]"),
      msg("a1", "assistant", "ok"),
      msg("u2", "user", "第二轮 [[media:bbb-2.png]]"),
      msg("a2", "assistant", "ok"),
      msg("u3", "user", "第三轮 [[media:ccc-3.png]]"),
      msg("a3", "assistant", "ok"),
      msg("u4", "user", "第四轮 [[media:ddd-4.png]]"),
    ];
    const { ctx, getCaptured } = runChatMiddleware(messages);
    await collectChunks(chatMiddleware(ctx, makeNext([])));

    const cap = getCaptured()!;
    // 最近 3 轮：u2/u3/u4 保留；u1 转占位
    expect(cap.attachments.map((a) => a.messageId).sort()).toEqual(["u2", "u3", "u4"]);
    const u1 = cap.history.find((m) => m.id === "u1")!;
    expect(u1.content).toContain(PLACEHOLDER);
    expect(u1.content).not.toContain("[[media:");
    // 保留轮次消息不含占位文本
    const u2 = cap.history.find((m) => m.id === "u2")!;
    expect(u2.content).not.toContain(PLACEHOLDER);
  });

  it("重发总数超过 10 张时，最旧的转占位", async () => {
    // 3 条消息 × 4 张 = 12 张（都在近 3 轮内）→ 只保留 10 张，最旧消息的 2 张转占位
    const markers = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, i) => `[[media:${prefix}-${i}.png]]`).join(" ");
    const messages = [
      msg("u1", "user", `m1 ${markers("a", 4)}`),
      msg("a1", "assistant", "ok"),
      msg("u2", "user", `m2 ${markers("b", 4)}`),
      msg("a2", "assistant", "ok"),
      msg("u3", "user", `m3 ${markers("c", 4)}`),
    ];
    const { ctx, getCaptured } = runChatMiddleware(messages);
    await collectChunks(chatMiddleware(ctx, makeNext([])));

    const cap = getCaptured()!;
    expect(cap.attachments.length).toBe(10);
    // 最旧消息 u1 应有 2 张被占位（4 - 2 = 2 保留）
    const u1 = cap.history.find((m) => m.id === "u1")!;
    expect((u1.content.match(new RegExp(PLACEHOLDER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length).toBe(2);
    expect(cap.attachments.filter((a) => a.messageId === "u1").length).toBe(2);
    // 后两条消息全部保留
    expect(cap.attachments.filter((a) => a.messageId === "u2").length).toBe(4);
    expect(cap.attachments.filter((a) => a.messageId === "u3").length).toBe(4);
  });

  it("单轮新增超过 5 张时，该轮更早的转占位", async () => {
    // 本轮 6 张 → 只保留 5 张，第 1 张转占位
    const markers = Array.from({ length: 6 }, (_, i) => `[[media:a-${i}.png]]`).join(" ");
    const messages = [msg("u1", "user", `本轮 ${markers}`)];
    const { ctx, getCaptured } = runChatMiddleware(messages);
    await collectChunks(chatMiddleware(ctx, makeNext([])));

    const cap = getCaptured()!;
    expect(cap.attachments.length).toBe(5);
    const u1 = cap.history.find((m) => m.id === "u1")!;
    expect(u1.content).toContain(PLACEHOLDER);
  });

  it("累计字节超过 16MB 时，更旧的转占位", async () => {
    // 两张 aaaa（各 9MB）→ 保留最新（u2），更旧的 u1 超限转占位
    const messages = [
      msg("u1", "user", "[[media:aaaa-1.png]]"),
      msg("a1", "assistant", "ok"),
      msg("u2", "user", "[[media:aaaa-2.png]]"),
    ];
    const { ctx, getCaptured } = runChatMiddleware(messages);
    await collectChunks(chatMiddleware(ctx, makeNext([])));

    const cap = getCaptured()!;
    expect(cap.attachments.map((a) => a.messageId)).toEqual(["u2"]);
    const u1 = cap.history.find((m) => m.id === "u1")!;
    expect(u1.content).toContain(PLACEHOLDER);
  });

  it("资产缺失：marker 移除但不产生占位文本", async () => {
    mediaMocks.readMediaAsset.mockResolvedValueOnce(undefined);
    const messages = [msg("u1", "user", "缺图 [[media:9999.png]]")];
    const { ctx, getCaptured } = runChatMiddleware(messages);
    await collectChunks(chatMiddleware(ctx, makeNext([])));

    const cap = getCaptured()!;
    expect(cap.attachments.length).toBe(0);
    const u1 = cap.history.find((m) => m.id === "u1")!;
    expect(u1.content).not.toContain("[[media:");
    expect(u1.content).not.toContain(PLACEHOLDER);
  });
});
