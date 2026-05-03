import type { Tool } from "./base/toolCreator";
import type { ZodType } from "zod";

/**
 * Tool Adapter 接口
 * 处理不同 LLM Tool 的工具调用格式差异
 * @template TToolCall - 工具调用类型（完整调用 + delta 增量）
 * @template TMessage - 消息类型（assistant + tool 消息）
 * @template TResponse - 响应类型（完整响应）
 */
export interface ToolAdapter<TToolCall, TMessage, TResponse> {
  /**
   * 构建 Tool 特定的工具数组
   */
  buildTools(tools: Tool<ZodType>[]): unknown[];

  /**
   * 构建工具调用消息（assistant 消息）
   */
  buildToolCallMessage(content: string, toolCalls: TToolCall[]): TMessage;

  /**
   * 构建工具响应消息（tool 消息）
   */
  buildToolResponseMessage(toolCallId: string, result: string): TMessage;

  /**
   * 解析工具调用参数
   */
  parseToolCallArguments(raw: TToolCall): Record<string, unknown>;

  /**
   * 获取工具调用名称
   */
  getToolCallName(raw: TToolCall): string;

  /**
   * 获取工具调用 ID
   */
  getToolCallId(raw: TToolCall): string;

  /**
   * 从响应提取工具调用列表
   */
  extractToolCalls(response: TResponse): TToolCall[];

  /**
   * 从流式响应提取工具调用增量列表
   */
  extractToolCallDeltas(chunk: unknown): TToolCall[];

  /**
   * 获取工具调用增量的 ID
   */
  getToolCallDeltaId(delta: TToolCall): string;

  /**
   * 获取工具调用增量的名称（可选）
   */
  getToolCallDeltaName(delta: TToolCall): string | undefined;

  /**
   * 获取工具调用增量的参数片段（可选）
   */
  getToolCallDeltaArguments(delta: TToolCall): string | undefined;
}

/**
 * Tool Adapter 注册表
 */
export const toolAdapterRegistry = new Map<
  string,
  ToolAdapter<unknown, unknown, unknown>
>();

/**
 * 注册 provider 的 tool adapter
 */
export function registerToolAdapter<TToolCall, TMessage, TResponse>(
  provider: string,
  adapter: ToolAdapter<TToolCall, TMessage, TResponse>,
): void {
  toolAdapterRegistry.set(provider, adapter);
}

/**
 * 获取 provider 的 tool adapter
 */
export function getToolAdapter(
  provider: string,
): ToolAdapter<unknown, unknown, unknown> | undefined {
  return toolAdapterRegistry.get(provider);
}
