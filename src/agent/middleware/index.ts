import Middleware from "@/core/middleware";
import type { MiddlewareHandler, DoneChunk, MiddlewareChunk, StreamChunk, SenseTriggerChunk, SenseCompleteChunk, StagedChunk, ErrorChunk } from "@/core/middleware/types";
import { checkpointMiddleware } from "./checkpoint";
import { chatMiddleware } from "./chat";
import { senseMiddleware } from "./tool";
import { retryMiddleware } from "./retry";
import { createLoopHandler } from "./loop";

export default Middleware;
export {
  checkpointMiddleware,
  chatMiddleware,
  senseMiddleware,
  retryMiddleware,
  createLoopHandler,
};
export type { StreamChunk, SenseTriggerChunk, SenseCompleteChunk, StagedChunk, ErrorChunk, DoneChunk, MiddlewareChunk };

/**
 * 默认 handlers 队列
 * 执行顺序（从外到内）：checkpoint → sense → retry → chat
 * checkpoint（第1层）：归纳所有 chunk，生成 sense_end/staged/done
 * sense（第2层）：收集 sense_end，执行后 yield sense_complete
 * retry（第3层）：捕获 LLM 调用错误并重试
 * chat（第4层/内层）：调用 LLM，yield StreamChunk
 */
export const defaultHandlers: MiddlewareHandler<MiddlewareChunk>[] = [
  checkpointMiddleware as MiddlewareHandler<MiddlewareChunk>,
  senseMiddleware as MiddlewareHandler<MiddlewareChunk>,
  retryMiddleware as MiddlewareHandler<MiddlewareChunk>,
  chatMiddleware as MiddlewareHandler<MiddlewareChunk>,
];