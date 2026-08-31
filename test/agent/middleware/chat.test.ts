/**
 * chatMiddleware 单元测试。
 *
 * 覆盖：
 * - runtime 未配置 → throw
 * - 流式分支：chatStream + extract → yield StreamChunk（content/thinking/senseDelta）
 * - 非流式分支：chat + content/thinking
 * - buildMessages 调用（filter revoked）
 * - 空 response → 不 yield stream
 * - 下游 next() 透传
 */
import { describe, it, expect, vi } from "vitest";
import { chatMiddleware } from "@/agent/middleware/chat.js";
import type { MiddlewareChunk, StreamChunk } from "@/core/middleware/types.js";
import { SupervisionLevel } from "@/core/config.js";
import {
  createMockContext,
  createMockRuntime,
  mockLLMAdapter,
  mockMessageAdapter,
  mockSenseAdapter,
  makeNext,
} from "../helpers/fakeContext.js";
import { collectChunks, collectContent, collectThinking } from "../helpers/chunkAssert.js";

function asyncIter<T>(items: T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const it of items) yield it;
    },
  };
}

function userMessages() {
  return [{ id: "u", role: "user" as const, content: "hello", createdAt: 0, updateAt: 0 }];
}

describe("chatMiddleware runtime 校验", () => {
  it("runtime 未配置 → throw", async () => {
    const ctx = createMockContext({});
    ctx.runtime = undefined;
    await expect(collectChunks(chatMiddleware(ctx, makeNext([])))).rejects.toThrow(
      "Runtime not configured",
    );
  });
});

describe("chatMiddleware 流式分支", () => {
  it("chatStream content delta → yield stream", async () => {
    const llm = mockLLMAdapter({
      chatStream: vi.fn(async () => asyncIter([{ d: "Hello" }, { d: " world" }])),
    });
    const msg = mockMessageAdapter({
      extractStreamDelta: (raw: { d: string }) => raw.d,
    });
    const sense = mockSenseAdapter();
    const ctx = createMockContext({
      messages: userMessages(),
      runtime: createMockRuntime({ adapters: { llmAdapter: llm, messageAdapter: msg, senseAdapter: sense } }),
      global: { stream: true, thinking: false, supervision: SupervisionLevel.auto },
    });
    const out = await collectChunks(chatMiddleware(ctx, makeNext([])));
    expect(out.some((c) => c.type === "stream")).toBe(true);
    expect(collectContent(out)).toBe("Hello world");
    expect(llm.chatStream).toHaveBeenCalled();
  });

  it("chatStream thinking delta → yield stream with thinking", async () => {
    const llm = mockLLMAdapter({
      chatStream: vi.fn(async () => asyncIter([{ t: "hmm" }])),
    });
    const msg = mockMessageAdapter({
      extractStreamDelta: () => "",
      extractStreamThinking: (raw: { t: string }) => raw.t,
    });
    const ctx = createMockContext({
      messages: userMessages(),
      runtime: createMockRuntime({ adapters: { llmAdapter: llm, messageAdapter: msg, senseAdapter: mockSenseAdapter() } }),
      global: { stream: true, thinking: false, supervision: SupervisionLevel.auto },
    });
    const out = await collectChunks(chatMiddleware(ctx, makeNext([])));
    expect(collectThinking(out)).toBe("hmm");
  });

  it("chatStream senseDelta → yield stream with senseDelta", async () => {
    const llm = mockLLMAdapter({
      chatStream: vi.fn(async () => asyncIter([{ x: 1 }])),
    });
    const msg = mockMessageAdapter({ extractStreamDelta: () => "" });
    const sense = mockSenseAdapter({
      extractSenseCallDeltas: () => [{ index: 0, id: "t1", name: "read_file", arguments: "{}" }],
    });
    const ctx = createMockContext({
      messages: userMessages(),
      runtime: createMockRuntime({ adapters: { llmAdapter: llm, messageAdapter: msg, senseAdapter: sense } }),
      global: { stream: true, thinking: false, supervision: SupervisionLevel.auto },
    });
    const out = await collectChunks(chatMiddleware(ctx, makeNext([])));
    const streams = out.filter((c): c is StreamChunk => c.type === "stream");
    expect(streams.some((s) => s.senseDelta && s.senseDelta.length > 0)).toBe(true);
  });

  it("空 stream（无任何 delta）→ 不 yield stream", async () => {
    const llm = mockLLMAdapter({
      chatStream: vi.fn(async () => asyncIter([{ noop: 1 }, { noop: 2 }])),
    });
    const msg = mockMessageAdapter({ extractStreamDelta: () => "" });
    const ctx = createMockContext({
      messages: userMessages(),
      runtime: createMockRuntime({ adapters: { llmAdapter: llm, messageAdapter: msg, senseAdapter: mockSenseAdapter() } }),
      global: { stream: true, thinking: false, supervision: SupervisionLevel.auto },
    });
    const out = await collectChunks(chatMiddleware(ctx, makeNext([])));
    expect(out.some((c) => c.type === "stream")).toBe(false);
  });
});

