import type { MiddlewareContext, ErrorChunk } from "@/core/middleware/types";
import { logger } from "@/utils/logger/index.js";

// ========== 配置常量 ==========
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

// ========== 错误分类 ==========
type ErrorCategory = "network" | "provider" | "timeout" | "validation" | "unknown";

/**
 * 根据错误信息判断分类
 */
function classifyError(error: unknown): ErrorCategory {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("network") || msg.includes("connection") || msg.includes("econnrefused") || msg.includes("enotfound")) {
      return "network";
    }
    if (msg.includes("timeout") || msg.includes("timed out")) {
      return "timeout";
    }
    if (msg.includes("validation") || msg.includes("invalid") || msg.includes("schema")) {
      return "validation";
    }
    if (msg.includes("api") || msg.includes("rate limit") || msg.includes("provider")) {
      return "provider";
    }
  }
  return "unknown";
}

/**
 * 判断错误是否可恢复（可重试）
 */
function isRecoverable(category: ErrorCategory): boolean {
  // network 和 timeout 错误通常可重试
  // validation 错误不可重试（参数问题）
  // provider 错误可能可重试（如 rate limit）
  return category === "network" || category === "timeout" || category === "provider";
}

// ========== 辅助函数 ==========
function createErrorInfo(attempt: number, error: unknown): ErrorChunk["errors"][number] {
  const category = classifyError(error);
  return {
    attempt,
    timestamp: Date.now(),
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    recoverable: isRecoverable(category),
    category,
  };
}

async function delay(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// ========== Middleware 实现 ==========
/**
 * Retry Middleware
 * 职责：捕获 chat 调用错误，重试 MAX_RETRIES 次
 * 成功：透传所有 chunks
 * 失败：yield ErrorChunk 包含所有错误信息（含分类）
 */
export async function* retryMiddleware(
  ctx: MiddlewareContext,
  next: () => AsyncGenerator<unknown>,
): AsyncGenerator<ErrorChunk | unknown> {
  const errors: ErrorChunk["errors"] = [];

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    // 快照本轮 chain 起始的 messages 长度：chat 流中途失败时，外层 checkpoint 已 append 半截 assistant message，
    // 重试前回滚到本轮起始状态，避免重复 append 污染历史（P0-5）。
    // 注：已 yield 的 StreamChunk 无法撤回（retry 固有表现），仅回滚内存 messages。
    // P1-1：snapshot 含本轮 checkpoint 已 push 的 user（checkpoint 先于 retry 执行），
    //   截断仅回滚半截 assistant，本轮 user 保留。resume 路径首轮 senseMiddleware skip chat 层，
    //   retry.next() 返回空不追加 → snapshot 截断无实质触发，安全。
    //   messages 类型可选但运行时由 init 赋 []，显式守卫消除 undefined（替代原 ?. 掩盖）。
    const messages = ctx.soul.messages;
    if (!messages) throw new Error("soul.messages not initialized before retry");
    const snapshot = messages.length;
    try {
      // 透传所有 chunks（chat 只 yield StreamChunk/StagedChunk）
      yield* next();
      return; // 成功，结束
    } catch (error) {
      // compose abort（chat.abort 注入的 throw）：直接 re-throw 传播退出整个 generator，
      // 不重试、不转 ErrorChunk（保证 abort 在任意挂起点都"直接退出"，由 handleChatSend catch 静默）。
      if (error instanceof Error && error.message === "approval aborted") {
        throw error;
      }
      const errorInfo = createErrorInfo(attempt, error);
      errors.push(errorInfo);
      logger.error(`[Retry] Attempt ${attempt} failed (${errorInfo.category}):`, error instanceof Error ? error.message : String(error));

      // 回滚本轮 checkpoint 已 append 的半截 message，恢复历史干净后再重试
      messages.length = snapshot;

      // 非最后一次且可恢复：等待后继续
      if (attempt < MAX_RETRIES && errorInfo.recoverable) {
        await delay(RETRY_DELAY_MS);
        continue;
      }

      // 最后一次失败或不可恢复：yield ErrorChunk
      yield { type: "error", errors };
      return;
    }
  }
}