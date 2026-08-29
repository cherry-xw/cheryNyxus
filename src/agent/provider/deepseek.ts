/**
 * DeepSeek Chat Completions provider。
 *
 * DeepSeek thinking mode 的历史规则与普通 OpenAI 兼容端点不同：
 * 只有含 tool_calls 的 assistant 消息必须把 reasoning_content 原样带回；普通轮次不拼接。
 * 详见 https://api-docs.deepseek.com/zh-cn/guides/thinking_mode 。
 *
 * thinking 参数：provider 不内置档位词映射——chat middleware 统一翻译 `options.thinkingParams`
 * 片段（翻译表 .chery/model-thinking.yaml），此处只原样 spread 进请求体。
 */
import type { SenseFunction, SenseAdapter } from '@/core/sense'
import { registerLLMAdapter, type LLMAdapter, type LLMOptions } from '@/core/llm/adapter'
import { registerProviderUrlPattern } from '@/core/llm/urlPattern'
import { registerMessageAdapter, type MessageProviderAdapterConfig } from '@/core/message/adapter'
import { registerSenseAdapter } from '@/core/sense/adapter'
import {
  acquireRpm,
  buildOpenAICompatibleMessages,
  openaiMessageAdapterConfig,
  openaiSenseAdapterConfig,
} from './openaiCompat.js'
import { assertChatOptions, jsonRequest, streamSSE } from './fetchBase.js'

const deepseekMessageAdapterConfig = {
  ...openaiMessageAdapterConfig,
  buildMessages: (
    history: Parameters<typeof buildOpenAICompatibleMessages>[0],
    attachments?: Parameters<typeof buildOpenAICompatibleMessages>[1],
  ) =>
    buildOpenAICompatibleMessages(history, attachments, (message) =>
      Boolean(message.senseCalls && message.senseCalls.length > 0),
    ),
}

const deepseekLLMAdapter: LLMAdapter = {
  async chat(messages: unknown[], senses: SenseFunction[], options?: LLMOptions): Promise<unknown> {
    const { model, url, key } = assertChatOptions(options)
    await acquireRpm(options)
    return jsonRequest(
      url,
      {
        model,
        messages,
        stream: false,
        // thinking 片段直传（翻译在 chat middleware，见 docs/agent/provider.md）
        ...(options?.thinkingParams ?? {}),
        ...(senses.length > 0 && { tools: senses }),
      },
      key,
      options?.signal,
      { fullUrl: options?.fullUrl === true },
    )
  },
  async chatStream(
    messages: unknown[],
    senses: SenseFunction[],
    options?: LLMOptions,
  ): Promise<AsyncIterable<unknown>> {
    const { model, url, key } = assertChatOptions(options)
    await acquireRpm(options)
    return streamSSE(
      url,
      {
        model,
        messages,
        stream: true,
        ...(options?.thinkingParams ?? {}),
        ...(senses.length > 0 && { tools: senses }),
      },
      key,
      options?.signal,
      { fullUrl: options?.fullUrl === true },
    )
  },
}

export function registerDeepseekAdapter(): void {
  registerMessageAdapter('deepseek', deepseekMessageAdapterConfig as MessageProviderAdapterConfig)
  registerSenseAdapter(
    'deepseek',
    openaiSenseAdapterConfig as unknown as SenseAdapter<Record<string, unknown>>,
  )
  registerLLMAdapter('deepseek', deepseekLLMAdapter)
  // URL 端点声明：chat 拼 /chat/completions；models 走 openai SDK（base 原样）
  registerProviderUrlPattern('deepseek', { chatEndpoint: '/chat/completions', modelsEndpoint: '' })
}
