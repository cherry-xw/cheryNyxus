import Middleware from "@/core/middleware";
import { messageMiddleware } from "./message";
import { toolMiddleware } from "./tool";
import { chunkMiddleware } from "./chunk";
import { chatMiddleware } from "./chat";

export default Middleware;
export { messageMiddleware, toolMiddleware, chunkMiddleware, chatMiddleware };
export * from "@/core/middleware/types"

/**
 * 默认 handlers 队列
 */
export const defaultHandlers = [
  messageMiddleware,
  toolMiddleware,
  chunkMiddleware,
  chatMiddleware,
];