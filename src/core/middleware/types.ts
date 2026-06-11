import type { LLMResponse } from "../message/index";
import type { MessageProviderAdapterConfig } from "../message/index";
import type { SenseAdapter, SenseCallData, SenseFunction } from "../sense/adapter";
import type { SenseResult, SenseSharedData } from "../sense/senseCreator";
import type { GlobalConfig, BrainConfig } from "@/utils/config";
import { SupervisionLevel } from "../config.js";

/**
 * 用户输入条目
 */
export interface UserInputEntry {
  content: string;
  time: number;
}

/**
 * 感官协调（runtime ephemeral，不持久化）
 */
export interface SenseCoordination {
  /** 感官调用去重检查（callId → resultHash） */
  /** Sense间共享数据（namespace → identifier → data） */
  sharedData: Map<string, Map<string, unknown>>;
}

/**
 * 消息历史
 */
export interface MessageHistory {
  /** 完整对话历史（前端交互用，格式固定，信息完整） */
  fullMessages: LLMResponse[];
  /** 简化消息（AI接口用，仅API必需字段，预转换存储） */
  apiMessages: APIMessage[];
  /** 消息窗口起始索引（滑动窗口，两数组共用） */
  baseIndex: number;
  /** 用户输入队列（send 事件注入，checkpoint消费后清空） */
  pendingInputs: UserInputEntry[];
}

/**
 * 预编译感官
 */
export interface PrecompiledSenses {
  /** 感官名称 → 最终监管等级（优先级前置计算） */
  senseConfigs: Map<string, number>;
  /** 预构建的 API 感官参数（builder层一次性构建） */
  builtSenses: SenseFunction[];
}

/**
 * AI接口消息（仅API必需字段）
 */
export interface APIMessage {
  role: "system" | "user" | "assistant" | "sense" | "function";
  content: string;
  senseCalls?: import("../message/index").SenseCallInfo[];
  /** 仅sense角色需要（sense_call_id） */
  id?: string;
}

/**
 * 聊天上下文分组
 * chatId 唯一标识聊天，brain/senseGroups 每轮可换（运行时由 service 层重建 Middleware）
 */
export interface SoulGroup {
  /** 聊天唯一标记（每轮可换 brain/sense，chatId 不变） */
  chatId: string;
  /** Sense间共享数据（namespace → identifier → data） */
  senseSharedData: Map<string, Map<string, unknown>>;
  /** 用户输入队列（send 事件注入） */
  userInputs: UserInputEntry[];
  /** AI message 参数（checkpoint 构建后放置） */
  messages?: LLMResponse[];
  /** 历史消息已加载标记（防止重复加载） */
  historyLoaded?: boolean;
  /** loop 起始计数（recovery 恢复轮次，从最后 user 消息后 assistant 消息数量计算） */
  loopStartCount?: number;
}

/**
 * 感官运行时条目（senseTable 的 value）
 * 替代 SenseManager.get(name).supervisionLevel 与 execute(name, args)
 */
export interface SenseEntry {
  /** 监管等级（优先级链已前置计算：感官定义 > sense_group > global） */
  supervisionLevel: SupervisionLevel;
  /** 执行器（args 已擦除 zod 类型，由 builder 摊平时注入） */
  execute: (args: Record<string, unknown>, sharedData: SenseSharedData) => Promise<SenseResult>;
}

/**
 * Runtime 配置（每轮可换：brain/sense 变更时由 setBrain/setSense 更新）
 * 由 builder 层构建摊平后注入，ctx 运行期不再依赖 SenseManager。
 */
export interface RuntimeConfig {
  /** Brain 服务配置（model/url/key/thinking/provider） */
  brain: BrainConfig;
  /** Provider adapter 实例集合（llm/message/sense，随 brain.provider 决定） */
  adapters: AdaptersGroup;
  /** 预构建的 API 感官参数（给 LLM 的 function 列表） */
  builtSenses: SenseFunction[];
  /** 感官查找表（name → 监管等级 + 执行器） */
  senseTable: Map<string, SenseEntry>;
}

/**
 * Adapter 分组 - provider adapter 实例集合
 */
export interface AdaptersGroup {
  /** LLM Adapter，处理 chat/chatStream 调用 */
  llmAdapter: LLMAdapter;
  /** Message Adapter，处理消息格式转换 */
  messageAdapter: MessageProviderAdapterConfig;
  /** Sense Adapter，处理感官调用格式转换（随 brain.provider 决定） */
  senseAdapter: SenseAdapter<unknown, unknown>;
}

/**
 * 消息持久化数据（middleware → service 层回调）
 */
export interface PersistMessageData {
  id: string;
  role: "user" | "assistant" | "system" | "sense";
  content?: string;
  thinking?: string;
  senseCalls?: Array<{ id: string; name: string; arguments: string }>;
  /** 感官执行结果的 hash */
  hash?: string;
}

/**
 * 中间件上下文 - 简化结构
 */
