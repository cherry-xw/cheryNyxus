import type { Sense, SenseFunction } from "./senseCreator";
import type { ZodType } from "zod";

// 重新导出 SenseFunction 供外部使用
export type { SenseFunction };

/**
 * 统一的感官调用数据结构
 * 流式增量与非流式完整响应共用
 */
export interface SenseCallData {
  /** 累积定位索引（流式时使用，OpenAI delta.sense_calls[].index） */
  index?: number;
  /** 感官调用唯一标识：id 或 sense-${index} */
  id: string;
  /** 感官名称（首个 delta 出现，后续可能为空） */
  name?: string;
  /** 参数 JSON 字符串（完整参数或增量片段） */
  arguments: string;
}

/**
 * Sense Adapter 接口
 * 处理不同 LLM Sense 的感官调用格式差异
 * @template TResponse - 响应类型（完整响应）
 */
export interface SenseAdapter<TResponse> {
  /**
   * 构建 Sense 特定的感官数组
   * 返回统一的 SenseFunction 格式（各 provider 格式基本一致）
   */
  buildSenses(senses: Sense<ZodType>[]): SenseFunction[];

  /**
   * 从完整响应提取感官调用列表
   * 返回统一 SenseCallData 结构
   */
  senseCalls(response: TResponse): SenseCallData[];

  /**
   * 从流式 chunk 提取 sense call 增量
   * 用于实时展示 sense call 参数累积进度
   * 返回 SenseCallData 数组（index 定位，arguments 为增量片段）
   */
  extractSenseCallDeltas(chunk: unknown): SenseCallData[];
}

/**
 * Sense Adapter 注册表
 */
export const senseAdapterRegistry = new Map<
  string,
  SenseAdapter<unknown>
>();

/**
 * 注册 provider 的 sense adapter
 */
export function registerSenseAdapter<TResponse>(
  provider: string,
  adapter: SenseAdapter<TResponse>,
): void {
  senseAdapterRegistry.set(provider, adapter);
}

/**
 * 获取 provider 的 sense adapter
 */
export function getSenseAdapter(
  provider: string,
): SenseAdapter<unknown> | undefined {
  return senseAdapterRegistry.get(provider);
}