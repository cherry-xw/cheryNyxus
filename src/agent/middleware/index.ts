import Middleware from "@/core/middleware";
import type { MiddlewareHandler, DoneChunk, MiddlewareChunk, StreamChunk, ToolTriggerChunk, ToolCompleteChunk, StagedChunk, ErrorChunk } from "@/core/middleware/types";
import { checkpointMiddleware } from "./checkpoint";
import { chatMiddleware } from "./chat";
import { toolMiddleware } from "./tool";
import { retryMiddleware } from "./retry";
import { createLoopHandler } from "./loop";

export default Middleware;
export {
  checkpointMiddleware,
  chatMiddleware,
  toolMiddleware,
  retryMiddleware,
  createLoopHandler,
};
export type { StreamChunk, ToolTriggerChunk, ToolCompleteChunk, StagedChunk, ErrorChunk, DoneChunk, MiddlewareChunk };

/**
 * 默认 handlers 队列
 * 执行顺序（从外到内）：checkpoint → tool → retry → chat
 * checkpoint（第1层）：归纳所有 chunk，生成 tool_trigger/staged/done
 * tool（第2层）：收集 tool_trigger，执行后 yield tool_complete
 * retry（第3层）：捕获 LLM 调用错误并重试
 * chat（第4层/内层）：调用 LLM，yield StreamChunk
 */
export const defaultHandlers: MiddlewareHandler<MiddlewareChunk>[] = [
  checkpointMiddleware as MiddlewareHandler<MiddlewareChunk>,
  toolMiddleware as MiddlewareHandler<MiddlewareChunk>,
  retryMiddleware as MiddlewareHandler<MiddlewareChunk>,
  chatMiddleware as MiddlewareHandler<MiddlewareChunk>,
];