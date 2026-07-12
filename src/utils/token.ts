/**
 * Token 估算 + chat 上下文用量计算。
 *
 * 简化估算：字符数 / 4（英文近似 4 char/token；中文偏保守但够用）。
 * 后续接 tokenizer（如 js-tiktoken）时替换 estimateTokens 实现即可，调用点不变。
 *
 * 用量 = chat 所有非 revoked 消息 content+thinking 累加 token / brain.contextLimit，
 * clamp [0,1]。contextLimit 单位为 token（与 config.llm.brain[name].contextLimit 一致）。
 * 估算失败不阻塞（规则 12 fail loud：兜底 0 + console.warn，避免 chat.send/get 因
 * token 计算挂掉）。
 */
import { getMessages, type MessageRow } from "@/db/chat.js";
import { getChatRuntimeSelection } from "@/db/chat.js";
import config from "@/utils/config";

/** contextLimit 兜底值（token）：brain 未配 contextLimit 时使用 */
const DEFAULT_CONTEXT_LIMIT_TOKENS = 8192;

/**
 * 估算文本 token 数（简化：字符数 / 4，向上取整）。
 * 空字符串/undefined → 0。
 */
export function estimateTokens(text: string | undefined | null): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * 累加单条消息 token（content + thinking）。
 * revoked 消息已从 LLM 上下文中剔除（revokeTrailingCycle 撤回），不计。
 */
function sumRowTokens(row: MessageRow): number {
  if (row.revoked === 1) return 0;
  return estimateTokens(row.content) + estimateTokens(row.thinking);
}

/**
 * 累加 chat 所有消息 token（读 DB）。
 */
export function sumChatTokens(chatId: string): number {
  const messages = getMessages(chatId);
  let total = 0;
  for (const m of messages) {
    total += sumRowTokens(m);
  }
  return total;
}

/**
 * chat 上下文用量详情（computeContextUsage 返回值）。
 * - usage：比例（0-1），clamp
 * - used：已用 token 数（估算值，字符数/4）
 * - total：上限 token 数（brain.contextLimit，单位 token）
 */
export interface ContextUsageDetail {
  usage: number;
  used: number;
  total: number;
}

/**
 * 计算 chat 上下文用量详情（比例 + 已用 token + 总预算 token）。
 *
 * limit 来源：chat 持久化 runtime 的 brain 对应 config.llm.brain[brain].contextLimit（单位 token）；
 * brain 未配或缺失 → DEFAULT_CONTEXT_LIMIT_TOKENS 兜底。
 * 异常（chat 不存在/DB 读失败）→ 兜底 {usage:0, used:0, total:DEFAULT} + console.warn（不阻塞调用方）。
 */
export function computeContextUsage(chatId: string): ContextUsageDetail {
  try {
    const used = sumChatTokens(chatId);
    const selection = getChatRuntimeSelection(chatId);
    const brainName = selection?.brain;
    const limitTokens =
      (brainName && config.llm.brain[brainName]?.contextLimit) ||
      DEFAULT_CONTEXT_LIMIT_TOKENS;
    if (limitTokens <= 0) return { usage: 0, used, total: 0 };
    return {
      usage: Math.min(1, used / limitTokens),
      used,
      total: limitTokens,
    };
  } catch (err) {
    console.warn(
      `[token] computeContextUsage(${chatId}) failed, fallback 0:`,
      (err as Error).message,
    );
    return { usage: 0, used: 0, total: DEFAULT_CONTEXT_LIMIT_TOKENS };
  }
}