describe("chatMiddleware 非流式分支", () => {
  it("chat → content + thinking → yield 单 stream", async () => {
    const llm = mockLLMAdapter({
      chat: vi.fn(async () => ({ c: "full reply", t: "thought" })),
    });
    const msg = mockMessageAdapter({
      content: (raw: { c: string }) => raw.c,
      thinking: (raw: { t: string }) => raw.t,
    });
    const ctx = createMockContext({
      messages: userMessages(),
      runtime: createMockRuntime({ adapters: { llmAdapter: llm, messageAdapter: msg, senseAdapter: mockSenseAdapter() } }),
      global: { stream: false, thinking: false, supervision: SupervisionLevel.auto },
    });
    const out = await collectChunks(chatMiddleware(ctx, makeNext([])));
    const streams = out.filter((c): c is StreamChunk => c.type === "stream");
    expect(streams.length).toBe(1);
    expect(streams[0]!.contentDelta).toBe("full reply");
    expect(streams[0]!.thinkingDelta).toBe("thought");
    expect(llm.chat).toHaveBeenCalled();
  });

  it("chat → senseCalls（非流式完整）→ yield stream with senseDelta", async () => {
    const llm = mockLLMAdapter({
      chat: vi.fn(async () => ({ resp: 1 })),
    });
    const msg = mockMessageAdapter({ content: () => "" });
    const sense = mockSenseAdapter({
      senseCalls: () => [{ index: 0, id: "t1", name: "read_file", arguments: "{}" }],
    });
    const ctx = createMockContext({
      messages: userMessages(),
      runtime: createMockRuntime({ adapters: { llmAdapter: llm, messageAdapter: msg, senseAdapter: sense } }),
      global: { stream: false, thinking: false, supervision: SupervisionLevel.auto },
    });
    const out = await collectChunks(chatMiddleware(ctx, makeNext([])));
    const streams = out.filter((c): c is StreamChunk => c.type === "stream");
    expect(streams.length).toBe(1);
    expect(streams[0]!.senseDelta?.[0]?.name).toBe("read_file");
  });
});

describe("chatMiddleware buildMessages 与下游", () => {
  it("buildMessages 被调用且过滤 revoked", async () => {
    // 模拟真实 adapter：buildMessages 过滤 revoked
    const buildMessages = vi.fn((history: Array<{ revoked?: boolean }>) =>
      history.filter((m) => !m.revoked),
    );
    const msg = mockMessageAdapter({ extractStreamDelta: () => "c", buildMessages });
    const llm = mockLLMAdapter({ chatStream: vi.fn(async () => asyncIter([{ d: "c" }])) });
    const ctx = createMockContext({
      runtime: createMockRuntime({ adapters: { llmAdapter: llm, messageAdapter: msg, senseAdapter: mockSenseAdapter() } }),
      messages: [
        { id: "u", role: "user", content: "hi", createdAt: 0, updateAt: 0 },
        { id: "r", role: "assistant", content: "old", createdAt: 0, updateAt: 0, revoked: true },
      ],
      global: { stream: true, thinking: false, supervision: SupervisionLevel.auto },
    });
    await collectChunks(chatMiddleware(ctx, makeNext([])));
    expect(buildMessages).toHaveBeenCalled();
    // chat 把完整 messages（含 revoked）交给 adapter，过滤是 adapter 职任（见 provider 测试）
    const input = buildMessages.mock.calls[0]![0] as Array<{ revoked?: boolean }>;
    expect(input.length).toBe(2);
    expect(input.some((m) => m.revoked)).toBe(true);
  });

  it("透传下游 next() chunks", async () => {
    const llm = mockLLMAdapter({ chatStream: vi.fn(async () => asyncIter([{ d: "c" }])) });
    const msg = mockMessageAdapter({ extractStreamDelta: () => "c" });
    const ctx = createMockContext({
      messages: userMessages(),
      runtime: createMockRuntime({ adapters: { llmAdapter: llm, messageAdapter: msg, senseAdapter: mockSenseAdapter() } }),
      global: { stream: true, thinking: false, supervision: SupervisionLevel.auto },
    });
    const out = await collectChunks(chatMiddleware(ctx, makeNext([{ type: "done" } as MiddlewareChunk])));
    expect(out.some((c) => c.type === "done")).toBe(true);
  });
});
