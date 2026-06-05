import type { MiddlewareContext, ErrorChunk } from "@/core/middleware/types";

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
  _ctx: MiddlewareContext,
  next: () => AsyncGenerator<unknown>,
): AsyncGenerator<ErrorChunk | unknown> {
  const errors: ErrorChunk["errors"] = [];

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // 透传所有 chunks（chat 只 yield StreamChunk/StagedChunk）
      yield* next();
      return; // 成功，结束
    } catch (error) {
      const errorInfo = createErrorInfo(attempt, error);
      errors.push(errorInfo);
      console.error(`[Retry] Attempt ${attempt} failed (${errorInfo.category}):`, error instanceof Error ? error.message : String(error));

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