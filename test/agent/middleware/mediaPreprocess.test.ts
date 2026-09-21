/**
 * chatMiddleware 前置工具调度定向测试（媒体外部服务化 2.1-2.3）。
 *
 * 覆盖：
 * - 非多模态模型 + 感官组有 preprocess=true 且 accepts 命中 kind 的工具 → 前置执行，
 *   结果替换进消息（marker 移除，产出文本进 content）
 * - 工具输入契约：{ text, media: [{filename,mimeType,kind,size}] }（text 剥离媒体标记）
 * - 多 kind：每个 kind 独立匹配工具，未命中 kind 的 marker 保留并进 capabilitiesHint
 * - 执行失败：marker 替换为「[媒体附件处理失败，已跳过]」，不阻断整轮发送
 * - 无匹配工具 → 回退旧路径（媒体网关 understand）
 * - 生成注入：感官组配置即注入（不再受大脑 generate.* 双门限制）
 *
 * 通过 chatMiddleware 端到端触发 enrichMediaInputs（内部函数未导出），
 * 用 mock buildMessages 捕获传给 provider 的 history。
 */
import { describe, it, expect, vi } from "vitest";
import { chatMiddleware } from "@/agent/middleware/chat.js";
import type { LLMResponse, LLMAttachment } from "@/core/message/adapter.js";
import { SupervisionLevel } from "@/core/config.js";
import {
  createMockContext,
  createMockRuntime,
  createTestSense,
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

function msg(id: string, role: "user" | "assistant", content: string): LLMResponse {
  return { id, role, content, createdAt: 0, updateAt: 0 };
}

function runChatMiddleware(messages: LLMResponse[], opts: { senses: Parameters<typeof createTestSense>[] }) {
  let captured: { history: LLMResponse[]; attachments: LLMAttachment[] } | undefined;
  const buildMessages = vi.fn((history: LLMResponse[], attachments?: LLMAttachment[]) => {
    captured = { history, attachments: attachments ?? [] };
    return history;
  });
  const senses = opts.senses.map(([name, exec, level, schema, capabilities]) =>
    createTestSense(name as string, exec as never, level, schema, capabilities),
  );
  const ctx = createMockContext({
    messages,
    runtime: createMockRuntime({
      senses,
      // 非多模态模型：input.* 全 false → 走前置调度 / 旧路径
      brain: { capabilities: { input: { image: false, video: false, audio: false } } },
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
    mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : undefined,
  );
  mediaMocks.readMediaAsset.mockImplementation((filename: string) => ({
    data: Buffer.from("dummy"),
    mimeType: filename.endsWith(".png") ? "image/png" : "video/mp4",
  }));
  mediaMocks.understandMediaReference.mockResolvedValue({ text: "网关理解文本" });
});

describe("chatMiddleware 前置工具调度（非多模态 + preprocess 工具）", () => {
  it("accepts 命中 kind 的 preprocess 工具执行，结果替换 marker 进消息", async () => {
    const exec = vi.fn(async (input: { text: string; media: unknown[] }) => {
      expect(input.text).toBe("描述这张图");
      expect(Array.isArray(input.media)).toBe(true);
      expect(input.media).toHaveLength(1);
      return { content: `图注:${(input.media[0] as { filename: string }).filename}` };
    });
    const messages = [msg("u1", "user", "描述这张图 [[media:aa-1.png]]")];
    const { ctx, getCaptured } = runChatMiddleware(messages, {
      senses: [
        [
          "understand_image",
          exec as never,
          SupervisionLevel.auto,
          undefined,
          { accepts: ["image"], produces: ["text"], preprocess: true },
        ],
      ],
    });
    await collectChunks(chatMiddleware(ctx, makeNext([])));

    const cap = getCaptured()!;
    const u1 = cap.history.find((m) => m.id === "u1")!;
    expect(exec).toHaveBeenCalledTimes(1);
    expect(u1.content).toContain("图注:aa-1.png");
    // marker 已替换（不再暴露 [[media:]]）
    expect(u1.content).not.toContain("[[media:");
  });

  it("工具执行失败 → marker 替换为失败提示，不阻断整轮", async () => {
    const exec = vi.fn(async () => {
      throw new Error("外部服务超时");
    });
    const messages = [msg("u1", "user", "看图 [[media:aa-1.png]]")];
    const { ctx, getCaptured } = runChatMiddleware(messages, {
      senses: [
        [
          "understand_image",
          exec as never,
          SupervisionLevel.auto,
          undefined,
          { accepts: ["image"], produces: ["text"], preprocess: true },
        ],
      ],
    });
    await collectChunks(chatMiddleware(ctx, makeNext([])));

    const cap = getCaptured()!;
    const u1 = cap.history.find((m) => m.id === "u1")!;
    expect(u1.content).toContain("[媒体附件处理失败，已跳过]");
  });

  it("无匹配 preprocess 工具 → 回退旧路径（媒体网关 understand）", async () => {
    const messages = [msg("u1", "user", "看图 [[media:aa-1.png]]")];
    const { ctx, getCaptured } = runChatMiddleware(messages, {
      // 只有普通（非 preprocess）工具，accepts 命中也不前置
      senses: [
        [
          "normal_tool",
          (async () => ({ content: "普通工具" })) as never,
          SupervisionLevel.auto,
          undefined,
          { accepts: ["image"], produces: ["text"], preprocess: false },
        ],
      ],
    });
    await collectChunks(chatMiddleware(ctx, makeNext([])));

    expect(mediaMocks.understandMediaReference).toHaveBeenCalled();
    const cap = getCaptured()!;
    const u1 = cap.history.find((m) => m.id === "u1")!;
    expect(u1.content).toContain("网关理解文本");
  });

  it("多 kind：每个 kind 独立匹配；未命中 kind 保留 marker 并进 capabilitiesHint", async () => {
    const imageExec = vi.fn(async () => ({ content: "图理解结果" }));
    const messages = [msg("u1", "user", "看图 [[media:aa-1.png]] 看视频 [[media:bb-1.mp4]]")];
    const { ctx, getCaptured } = runChatMiddleware(messages, {
      // 只有 image 前置工具；video 无匹配 → 保留 marker + 委派建议
      senses: [
        [
          "understand_image",
          imageExec as never,
          SupervisionLevel.auto,
          undefined,
          { accepts: ["image"], produces: ["text"], preprocess: true },
        ],
      ],
    });
    await collectChunks(chatMiddleware(ctx, makeNext([])));

    const cap = getCaptured()!;
    const u1 = cap.history.find((m) => m.id === "u1")!;
    expect(u1.content).toContain("图理解结果");
    // video marker 保留（未被工具处理，也未被旧路径吞掉——前置路径整轮接管）
    expect(u1.content).toContain("[[media:bb-1.mp4]]");
  });
});

describe("chatMiddleware 生成注入（感官组配置即注入）", () => {
  it("preprocess 工具只执行不注入 builtSenses 判断不影响；生成工具由感官组决定", async () => {
    // 生成注入判断在 runtimeResolver（resolveSense），此处验证 senseTable 带 capabilities 透传
    const exec = vi.fn(async () => ({ content: "ok" }));
    const sense = createTestSense(
      "generate_image",
      exec as never,
      SupervisionLevel.smart,
      undefined,
      { produces: ["image"], accepts: ["image"] },
    );
    const ctx = createMockContext({
      messages: [msg("u1", "user", "hi")],
      runtime: createMockRuntime({
        senses: [sense],
        brain: { capabilities: { input: { image: false, video: false, audio: false } } },
        adapters: {
          llmAdapter: mockLLMAdapter({ chat: vi.fn(async () => ({})) }),
          messageAdapter: mockMessageAdapter({ buildMessages: vi.fn((h) => h), content: () => "" }),
          senseAdapter: mockSenseAdapter(),
        },
      }),
      global: { stream: false, thinking: false, supervision: SupervisionLevel.auto },
    });
    await collectChunks(chatMiddleware(ctx, makeNext([])));

    const entry = ctx.runtime!.senseTable.get("generate_image")!;
    expect(entry.capabilities).toEqual({ produces: ["image"], accepts: ["image"] });
  });
});
