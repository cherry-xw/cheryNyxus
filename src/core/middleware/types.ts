import type { LLMResponse } from "../message/index";
import type { MessageProviderAdapterConfig } from "../message/adapter";
import type { ToolAdapter, ToolCallData, ToolFunction } from "../tool/adapter";
import type { ToolManager } from "../tool/index";
import type { GlobalConfig, AIServerConfig } from "@/utils/config";

/**
 * 用户输入条目
 */
export interface UserInputEntry {
  content: string;
  time: number;
}

/**
 * 会话身份标识（创建后不可变）
 */
export interface SessionIdentity {
  /** agent实例唯一标识 */
  readonly sessionId: string;
  /** agent实例中多轮次会话唯一标记 */
  readonly threadId: string;
}

/**
 * 工具协调（runtime ephemeral，不持久化）
 */
export interface ToolCoordination {
  /** 工具调用去重检查（callId → resultHash） */
  hashCheck: Map<string, string>;
  /** Tool间共享数据（namespace → identifier → data） */
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
 * 预编译工具
 */
export interface PrecompiledTools {
  /** 工具名称 → 最终监管等级（优先级前置计算） */
  toolConfigs: Map<string, number>;
  /** 预构建的 API 工具参数（builder层一次性构建） */
  builtTools: ToolFunction[];
}

/**
 * AI接口消息（仅API必需字段）
 */
export interface APIMessage {
  role: "system" | "user" | "assistant" | "tool" | "function";
  content: string;
  toolCalls?: import("../message/adapter").ToolCallInfo[];
  /** 仅tool角色需要（tool_call_id） */
  id?: string;
}

/**
 * 会话上下文（分解后）
 */
export interface SessionContext {
  /** 身份标识 */
  identity: SessionIdentity;
  /** 工具协调 */
  tools: ToolCoordination;
  /** 消息历史 */
  history: MessageHistory;
  /** 预编译工具 */
  precompiled: PrecompiledTools;
}

/**
 * 会话分组 - 兼容旧代码
 * @deprecated 使用 SessionContext 替代
 */
export interface SessionGroup {
  /** agent实例唯一标识 */
  sessionId: string;
  /** agent实例中多轮次会话唯一标记 */
  threadId: string;
  /** 工具调用去重检查（toolName → hash → 空字符串） */
  hashCheck: Map<string, string>;
  /** Tool间共享数据（namespace → identifier → data） */
  toolSharedData: Map<string, Map<string, unknown>>;
  /** 用户输入队列（send 事件注入） */
  userInputs: UserInputEntry[];
  /** 预构建的 tools（builder 层一次性构建，避免每次迭代重复构建） */
  builtTools: ToolFunction[];
  /** AI message 参数（checkpoint 构建后放置） */
  messages?: LLMResponse[];
}

/**
 * Adapter 分组 - provider adapter 实例集合
 */
export interface AdaptersGroup {
  /** LLM Adapter，处理 chat/chatStream 调用 */
  llmAdapter: LLMAdapter;
  /** Message Adapter，处理消息格式转换 */
  messageAdapter: MessageProviderAdapterConfig;
  /** Tool Adapter，处理工具调用格式转换 */
  toolAdapter: ToolAdapter<unknown, unknown>;
}

/**
 * 中间件上下文 - 简化结构
 */
export interface MiddlewareContext {
  /** 会话分组：会话标识和上下文关联 */
  session: SessionGroup;
  /** 请求分组：本次请求的输入和模式 */
  global: GlobalConfig;
  /** AI 服务配置 */
  aiServer: AIServerConfig;
  /** Adapter 分组：provider adapter 实例集合 */
  adapters: AdaptersGroup;
  /** 工具管理器 */
  toolManager: ToolManager;
}

/**
 * 工具调用增量事件
 * 显式定义 chat.ts → checkpoint.ts 的数据契约
 */
export interface ToolDeltaEvent {
  /** 数据来源 */
  source: "stream" | "non-stream";
  /** 工具调用增量数据 */
  deltas: ToolCallData[];
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
  /** Tool call 增量（可选，流式过程中实时传递，index 定位，arguments 为片段） */
  toolDelta?: ToolCallData[];
}

/**
 * 工具触发（待消费）
 * id 使用 AI 响应的 tool_call.id，AI 没有则自己创建
 */
export interface ToolTriggerChunk {
  type: "tool_trigger";
  /** AI 响应的 tool_call.id */
  id: string;
  /** 工具名称 */
  name: string;
  /** 工具参数 JSON */
  arguments: string;
  /** 监管等级 */
  supervisionLevel: "auto" | "confirm" | "manual";
}

/**
 * 工具完成
 * id 与 tool_trigger.id 一致
 */
export interface ToolCompleteChunk {
  type: "tool_complete";
  /** 与 tool_trigger.id 一致 */
  id: string;
  /** 工具名称 */
  name: string;
  /** 执行结果 */
  result: string;
}

/**
 * 阶段完成（checkpoint 归纳后 yield）
 */
export interface StagedChunk {
  type: "staged";
  /** 累积的响应内容 */
  content: string;
  /** 累积的思考内容 */
  thinking: string;
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
  | ToolTriggerChunk
  | ToolCompleteChunk
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
  chat(messages: TMessages, tools: ToolFunction[], options?: Record<string, unknown>): Promise<TResponse>;
  chatStream(messages: TMessages, tools: ToolFunction[], options?: Record<string, unknown>): Promise<AsyncIterable<TStreamChunk>>;
}