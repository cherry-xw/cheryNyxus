/**
 * Ollama provider 测试：adapter 配置 + LLM 调用（vi.mock ollama 包）。
 *
 * 覆盖：
 * - registerOllamaAdapter 注册
 * - message adapter：content / thinking / extractStream / buildMessages（sense→role:tool / replaced / 过滤 revoked）
 * - sense adapter：buildSenses（无 strict）/ senseCalls（id=randomUUID，arguments=JSON.stringify）/ extractSenseCallDeltas
 * - LLM：chat / chatStream / model 缺失 throw
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerOllamaAdapter } from "@/agent/provider/ollama.js";
import { getLLMAdapter } from "@/core/llm/adapter.js";
import { getMessageAdapter } from "@/core/message/adapter.js";
import { getSenseAdapter, senseAdapterRegistry } from "@/core/sense/adapter.js";
import type { LLMResponse } from "@/core/message/adapter.js";
import type { Sense, SenseFunction } from "@/core/sense/index.js";
import type { ZodType } from "zod";

const { mockChat, constructorHosts } = vi.hoisted(() => ({
  constructorHosts: [] as Array<string | undefined>,
  mockChat: vi.fn(async (opts: { stream?: boolean }) => {
    if (opts.stream) {
      return {
        async *[Symbol.asyncIterator]() {
          yield { message: { content: "Hello" } };
          yield { message: { content: " from Ollama" } };
        },
      };
    }
    return { message: { role: "assistant", content: "Hello from Ollama", thinking: "th" } };
  }),
}));

vi.mock("ollama", () => ({
  Ollama: class MockOllama {
    chat = mockChat;

    constructor(options?: { host?: string }) {
      constructorHosts.push(options?.host);
    }
  },
}));

describe("Ollama provider 注册", () => {
  beforeEach(() => {
    senseAdapterRegistry.clear();
  });

  it("注册 message/sense/llm adapter", () => {
    registerOllamaAdapter();
    expect(getLLMAdapter("ollama")).toBeDefined();
    expect(getMessageAdapter("ollama")).toBeDefined();
    expect(getSenseAdapter("ollama")).toBeDefined();
  });
});

describe("Ollama message adapter", () => {
  beforeEach(() => {
    senseAdapterRegistry.clear();
    registerOllamaAdapter();
  });

  it("content / thinking 提取", () => {
    const cfg = getMessageAdapter("ollama")!;
    expect(cfg.content({ message: { content: "x" } } as never)).toBe("x");
    expect(cfg.thinking?.({ message: { thinking: "t" } } as never)).toBe("t");
  });

  it("extractStreamDelta / Thinking", () => {
    const cfg = getMessageAdapter("ollama")!;
    expect(cfg.extractStreamDelta({ message: { content: "d" } } as never)).toBe("d");
    expect(cfg.extractStreamThinking?.({ message: { thinking: "st" } } as never)).toBe("st");
  });

  it("buildMessages: sense → role:tool", () => {
    const cfg = getMessageAdapter("ollama")!;
    const out = cfg.buildMessages([
      { id: "s", role: "sense", content: "result", createdAt: 0, updateAt: 0 },
    ]) as Array<{ role: string; content: string }>;
    expect(out[0]!.role).toBe("tool");
    expect(out[0]!.content).toBe("result");
  });

  it("buildMessages: sense replaced → content=replace.content", () => {
    const cfg = getMessageAdapter("ollama")!;
    const out = cfg.buildMessages([
      { id: "s", role: "sense", content: "old", replace: { state: true, by: "n", content: "NEW" }, createdAt: 0, updateAt: 0 },
    ]) as Array<{ content: string }>;
    expect(out[0]!.content).toBe("NEW");
  });

  it("buildMessages: 过滤 revoked", () => {
    const cfg = getMessageAdapter("ollama")!;
    const out = cfg.buildMessages([
      { id: "a", role: "user", content: "keep", createdAt: 0, updateAt: 0 },
      { id: "r", role: "user", content: "revoked", createdAt: 0, updateAt: 0, revoked: true },
    ]);
    expect(out.length).toBe(1);
  });
});

describe("Ollama sense adapter", () => {
  beforeEach(() => {
    senseAdapterRegistry.clear();
    registerOllamaAdapter();
  });

  it("buildSenses 不带 strict", () => {
    const cfg = getSenseAdapter("ollama")!;
    const senses = [{
      definition: { type: "function" as const, function: { name: "t", description: "d", parameters: { type: "object", properties: {}, required: [], additionalProperties: false } } },
      executor: { schema: {} as ZodType, execute: async () => ({ content: "", hash: "" }) },
      supervisionLevel: undefined,
    }] as Sense<ZodType>[];
    const built = cfg.buildSenses(senses) as SenseFunction[];
    expect(built[0]!.function.name).toBe("t");
    expect((built[0] as unknown as { strict?: boolean }).strict).toBeUndefined();
  });

  it("senseCalls: id 非空（randomUUID）+ arguments JSON.stringify", () => {
    const cfg = getSenseAdapter("ollama")!;
    const out = cfg.senseCalls({ message: { tool_calls: [{ function: { name: "t", arguments: { a: 1 } } }] } } as never);
    expect(out[0]!.name).toBe("t");
    expect(out[0]!.id).toBeTruthy();
    expect(out[0]!.arguments).toBe(JSON.stringify({ a: 1 }));
  });

  it("senseCalls: 空", () => {
    const cfg = getSenseAdapter("ollama")!;
    expect(cfg.senseCalls({ message: {} } as never)).toHaveLength(0);
  });

  it("extractSenseCallDeltas", () => {
    const cfg = getSenseAdapter("ollama")!;
    const out = cfg.extractSenseCallDeltas({ message: { tool_calls: [{ function: { name: "t", arguments: { x: 1 } } }] } } as never);
    expect(out[0]!.name).toBe("t");
    expect(cfg.extractSenseCallDeltas({ message: {} } as never)).toHaveLength(0);
  });
});

describe("Ollama LLM adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    constructorHosts.length = 0;
    senseAdapterRegistry.clear();
    registerOllamaAdapter();
  });

  it("chat 使用配置 URL 并返回响应", async () => {
    const llm = getLLMAdapter("ollama")!;
    const r = await llm.chat([], [], { model: "llama", url: "http://remote:11434" });
    expect(constructorHosts).toEqual(["http://remote:11434"]);
    expect((r as { message: { content: string } }).message.content).toBe("Hello from Ollama");
  });

  it("chat model 缺失 → throw", async () => {
    const llm = getLLMAdapter("ollama")!;
    await expect(llm.chat([], [], {})).rejects.toThrow("大脑没配好");
  });

  it("chatStream 使用配置 URL 并返回可迭代", async () => {
    const llm = getLLMAdapter("ollama")!;
    const stream = await llm.chatStream([], [], {
      model: "llama",
      url: "http://remote:11434",
    });
    expect(constructorHosts).toEqual(["http://remote:11434"]);
    const parts: string[] = [];
    for await (const c of stream as AsyncIterable<{ message?: { content?: string } }>) {
      if (c.message?.content) parts.push(c.message.content);
    }
    expect(parts.join("")).toBe("Hello from Ollama");
  });

  it("chatStream model 缺失 → throw", async () => {
    const llm = getLLMAdapter("ollama")!;
    await expect(llm.chatStream([], [], {})).rejects.toThrow("大脑没配好");
  });

  it("senses 传入不抛错（warn 流式 tool_call 不可靠）", async () => {
    const llm = getLLMAdapter("ollama")!;
    const senses = [{ type: "function", function: { name: "t", description: "d", parameters: { type: "object", properties: {}, required: [], additionalProperties: false } } }] as SenseFunction[];
    const r = await llm.chat([], senses, { model: "llama" });
    expect(r).toBeDefined();
  });
});
