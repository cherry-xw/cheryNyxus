import type { SupervisionLevel } from "@/middleware/types";

// 重导出 middleware 类型（向后兼容）
export { SupervisionLevel } from "@/middleware/types";
export type { ToolCallAccumulator, llmAdapter } from "@/middleware/types";

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