import Middleware from "@/core/middleware";
import type { MiddlewareHandler, DoneChunk } from "@/core/middleware/types";
import { messageMiddleware } from "./message";
import { toolMiddleware } from "./tool";
import type { InterruptChunk } from "./tool";
import { chunkMiddleware } from "./chunk";
import type { StreamChunk, StagedChunk } from "./chunk";
import { retryMiddleware } from "./retry";
import type { ErrorChunk } from "./retry";
import { chatMiddleware } from "./chat";

export default Middleware;
export {
  messageMiddleware,
  toolMiddleware,
  chunkMiddleware,
  retryMiddleware,
  chatMiddleware,
};
export type { StreamChunk, StagedChunk, InterruptChunk, ErrorChunk };
export * from "@/core/middleware/types";

/**
 * 中间件 chunk 类型联合
 * 包含所有中间件可能 yield 的 chunk 类型
 */
export type MiddlewareChunk =
  | StreamChunk
  | StagedChunk
  | InterruptChunk
  | ErrorChunk
  | DoneChunk;

/**
 * 默认 handlers 队列
 * 执行顺序：message → tool → chunk → retry → chat
 */
export const defaultHandlers: MiddlewareHandler<MiddlewareChunk>[] = [
  messageMiddleware as MiddlewareHandler<MiddlewareChunk>,
  toolMiddleware as MiddlewareHandler<MiddlewareChunk>,
  chunkMiddleware as MiddlewareHandler<MiddlewareChunk>,
  retryMiddleware as MiddlewareHandler<MiddlewareChunk>,
  chatMiddleware as MiddlewareHandler<MiddlewareChunk>,
];