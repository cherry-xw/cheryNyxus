import type { Tool } from "./base/toolCreator";
import type { ZodType } from "zod";

/**
 * 统一的工具调用数据结构
 * 流式增量与非流式完整响应共用
 */
export interface ToolCallData {
  /** 工具调用 ID（OpenAI 非流式必需，流式增量可能为空） */
  id?: string;
  /** 工具名称（首个 delta 出现，后续可能为空） */
  name?: string;
  /** 调用索引（流式增量用于关联，非流式设为 -1） */
  index: number;
  /** 参数 JSON 字符串（必需，增量时为空字符串） */
  arguments: string;
}

/**
 * Tool Adapter 接口
 * 处理不同 LLM Tool 的工具调用格式差异
 * @template TMessage - 消息类型（assistant + tool 消息）
 * @template TResponse - 响应类型（完整响应）
 */
export interface ToolAdapter<TMessage, TResponse> {
  /**
   * 构建 Tool 特定的工具数组
   */
  buildTools(tools: Tool<ZodType>[]): unknown[];

  /**
   * 构建工具调用消息（assistant 消息）
   * 接收统一的 ToolCallData，内部转换为 provider 特定格式
   */
  buildToolCallMessage(content: string, toolCalls: ToolCallData[]): TMessage;

  /**
   * 构建工具响应消息（tool 消息）
   */
  buildToolResponseMessage(toolCallId: string, result: string): TMessage;

  /**
   * 从完整响应提取工具调用列表
   * 返回统一 ToolCallData 结构
   */
  extractToolCalls(response: TResponse): ToolCallData[];

  /**
   * 从流式响应提取工具调用增量列表
   * 返回统一 ToolCallData 结构（index 用于关联）
   */
  extractToolCallDeltas(chunk: unknown): ToolCallData[];
}

/**
 * Tool Adapter 注册表
 */
export const toolAdapterRegistry = new Map<
  string,
  ToolAdapter<unknown, unknown>
>();

/**
 * 注册 provider 的 tool adapter
 */
export function registerToolAdapter<TMessage, TResponse>(
  provider: string,
  adapter: ToolAdapter<TMessage, TResponse>,
): void {
  toolAdapterRegistry.set(provider, adapter);
}

/**
 * 获取 provider 的 tool adapter
 */
export function getToolAdapter(
  provider: string,
): ToolAdapter<unknown, unknown> | undefined {
  return toolAdapterRegistry.get(provider);
}
