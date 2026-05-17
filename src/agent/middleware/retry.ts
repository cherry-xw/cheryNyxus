import type { MiddlewareContext } from "@/core/middleware/types";

// ========== 配置常量 ==========
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

// ========== 类型定义 ==========
/**
 * 错误 chunk（重试失败时传递）
 */
export interface ErrorChunk {
  type: "error";
  errors: Array<{
    attempt: number;
    timestamp: number;
    message: string;
    stack?: string;
  }>;
  finalError: boolean;
}

// ========== 辅助函数 ==========
function createErrorInfo(attempt: number, error: unknown) {
  return {
    attempt,
    timestamp: Date.now(),
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
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
 * 失败：yield ErrorChunk 包含所有错误信息
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
      errors.push(createErrorInfo(attempt, error));
      console.error(`[Retry] Attempt ${attempt} failed:`, error instanceof Error ? error.message : String(error));

      // 非最后一次：等待后继续
      if (attempt < MAX_RETRIES) {
        await delay(RETRY_DELAY_MS);
        continue;
      }

      // 最后一次失败：yield ErrorChunk
      yield { type: "error", errors, finalError: true };
      return;
    }
  }
}