import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletion,
} from "openai/resources/chat/completions";
import { config } from "@/config";
import {
  wrapResponse,
  createUserMessage,
  accumulateMessages,
  type LLMResponse,
  type LLMStreamChunk,
} from "@/message/index";


export default function chat(sessionId: string, providerName: string = "openai") {
  const providerConfig = config.llm.providers[providerName];
  if (!providerConfig) {
    throw new Error(`Provider not found: ${providerName}`);
  }
  const provider = providerConfig.provider as string ?? providerName;
  const client = new OpenAI({
    baseURL: providerConfig.url as string,
    apiKey: providerConfig.key as string,
  });

  return {
    async send(threadId: string, input: string): Promise<LLMResponse<any>> {
      const userMsg = createUserMessage(threadId, input);
      const history = accumulateMessages(sessionId, userMsg);
      const messages = history.map((m) => ({
          role: m.role,
          content: m.content,
        })) as ChatCompletionMessageParam[]
      const thinking = providerConfig.thinking === true;
      const rawResponse = await client.chat.completions.create({
        model: providerConfig.model as string,
        messages,
        ...thinking ? { thinking: true } : {},
      });
      const llmres = wrapResponse<
        ChatCompletion & { _request_id?: string | null }
      >(provider, threadId, rawResponse)!;
      accumulateMessages(sessionId, llmres);
      return llmres;
    },

    async *sendStream(
      threadId: string,
      input: string,
    ): AsyncGenerator<LLMStreamChunk<any>> {
      const userMsg = createUserMessage(threadId, input);
      const history = accumulateMessages(sessionId, userMsg);
      const messages = history.map((m) => ({
        role: m.role,
        content: m.content,
      })) as ChatCompletionMessageParam[];

      const thinking = providerConfig.thinking === true;
      const stream = await client.chat.completions.create({
        model: providerConfig.model as string,
        messages,
        stream: true,
        ...thinking ? { thinking: true } : {},
      });

      const streamId = `stream-${Date.now()}`;
      let accumulated = "";
      let thinkingAccumulated = "";

      for await (const chunk of stream) {
        // 提取 reasoning_content（LongCat 扩展字段）
        const deltaObj = chunk.choices[0]?.delta as { reasoning_content?: string } | undefined;
        const thinkingDelta = deltaObj?.reasoning_content ?? "";
        thinkingAccumulated += thinkingDelta;
        // 提取 content（原始字段）
        const delta = chunk.choices[0]?.delta?.content ?? "";
        accumulated += delta;

        // 流式输出 thinking（实时打印）
        if (thinkingDelta || delta) {
          yield {
            streamId,
            thinkingDelta,
            delta,
            thinkingAccumulated,
            accumulated,
            isDone: false,
            raw: chunk,
          };
        }

      }

      // 流结束，生成最终响应并存入历史
      yield {
        streamId,
        thinkingDelta: "",
        delta: "",
        thinkingAccumulated,
        accumulated,
        isDone: true,
        raw: null,
      };

      const finalResponse: LLMResponse<any> = {
        id: streamId,
        role: "assistant",
        content: accumulated,
        threadId,
        createdAt: Date.now(),
        updateAt: Date.now(),
        raw: null,
        provider,
      };
      if (thinkingAccumulated) {
        finalResponse.thinking = thinkingAccumulated;
      }
      accumulateMessages(sessionId, finalResponse);
    },
  };
}
