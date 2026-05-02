import type { Tool } from "./base/toolCreator";
import type { ZodType } from "zod";

/**
 * Tool Adapter 接口
 * 处理不同 LLM Tool 的工具调用格式差异
 */
export interface ToolAdapter {
  /**
   * 构建 Tool 特定的工具数组
   */
  buildTools(tools: Tool<ZodType>[]): unknown[];

  /**
   * 构建工具调用消息（assistant 消息）
   */
  buildToolCallMessage(content: string, toolCalls: unknown[]): unknown;

  /**
   * 构建工具响应消息（tool 消息）
   */
  buildToolResponseMessage(toolCallId: string, result: string): unknown;

  /**
   * 解析工具调用参数
   */
  parseToolCallArguments(raw: unknown): Record<string, unknown>;

  /**
   * 获取工具调用名称
   */
  getToolCallName(raw: unknown): string;

  /**
   * 获取工具调用 ID
   */
  getToolCallId(raw: unknown): string;

  /**
   * 从响应提取工具调用列表
   */
  extractToolCalls(response: unknown): unknown[];

  /**
   * 从流式响应提取工具调用增量列表
   */
  extractToolCallDeltas(chunk: unknown): unknown[];

  /**
   * 获取工具调用增量的 ID
   */
  getToolCallDeltaId(delta: unknown): string;

  /**
   * 获取工具调用增量的名称（可选）
   */
  getToolCallDeltaName(delta: unknown): string | undefined;

  /**
   * 获取工具调用增量的参数片段（可选）
   */
  getToolCallDeltaArguments(delta: unknown): string | undefined;
}

/**
 * Tool Adapter 注册表
 */
export const toolAdapterRegistry = new Map<string, ToolAdapter>();

/**
 * 注册 provider 的 tool adapter
 */
export function registerToolAdapter(
  provider: string,
  adapter: ToolAdapter,
): void {
  toolAdapterRegistry.set(provider, adapter);
}

/**
 * 获取 provider 的 tool adapter
 */
export function getToolAdapter(provider: string): ToolAdapter | undefined {
  return toolAdapterRegistry.get(provider);
}
