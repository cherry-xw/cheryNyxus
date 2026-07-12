/**
 * Token 估算 + chat 上下文用量计算。
 *
 * 简化估算：字符数 / 4（英文近似 4 char/token；中文偏保守但够用）。
 * 后续接 tokenizer（如 js-tiktoken）时替换 estimateTokens 实现即可，调用点不变。
 *
 * 用量 = chat 所有非 revoked 消息 content+thinking 累加 token /（brain.contextLimit KB × 256），
 * clamp [0,1]。估算失败不阻塞（规则 12 fail loud：兜底 0 + console.warn，避免 chat.send/get 因
 * token 计算挂掉）。
 */
import { getMessages, type MessageRow } from "@/db/chat.js";
import { getChatRuntimeSelection } from "@/db/chat.js";
import config from "@/utils/config";

/** contextLimit 兜底值（KB）：brain 未配 contextLimit 时使用（≈原 8192 token） */
const DEFAULT_CONTEXT_LIMIT_KB = 32;
/** KB → token 预算换算：1KB≈1024 char ÷ 4 char/token = 256 token/KB */
const TOKENS_PER_KB = 256;

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
 * 计算 chat 上下文用量比例（0-1）。
 *
 * limit 来源：chat 持久化 runtime 的 brain 对应 config.llm.brain[brain].contextLimit（单位 KB）；
 * brain 未配或缺失 → DEFAULT_CONTEXT_LIMIT_KB 兜底。KB × TOKENS_PER_KB 折算为 token 预算作分母。
 * 异常（chat 不存在/DB 读失败）→ 兜底 0 + console.warn（不阻塞调用方）。
 */
export function computeContextUsage(chatId: string): number {
  try {
    const used = sumChatTokens(chatId);
    const selection = getChatRuntimeSelection(chatId);
    const brainName = selection?.brain;
    const limitKB =
      (brainName && config.llm.brain[brainName]?.contextLimit) ||
      DEFAULT_CONTEXT_LIMIT_KB;
    const limitTokens = limitKB * TOKENS_PER_KB;
    if (limitTokens <= 0) return 0;
    return Math.min(1, used / limitTokens);
  } catch (err) {
    console.warn(
      `[token] computeContextUsage(${chatId}) failed, fallback 0:`,
      (err as Error).message,
    );
    return 0;
  }
}
