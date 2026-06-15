/**
 * 纯单元测试 context/runtime 构造（不依赖完整 agent）。
 *
 * 用于 middleware 各 handler 的隔离单元测（retry 错误分类、checkpointState 消息构建、
 * loop 停止条件边界、chat adapter 调用），与 agentHarness 的集成式互补。
 */
import { z } from "zod";
import { vi } from "vitest";
import { sense } from "@/core/sense/index.js";
import { SupervisionLevel } from "@/core/config.js";
import type {
  MiddlewareContext,
  RuntimeConfig,
  AdaptersGroup,
  SenseEntry,
  MiddlewareChunk,
  StreamChunk,
} from "@/core/middleware/types.js";
import type { LLMAdapter, LLMOptions } from "@/core/llm/adapter.js";
import type { MessageProviderAdapterConfig } from "@/core/message/adapter.js";
import type { SenseAdapter, SenseFunction, SenseCallData } from "@/core/sense/adapter.js";
import type { Sense, SenseResult, SenseSharedData } from "@/core/sense/index.js";
import type { GlobalConfig, BrainConfig } from "@/utils/config.js";
import type { ZodType } from "zod";

const DEFAULT_GLOBAL: GlobalConfig = {
  thinking: false,
  supervision: SupervisionLevel.auto,
  stream: true,
};

/** 构造测试 sense（位置参数，对齐 senseCreator） */
export function createTestSense(
  name: string,
  exec: (input: Record<string, unknown>, sd: SenseSharedData) => Promise<SenseResult>,
  level: SupervisionLevel = SupervisionLevel.auto,
  schema: ZodType = z.record(z.unknown()),
): Sense<ZodType> {
  return sense(
    name,
    `test sense ${name}`,
    schema as unknown as z.ZodObject<z.ZodRawShape>,
    exec as (input: unknown, sd: SenseSharedData) => Promise<SenseResult>,
    level,
  );
}

/** 摊平 senses 为 senseTable（监管等级 + 执行器），对齐 runtimeResolver.buildSenseTable */
export function buildSenseTable(senses: Sense<ZodType>[]): Map<string, SenseEntry> {
  const table = new Map<string, SenseEntry>();
  for (const s of senses) {
    const name = s.definition.function.name;
    table.set(name, {
      supervisionLevel: s.supervisionLevel ?? SupervisionLevel.auto,
      execute: (args, sd) =>
        s.executor.execute(
          args as Parameters<typeof s.executor.execute>[0],
          sd,
        ),
    });
  }
  return table;
}

/** mock LLM adapter（chat handler 单元测：返回固定 response/stream） */
export function mockLLMAdapter(
  overrides: Partial<Pick<LLMAdapter, "chat" | "chatStream">> = {},
): LLMAdapter {
  return {
    chat: overrides.chat ?? vi.fn(async () => ({})),
    chatStream:
      overrides.chatStream ??
      vi.fn(async () => (async function* empty() {})()),
  };
}

/** mock message adapter（buildMessages 透传、extract 返回空） */
export function mockMessageAdapter(
  overrides: Partial<MessageProviderAdapterConfig> = {},
): MessageProviderAdapterConfig {
  return {
    role: overrides.role ?? (() => "assistant" as const),
    content: overrides.content ?? (() => ""),
    thinking: overrides.thinking,
    extractStreamDelta: overrides.extractStreamDelta ?? (() => ""),
    extractStreamThinking: overrides.extractStreamThinking,
    buildMessages: overrides.buildMessages ?? ((history) => history),
  };
}

/** mock sense adapter */
export function mockSenseAdapter(
  overrides: Partial<SenseAdapter<unknown, unknown>> = {},
): SenseAdapter<unknown, unknown> {
  return {
    buildSenses: overrides.buildSenses ?? ((() => []) as (s: Sense<ZodType>[]) => SenseFunction[]),
    senseCalls: overrides.senseCalls ?? (() => []),
    extractSenseCallDeltas: overrides.extractSenseCallDeltas ?? (() => []),
  };
}

/** 构造完整 RuntimeConfig（senseTable 由 senses 摊平，adapters 缺省 mock） */
export function createMockRuntime(opts: {
  senses?: Sense<ZodType>[];
  adapters?: Partial<AdaptersGroup>;
  brain?: Partial<BrainConfig>;
}): RuntimeConfig {
  const senses = opts.senses ?? [];
  const brain: BrainConfig = {
    model: opts.brain?.model ?? "test-model",
    provider: opts.brain?.provider ?? "mock",
    url: opts.brain?.url,
    key: opts.brain?.key,
    thinking: opts.brain?.thinking,
  };
  return {
    brain,
    adapters: {
      llmAdapter: opts.adapters?.llmAdapter ?? mockLLMAdapter(),
      messageAdapter: opts.adapters?.messageAdapter ?? mockMessageAdapter(),
      senseAdapter: opts.adapters?.senseAdapter ?? mockSenseAdapter(),
    },
    builtSenses: senses.map((s) => ({ type: "function", function: s.definition.function })),
    senseTable: buildSenseTable(senses),
  };
}

/** 构造 MiddlewareContext */
export function createMockContext(opts: {
  runtime?: RuntimeConfig;
  messages?: MiddlewareContext["soul"]["messages"];
  userInputs?: Array<{ content: string; time: number }>;
  global?: Partial<GlobalConfig>;
  resumePending?: boolean;
}): MiddlewareContext {
  return {
    soul: {
      chatId: "test-chat",
      senseSharedData: new Map(),
      userInputs: opts.userInputs ?? [],
      messages: opts.messages ?? [],
      resumePending: opts.resumePending,
    },
    global: { ...DEFAULT_GLOBAL, ...opts.global },
    runtime: opts.runtime ?? createMockRuntime({}),
  };
}

/** 构造 next generator（handler 单元测：下游 yield 固定 chunk 序列） */
export function makeNext(chunks: MiddlewareChunk[]): () => AsyncGenerator<MiddlewareChunk> {
  return async function* next(): AsyncGenerator<MiddlewareChunk> {
    for (const c of chunks) yield c;
  };
}

/** 构造 StreamChunk */
export function streamChunk(opts: {
  thinking?: string;
  content?: string;
  senseDelta?: SenseCallData[];
}): StreamChunk {
  return {
    type: "stream",
    thinkingDelta: opts.thinking ?? "",
    contentDelta: opts.content ?? "",
    senseDelta: opts.senseDelta,
  };
}
