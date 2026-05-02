import type { LLMStreamChunk } from "@/message/messageFactory";
import type { ToolManager } from "@/tool/base/toolManager";

/**
 * 工具调用累积器（流式工具调用增量累积）
 */
export interface ToolCallAccumulator {
  /** 工具调用 ID */
  id: string;
  /** 工具名称 */
  name: string;
  /** 工具参数（JSON 字符串，需累积拼接） */
  arguments: string;
}

/**
 * Tool 监管等级枚举
 * - auto: 自动执行，无需确认
 * - confirm: 需用户确认后执行
 * - manual: 禁止自动执行，仅手动触发
 */
export enum SupervisionLevel {
  auto = 0,
  confirm = 1,
  manual = 2,
}

/**
 * Send方法返回值（统一结构，status区分状态）
 */
export interface SendResult {
  /** 状态标识：success(完成) / pending(待确认) */
  status: "success" | "pending";
  /** 角色 */
  role: "assistant";
  /** 内容（pending时可能为空） */
  content: string;
  /** thinking内容（可选） */
  thinking?: string;
  /** 会话线程ID */
  threadId: string;
  /** 待确认的tool信息（仅pending状态） */
  pendingTool?: {
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
  };
  /** 原始响应（可选） */
  raw?: unknown;
}

/**
 * LLM Client 配置基础类型
 * 各 Provider 可扩展具体配置结构
 */
export interface ClientConfigBase {
  url: string;
  model: string;
  key?: string;
  thinking?: boolean;
  provider: string;
  /** 使用哪个tool group */
  tool_group?: string;
  /** 允许自动执行的tool监管等级（≤此等级的tool自动执行） */
  autoExecuteLevel?: SupervisionLevel;
}

/**
 * LLM Client 统一接口
 * 所有实现（OpenAI/Ollama/LongCat）必须遵守
 */
export interface LLMClient<TConfig extends ClientConfigBase = ClientConfigBase> {

  /** 配置信息 */
  readonly config: TConfig;
  /** 工具管理器 */
  readonly tool: ToolManager;

  /**
   * 发送消息（两阶段执行）
   * - 自动执行监管等级 ≤ autoExecuteLevel 的 tool
   * - 需确认的 tool 返回 ToolCallPending 状态
   * @param threadId 会话线程ID
   * @param input 用户输入内容
   * @returns LLM 响应或待确认状态
   */
  send(threadId: string, input: string): Promise<SendResult>;

  /**
   * 确认执行待定的 tool 调用
   * @param approved 用户是否批准执行
   * @returns 继续执行后的结果
   */
  confirmToolCall(approved: boolean): Promise<SendResult>;

  /**
   * 发送消息（流式）
   * @param threadId 会话线程ID
   * @param input 用户输入内容
   * @returns 流式响应 AsyncGenerator
   */
  sendStream(
    threadId: string,
    input: string
  ): AsyncGenerator<LLMStreamChunk<unknown>>;
}

/**
 * Client 工厂函数签名
 */
export type ClientFactory<TConfig extends ClientConfigBase = ClientConfigBase> = (
  sessionId: string,
  providerName: string,
  config?: TConfig
) => LLMClient<TConfig>;