export interface MiddlewareContext {
  /** 灵魂分组：聊天标识和上下文关联 */
  soul: SoulGroup;
  /** 请求分组：本次请求的输入和模式 */
  global: GlobalConfig;
  /** Runtime 配置（每轮可换：brain/sense 变更时更新） */
  runtime: RuntimeConfig;
  /** 消息持久化回调（由 service 层注入，middleware 层不直接依赖 DB） */
  persistMessage?: (message: PersistMessageData) => void;
  /** 消息更新回调（recovery 场景：UPDATE 已有记录而非 INSERT） */
  updateMessage?: (id: string, content: string) => void;
}

/**
 * 感官调用增量事件
 * 显式定义 chat.ts → checkpoint.ts 的数据契约
 */
export interface SenseDeltaEvent {
  /** 数据来源 */
  source: "stream" | "non-stream";
  /** 感官调用增量数据 */
  deltas: SenseCallData[];
  /** 是否完整（非流式时为 true） */
  isComplete: boolean;
}

/**
 * 流式增量
 */
export interface StreamChunk {
  type: "stream";
  /** 思考增量 */
  thinkingDelta: string;
  /** 响应增量 */
  contentDelta: string;
  /** Sense call 增量（可选，流式过程中实时传递，index 定位，arguments 为片段） */
  senseDelta?: SenseCallData[];
}

/**
 * 感官触发（待消费）
 * id 使用 AI 响应的 sense_call.id，AI 没有则自己创建
 */
export interface SenseTriggerChunk {
  type: "sense_end";
  /** AI 响应的 sense_call.id */
  id: string;
  /** 感官名称 */
  name: string;
  /** 感官参数 JSON */
  arguments: string;
  /** 监管等级 */
  supervisionLevel: SupervisionLevel;
  /** 审批 resolve 函数（confirm/manual 时使用，service 层调用） */
  approvalResolve?: ((action: "accept" | "reject", reason?: string) => void) | null;
}

/**
 * 感官执行成功
 * id 与 sense_end.id 一致
 */
export interface SenseAcceptChunk {
  type: "sense_accept";
  /** 与 sense_end.id 一致 */
  id: string;
  /** 感官名称 */
  name: string;
  /** 执行结果 */
  result: string;
  /** 结果 hash（用于历史去重） */
  hash?: string;
}

/**
 * 感官执行被拒绝
 * id 与 sense_end.id 一致
 */
export interface SenseRejectChunk {
  type: "sense_reject";
  /** 与 sense_end.id 一致 */
  id: string;
  /** 感官名称 */
  name: string;
  /** 拒绝原因 */
  reason: string;
}

/**
 * 阶段完成 subtype
 */
export type StagedType = "thinking_end" | "content_end" | "sense_end";

/**
 * 阶段完成（checkpoint 归纳后 yield）
 */
export interface StagedChunk {
  type: "staged";
  /** 阶段类型 */
  stagedType: StagedType;
  /** 累积的响应内容 */
  content: string;
  /** 累积的思考内容 */
  thinking: string;
  /** 感官名称（sense_end 时使用） */
  senseName?: string;
  /** 感官参数（sense_end 时使用） */
  senseArguments?: string;
}

/**
 * 完成
 */
export interface DoneChunk {
  type: "done";
}

/**
 * 已消费（用户输入已进入消息循环）
 */
export interface ConsumedChunk {
  type: "consumed";
  count: number;
}

/**
 * 错误 chunk（重试失败或超限时传递）
 */
export interface ErrorChunk {
  type: "error";
  errors: Array<{
    attempt: number;
    timestamp: number;
    message: string;
    stack?: string;
    /** 是否可恢复（可重试） */
    recoverable: boolean;
    /** 错误分类 */
    category: "network" | "provider" | "timeout" | "validation" | "unknown";
  }>;
}

/**
 * 中间件 chunk 联合类型
 */
export type MiddlewareChunk =
  | StreamChunk
  | SenseTriggerChunk
  | SenseAcceptChunk
  | SenseRejectChunk
  | StagedChunk
  | ConsumedChunk
  | DoneChunk
  | ErrorChunk;

/**
 * 中间件处理函数（Generator 支持）
 */
export type MiddlewareHandler<T = MiddlewareChunk> = (
  ctx: MiddlewareContext,
  next: () => AsyncGenerator<T>,
) => AsyncGenerator<T>;

/**
 * 循环策略处理函数
 */
export type LoopHandler<T = MiddlewareChunk> = (
  ctx: MiddlewareContext,
  runChain: () => AsyncGenerator<T, void, unknown>,
) => AsyncGenerator<T, void, unknown>;

/**
 * LLM Adapter 接口
 * 泛型参数支持类型强化，默认参数保持向后兼容
 */
export interface LLMAdapter<
  TMessages = unknown[],
  TResponse = unknown,
  TStreamChunk = unknown
> {
  chat(messages: TMessages, senses: SenseFunction[], options?: Record<string, unknown>): Promise<TResponse>;
  chatStream(messages: TMessages, senses: SenseFunction[], options?: Record<string, unknown>): Promise<AsyncIterable<TStreamChunk>>;
}