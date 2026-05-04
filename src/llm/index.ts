// 导出类型（不含 llmAdapter，避免冲突）
export type { ClientConfigBase, ToolCallAccumulator } from "./types";
export { SupervisionLevel } from "./types";

// 导出 middleware（从新位置）
export {
  compose,
  messageMiddleware,
  toolMiddleware,
  chunkMiddleware,
  chatMiddleware,
  continueToolExecution,
} from "@/middleware/index";
export type {
  MiddlewareContext,
  MiddlewareHandler,
  MiddlewareChunk,
  StreamChunk,
  InterruptChunk,
  DoneChunk,
  LLMStreamChunk,
  llmAdapter,
} from "@/middleware/types";

// 导出 adapter
export { registerLLMAdapter, getLLMAdapter } from "./adapter";
