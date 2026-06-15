/**
 * mock provider 测试（补全）：adapter 配置 + 脚本回放 LLM。
 *
 * 复用 flows/fixtures/.chery config（mock brain + 脚本），全局 setupFiles 已设 CHERY_DIR。
 *
 * 覆盖：
 * - registerMockAdapter 注册
 * - message adapter：content / thinking / extractStream / buildMessages（过滤 revoked）
 * - sense adapter：buildSenses / senseCalls / extractSenseCallDeltas
 * - LLM：chat 脚本回放 / chatStream / error 脚本 throw / 轮次索引（assistant 数）
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { rmSync } from "fs";
import { resolve } from "path";
import { registerMockAdapter } from "@/agent/provider/mock.js";
import { getLLMAdapter, resetLLMAdapters } from "@/core/llm/adapter.js";
import { getMessageAdapter, resetMessageProviders } from "@/core/message/adapter.js";
import { getSenseAdapter, senseAdapterRegistry } from "@/core/sense/adapter.js";
import type { LLMResponse } from "@/core/message/adapter.js";
import type { Sense, SenseFunction } from "@/core/sense/index.js";
import type { ZodType } from "zod";
import { addMockBrain, scriptItem } from "../helpers/mockScripts.js";

const mockDir = resolve(process.env.CHERY_DIR ?? "", ".chery", "mock");

describe("mock provider 注册", () => {
  beforeEach(() => {
    resetMessageProviders();
    resetLLMAdapters();
    senseAdapterRegistry.clear();
  });

  it("注册 message/sense/llm adapter", () => {
    registerMockAdapter();
    expect(getLLMAdapter("mock")).toBeDefined();
    expect(getMessageAdapter("mock")).toBeDefined();
    expect(getSenseAdapter("mock")).toBeDefined();
  });
});

describe("mock message adapter", () => {
  beforeEach(() => {
    resetMessageProviders();
    resetLLMAdapters();
    senseAdapterRegistry.clear();
    registerMockAdapter();
  });

  it("content / thinking 提取", () => {
    const cfg = getMessageAdapter("mock")!;
    expect(cfg.content({ content: "x" } as never)).toBe("x");
    expect(cfg.content({} as never)).toBe("");
    expect(cfg.thinking?.({ thinking: "t" } as never)).toBe("t");
  });

  it("extractStreamDelta / Thinking", () => {
    const cfg = getMessageAdapter("mock")!;
    expect(cfg.extractStreamDelta({ content: "d" } as never)).toBe("d");
    expect(cfg.extractStreamThinking?.({ thinking: "st" } as never)).toBe("st");
  });

  it("buildMessages 过滤 revoked（透传 LLMResponse）", () => {
    const cfg = getMessageAdapter("mock")!;
    const history: LLMResponse[] = [
      { id: "a", role: "user", content: "keep", createdAt: 0, updateAt: 0 },
      { id: "r", role: "user", content: "gone", createdAt: 0, updateAt: 0, revoked: true },
    ];
    const out = cfg.buildMessages(history) as LLMResponse[];
    expect(out.length).toBe(1);
    expect(out[0]!.id).toBe("a");
  });
});

describe("mock sense adapter", () => {
  beforeEach(() => {
    resetMessageProviders();
    resetLLMAdapters();
    senseAdapterRegistry.clear();
    registerMockAdapter();
  });

  it("buildSenses", () => {
    const cfg = getSenseAdapter("mock")!;
    const senses = [{
      definition: { type: "function" as const, function: { name: "t", description: "d", parameters: { type: "object", properties: {}, required: [], additionalProperties: false } } },
      executor: { schema: {} as ZodType, execute: async () => ({ content: "", hash: "" }) },
      supervisionLevel: undefined,
    }] as Sense<ZodType>[];
    const built = cfg.buildSenses(senses) as SenseFunction[];
    expect(built[0]!.function.name).toBe("t");
  });

  it("senseCalls / extractSenseCallDeltas", () => {
    const cfg = getSenseAdapter("mock")!;
    const out = cfg.senseCalls({ toolCalls: [{ index: 0, id: "x", name: "t", arguments: "{}" }] } as never);
    expect(out[0]!.id).toBe("x");
    expect(out[0]!.name).toBe("t");
    const deltas = cfg.extractSenseCallDeltas({ toolCalls: [{ index: 0, id: "y", name: "t2", arguments: "{}" }] } as never);
    expect(deltas[0]!.id).toBe("y");
  });
});

describe("mock LLM adapter 脚本回放", () => {
  beforeAll(() => {
    resetMessageProviders();
    resetLLMAdapters();
    senseAdapterRegistry.clear();
    registerMockAdapter();
  });
  afterAll(() => {
    // 清理动态注入的 _agent_ 脚本，避免污染 fixtures
    try {
      rmSync(resolve(mockDir, "_agent_mock-err.yaml"), { force: true });
      rmSync(resolve(mockDir, "_agent_mock-2turn.yaml"), { force: true });
    } catch { /* ignore */ }
  });

  it("chat 回放 mock_content 脚本（turn 0）", async () => {
    const llm = getLLMAdapter("mock")!;
    const r = await llm.chat([], [], { model: "mock_content" });
    expect((r as { content?: string }).content).toContain("纯文本回复");
  });

  it("chatStream 回放（thinking + content chunk）", async () => {
    const llm = getLLMAdapter("mock")!;
    const stream = await llm.chatStream([], [], { model: "mock_content" });
    const contents: string[] = [];
    const thinkings: string[] = [];
    for await (const c of stream as AsyncIterable<{ content?: string; thinking?: string }>) {
      if (c.content) contents.push(c.content);
      if (c.thinking) thinkings.push(c.thinking);
    }
    expect(contents.join("")).toContain("纯文本回复");
    expect(thinkings.length).toBeGreaterThan(0);
  });

  it("error 脚本 → throw", async () => {
    addMockBrain("mock-err", { repeat: "last", script: [scriptItem({ error: "boom-error" })] });
    const llm = getLLMAdapter("mock")!;
    await expect(llm.chat([], [], { model: "mock-err" })).rejects.toThrow("boom-error");
  });

  it("轮次索引 = assistant 数量（多轮脚本）", async () => {
    addMockBrain("mock-2turn", {
      repeat: "last",
      script: [scriptItem({ content: "turn0" }), scriptItem({ content: "turn1" })],
    });
    const llm = getLLMAdapter("mock")!;
    const r0 = await llm.chat([{ id: "x", role: "user", content: "u", createdAt: 0, updateAt: 0 }], [], { model: "mock-2turn" });
    expect((r0 as { content?: string }).content).toBe("turn0");
    // 第二次调用：messages 含 1 个 assistant → index=1 → turn1
    const r1 = await llm.chat(
      [
        { id: "x", role: "user", content: "u", createdAt: 0, updateAt: 0 },
        { id: "a", role: "assistant", content: "turn0", createdAt: 0, updateAt: 0 },
      ],
      [],
      { model: "mock-2turn" },
    );
    expect((r1 as { content?: string }).content).toBe("turn1");
  });

  it("脚本耗尽（无 repeat:last）→ 空 content", async () => {
    addMockBrain("mock-exhaust", { script: [scriptItem({ content: "only" })] });
    const llm = getLLMAdapter("mock")!;
    const r0 = await llm.chat([], [], { model: "mock-exhaust" });
    expect((r0 as { content?: string }).content).toBe("only");
    // 第二次：index=1 超出 script.length（1），无 repeat → 空
    const r1 = await llm.chat(
      [{ id: "a", role: "assistant", content: "only", createdAt: 0, updateAt: 0 }],
      [],
      { model: "mock-exhaust" },
    );
    expect((r1 as { content?: string }).content).toBe("");
  });
});
