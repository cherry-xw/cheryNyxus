import type { SupervisionLevel } from "@/middleware/types";

// 重导出 middleware 类型（向后兼容）
export { SupervisionLevel } from "@/middleware/types";
export type { ToolCallAccumulator, llmAdapter } from "@/middleware/types";

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