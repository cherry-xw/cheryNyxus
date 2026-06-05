import type { Tool, ToolFunction } from "./toolCreator";
import type { ZodType } from "zod";

// 重新导出 ToolFunction 供外部使用
export type { ToolFunction };

/**
 * 统一的工具调用数据结构
 * 流式增量与非流式完整响应共用
 */
export interface ToolCallData {
  /** 累积定位索引（流式时使用，OpenAI delta.tool_calls[].index） */
  index?: number;
  /** 工具调用唯一标识：id 或 tool-${index} */
  id: string;
  /** 工具名称（首个 delta 出现，后续可能为空） */
  name?: string;
  /** 参数 JSON 字符串（完整参数或增量片段） */
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
   * 返回统一的 ToolFunction 格式（各 provider 格式基本一致）
   */
  buildTools(tools: Tool<ZodType>[]): ToolFunction[];

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
  toolCalls(response: TResponse): ToolCallData[];

  /**
   * 从流式 chunk 提取 tool call 增量
   * 用于实时展示 tool call 参数累积进度
   * 返回 ToolCallData 数组（index 定位，arguments 为增量片段）
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
