/**
 * OpenAI provider 测试：adapter 配置 + LLM 调用（vi.mock OpenAI SDK）。
 *
 * 覆盖：
 * - registerOpenAIAdapter 注册 message/sense/llm adapter
 * - message adapter：content / thinking(reasoning_content) / extractStreamDelta/Thinking
 * - buildMessages：sense→tool / assistant+senseCalls→tool_calls / simple / user / 过滤 revoked / sense replaced→replace.content
 * - sense adapter：buildSenses(strict:true) / senseCalls(id 缺省 sense-${i}) / extractSenseCallDeltas
 * - LLM：chat / chatStream / thinking 选项 / model|url 缺失 throw
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerOpenAIAdapter } from "@/agent/provider/openai.js";
import { getLLMAdapter } from "@/core/llm/adapter.js";
import { getMessageAdapter } from "@/core/message/adapter.js";
import { getSenseAdapter, senseAdapterRegistry } from "@/core/sense/adapter.js";
import type { LLMResponse } from "@/core/message/adapter.js";
import type { Sense, SenseFunction } from "@/core/sense/index.js";
import type { ZodType } from "zod";

vi.mock("openai", () => {
  const mockCreate = vi.fn().mockImplementation(async (options: { stream?: boolean }) => {
    if (options.stream) {
      return {
        async *[Symbol.asyncIterator]() {
          yield { choices: [{ delta: { content: "Hello" } }] };
          yield { choices: [{ delta: { content: " from OpenAI" } }] };
        },
      };
    }
    return {
      choices: [
        {
          message: {
            role: "assistant",
            content: "Hello from OpenAI",
            reasoning_content: "test reasoning",
            tool_calls: [{ id: "tc-1", type: "function", function: { name: "test_tool", arguments: "{}" } }],
          },
        },
      ],
    };
  });
  return {
    default: class MockOpenAI {
      constructor() {
        return { chat: { completions: { create: mockCreate } } };
      }
    },
  };
});

describe("OpenAI provider 注册", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("注册 message/sense/llm adapter", () => {
    registerOpenAIAdapter();
    expect(getLLMAdapter("openai")).toBeDefined();
    expect(getMessageAdapter("openai")).toBeDefined();
    expect(getSenseAdapter("openai")).toBeDefined();
  });
});

describe("OpenAI message adapter", () => {
  beforeEach(() => {
    senseAdapterRegistry.clear();
    registerOpenAIAdapter();
  });

  it("content 提取 / 空时返回空串", () => {
    const cfg = getMessageAdapter("openai")!;
    expect(cfg.content({ choices: [{ message: { content: "x" } }] } as never)).toBe("x");
    expect(cfg.content({ choices: [{ message: {} }] } as never)).toBe("");
  });

  it("thinking 提取 reasoning_content / 无则 undefined", () => {
    const cfg = getMessageAdapter("openai")!;
    expect(cfg.thinking?.({ choices: [{ message: { reasoning_content: "r" } }] } as never)).toBe("r");
    expect(cfg.thinking?.({ choices: [{ message: {} }] } as never)).toBeUndefined();
  });

  it("extractStreamDelta / Thinking", () => {
    const cfg = getMessageAdapter("openai")!;
    expect(cfg.extractStreamDelta({ choices: [{ delta: { content: "d" } }] } as never)).toBe("d");
    expect(cfg.extractStreamDelta({ choices: [{ delta: {} }] } as never)).toBe("");
    expect(cfg.extractStreamThinking?.({ choices: [{ delta: { reasoning_content: "rt" } }] } as never)).toBe("rt");
    expect(cfg.extractStreamThinking?.({ choices: [{ delta: {} }] } as never)).toBeUndefined();
  });

  it("buildMessages: sense → role:tool + tool_call_id", () => {
    const cfg = getMessageAdapter("openai")!;
    const history: LLMResponse[] = [
      { id: "s1", role: "sense", content: "result", createdAt: 0, updateAt: 0 },
    ];
    const out = cfg.buildMessages(history) as Array<{ role: string; content: string; tool_call_id: string }>;
    expect(out[0]!.role).toBe("tool");
    expect(out[0]!.tool_call_id).toBe("s1");
    expect(out[0]!.content).toBe("result");
  });

  it("buildMessages: assistant+senseCalls → tool_calls", () => {
    const cfg = getMessageAdapter("openai")!;
    const history: LLMResponse[] = [
      { id: "a1", role: "assistant", content: "c", senseCalls: [{ id: "tc-1", name: "t", arguments: "{}" }], createdAt: 0, updateAt: 0 },
    ];
    const out = cfg.buildMessages(history) as Array<{ role: string; tool_calls?: Array<{ id: string; type: string }> }>;
    expect(out[0]!.role).toBe("assistant");
    expect(out[0]!.tool_calls?.[0]?.id).toBe("tc-1");
    expect(out[0]!.tool_calls?.[0]?.type).toBe("function");
  });

  it("buildMessages: simple assistant/user 透传", () => {
    const cfg = getMessageAdapter("openai")!;
    const out = cfg.buildMessages([
      { id: "a", role: "assistant", content: "hi", createdAt: 0, updateAt: 0 },
      { id: "u", role: "user", content: "hey", createdAt: 0, updateAt: 0 },
    ]) as Array<{ role: string; content: string }>;
    expect(out[0]).toEqual({ role: "assistant", content: "hi" });
    expect(out[1]).toEqual({ role: "user", content: "hey" });
  });

  it("buildMessages: 过滤 revoked", () => {
    const cfg = getMessageAdapter("openai")!;
    const out = cfg.buildMessages([
      { id: "a", role: "assistant", content: "keep", createdAt: 0, updateAt: 0 },
      { id: "r", role: "assistant", content: "gone", createdAt: 0, updateAt: 0, revoked: true },
    ]);
    expect(out.length).toBe(1);
  });

  it("buildMessages: sense 被替换 → content 用 replace.content", () => {
    const cfg = getMessageAdapter("openai")!;
    const out = cfg.buildMessages([
      { id: "s", role: "sense", content: "old", replace: { state: true, by: "new", content: "REPLACED" }, createdAt: 0, updateAt: 0 },
    ]) as Array<{ content: string }>;
    expect(out[0]!.content).toBe("REPLACED");
  });
});

describe("OpenAI sense adapter", () => {
  beforeEach(() => {
    senseAdapterRegistry.clear();
    registerOpenAIAdapter();
  });

  it("buildSenses 含 strict:true", () => {
    const cfg = getSenseAdapter("openai")!;
    const senses = [{
      definition: { type: "function" as const, function: { name: "t", description: "d", parameters: { type: "object", properties: {}, required: [], additionalProperties: false } } },
      executor: { schema: {} as ZodType, execute: async () => ({ content: "", hash: "" }) },
      supervisionLevel: undefined,
    }] as Sense<ZodType>[];
    const built = cfg.buildSenses(senses) as SenseFunction[];
    expect(built[0]!.function.name).toBe("t");
    expect((built[0]!.function as unknown as { strict: boolean }).strict).toBe(true);
  });

  it("senseCalls: 提取 id/name；缺 id → sense-${index}", () => {
    const cfg = getSenseAdapter("openai")!;
    const withId = cfg.senseCalls({ choices: [{ message: { tool_calls: [{ id: "x", type: "function", function: { name: "t", arguments: "{}" } }] } }] } as never);
    expect(withId[0]!.id).toBe("x");
    const noId = cfg.senseCalls({ choices: [{ message: { tool_calls: [{ type: "function", function: { name: "t", arguments: "{}" } }] } }] } as never);
    expect(noId[0]!.id).toBe("sense-0");
  });

  it("senseCalls: 空", () => {
    const cfg = getSenseAdapter("openai")!;
    expect(cfg.senseCalls({ choices: [{ message: {} }] } as never)).toHaveLength(0);
  });

  it("extractSenseCallDeltas: stream chunk", () => {
    const cfg = getSenseAdapter("openai")!;
    const out = cfg.extractSenseCallDeltas({ choices: [{ delta: { tool_calls: [{ index: 0, id: "tc", function: { name: "t", arguments: '{"a":' } }] } }] } as never);
    expect(out[0]!.name).toBe("t");
    expect(out[0]!.id).toBe("tc");
    expect(cfg.extractSenseCallDeltas({ choices: [{ delta: {} }] } as never)).toHaveLength(0);
  });
});

describe("OpenAI LLM adapter", () => {
  beforeEach(() => {
    senseAdapterRegistry.clear();
    registerOpenAIAdapter();
  });

  it("chat 调用返回响应", async () => {
    const llm = getLLMAdapter("openai")!;
    const r = await llm.chat([{ role: "user", content: "hi" }], [], { model: "gpt-4", url: "https://x", key: "k" });
    expect((r as { choices: Array<{ message: { content: string } }> }).choices[0]!.message.content).toBe("Hello from OpenAI");
  });

  it("chat model 缺失 → throw", async () => {
    const llm = getLLMAdapter("openai")!;
    await expect(llm.chat([], [], { url: "https://x" })).rejects.toThrow("大脑没配好");
  });

  it("chat url 缺失 → throw", async () => {
    const llm = getLLMAdapter("openai")!;
    await expect(llm.chat([], [], { model: "gpt-4" })).rejects.toThrow("大脑没配好");
  });

  it("chatStream 返回可迭代 + content", async () => {
    const llm = getLLMAdapter("openai")!;
    const stream = await llm.chatStream([], [], { model: "gpt-4", url: "https://x", key: "k" });
    const parts: string[] = [];
    for await (const c of stream as AsyncIterable<{ choices: Array<{ delta: { content?: string } }> }>) {
      if (c.choices[0]?.delta.content) parts.push(c.choices[0].delta.content);
    }
    expect(parts.join("")).toBe("Hello from OpenAI");
  });

  it("chatStream model 缺失 → throw", async () => {
    const llm = getLLMAdapter("openai")!;
    await expect(llm.chatStream([], [], { url: "https://x" })).rejects.toThrow("大脑没配好");
  });

  it("thinking 选项 + senses 传入不抛错", async () => {
    const llm = getLLMAdapter("openai")!;
    const senses = [{ type: "function", function: { name: "t", description: "d", parameters: { type: "object", properties: {}, required: [], additionalProperties: false } } }] as SenseFunction[];
    const r = await llm.chat([], senses, { model: "gpt-4", url: "https://x", key: "k", thinking: true });
    expect(r).toBeDefined();
  });
});
