import { randomUUID } from "node:crypto";
import { logger } from "./logger/index.js";
import { LogLevel } from "./logger/types.js";

/**
 * 错误信息分层工具（见 [docs/error-conventions.md](../../docs/error-conventions.md)）。
 *
 * 提供 `newTracingId` / `throwUserFacing` 两个工具：
 * - `newTracingId`：8 位 hex（UUID v4 前 8 位），用户面抄录用
 * - `throwUserFacing`：抛错前自动记结构化日志（用户面 vs 日志面分离）
 *
 * **何时使用**：任何抛错会到达用户面（前端 toast / WS 错误帧 / HTTP body / 控制台 warn）的路径。
 * **何时不使用**：内部 helper 错误（不外传）、开发期 throw new Error("TODO") 占位、测试断言。
 */

/**
 * 8 位 hex tracingId：UUID v4 前 8 位，理论 16^8 ≈ 42 亿组合，足够全局唯一。
 * 实际唯一性由 ALS scope + model/url/envName 锚定共同保证；此处仅作"可抄录标识"。
 *
 * 用户报问题时给此 id，开发者凭 id 全文检索日志还原上下文。
 * 检索示例（见 [error-conventions.md 日志检索约定](../../docs/error-conventions.md#日志检索约定)）：
 *   grep "1c538629" .chery/logs/
 *   grep -r '"tracingId":"1c538629"' .chery/
 */
export function newTracingId(): string {
  return randomUUID().slice(0, 8);
}

/**
 * 抛用户面错误：message 短直白，日志面含完整上下文。
 *
 * @param scope        logger event type（模块前缀，如 "llm.key.missing" / "compose.handler"）
 * @param userMessage  用户面 message（不含 tracingId，函数自动追加 ` [tracingId]`）
 * @param context      日志面额外字段（model/url/envName/reason/attempt 等）
 * @throws Error（never return）
 *
 * @example
 * ```ts
 * throwUserFacing(
 *   "llm.key.missing",
 *   `${model} 缺少 key。请在 .env 或环境变量中设置 ${envName} 后重启`,
 *   { model, url, envName, reason: "placeholder_unresolved" },
 * );
 * ```
 */
export function throwUserFacing(
  scope: string,
  userMessage: string,
  context: Record<string, unknown> = {},
): never {
  const tracingId = newTracingId();
  logger.event(scope, { tracingId, ...context }, LogLevel.error);
  throw new Error(`${userMessage} [${tracingId}]`);
}
