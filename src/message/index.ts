import { registerAdapter } from "./adapter";
import { type Role } from "./messageFactory";
import type { ChatResponse } from "ollama";
import type { ChatCompletion } from "openai/resources/chat/completions";

export {
  accumulateMessages,
  createUserMessage,
  wrapResponse,
  type LLMResponse,
  type LLMStreamChunk,
  type StreamWrapperOptions,
  type Role,
} from "./messageFactory";

// ========== 默认 Adapter 注册 ==========

// Ollama: ChatResponse 没有 id 字段，使用时间戳生成
registerAdapter<ChatResponse>("ollama", {
  role: (raw) => (raw.message?.role as Role) ?? "assistant",
  content: (raw) => raw.message?.content ?? "",
});

// LongCat/OpenAI: ChatCompletion 有原生 id 字段
registerAdapter<ChatCompletion>("openai", {
  role: () => "assistant",
  content: (raw) => raw.choices[0]?.message?.content ?? "",
  thinking: (raw) => {
    const msg = raw.choices[0]?.message;
    if (msg && "reasoning_content" in msg && msg.reasoning_content) {
      return msg.reasoning_content as string;
    }
    return undefined;
  },
});
