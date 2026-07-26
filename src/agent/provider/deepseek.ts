/**
 * DeepSeek Chat Completions provider。
 *
 * DeepSeek thinking mode 的历史规则与普通 OpenAI 兼容端点不同：
 * 只有含 tool_calls 的 assistant 消息必须把 reasoning_content 原样带回；普通轮次不拼接。
 * 详见 https://api-docs.deepseek.com/zh-cn/guides/thinking_mode 。
 */
import type { SenseFunction, SenseAdapter } from '@/core/sense'
import {
  registerLLMAdapter,
  type LLMAdapter,
  type LLMOptions,
  type ThinkingLevel,
} from '@/core/llm/adapter'
import { registerMessageAdapter, type MessageProviderAdapterConfig } from '@/core/message/adapter'
import { registerSenseAdapter } from '@/core/sense/adapter'
import {
  acquireRpm,
  buildOpenAICompatibleMessages,
  openaiMessageAdapterConfig,
  openaiSenseAdapterConfig,
} from './openaiCompat.js'
import { assertChatOptions, jsonRequest, streamSSE } from './fetchBase.js'

function buildThinkingParams(level: ThinkingLevel | undefined): Record<string, unknown> {
  if (level === 'off') return { thinking: { type: 'disabled' } }
  // `xhigh` 与 YAML 自定义档位 `max` 都映射到 DeepSeek API 的 `reasoning_effort: 'max'`。
  const reasoningEffort = level === 'xhigh' || level === 'max' ? 'max' : 'high'
  return {
    thinking: { type: 'enabled' },
    reasoning_effort: reasoningEffort,
  }
}

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
        ...buildThinkingParams(options?.thinking),
        ...(senses.length > 0 && { tools: senses }),
      },
      key,
      options?.signal,
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
        ...buildThinkingParams(options?.thinking),
        ...(senses.length > 0 && { tools: senses }),
      },
      key,
      options?.signal,
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
}
