import { compose, executeMiddleware, executeUntilInterrupt } from "./compose";
import { messageMiddleware } from "./message";
import { toolMiddleware, continueToolExecution } from "./tool";
import { chunkMiddleware } from "./chunk";
import { chatMiddleware } from "./chat";

export * from "./types";
export { compose, executeMiddleware, executeUntilInterrupt };
export { messageMiddleware, toolMiddleware, chunkMiddleware, chatMiddleware };
export { continueToolExecution };
export { RetryState } from "./types";

/**
 * 创建默认中间件链
 * 执行顺序：Message → Tool → Chunk → Chat（洋葱模型）
 */
export function createDefaultMiddlewareChain() {
  return compose([
    messageMiddleware,
    toolMiddleware,
    chunkMiddleware,
    chatMiddleware,
  ]);
}