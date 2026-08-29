/**
 * 智谱 BigModel provider（OpenAI 兼容协议，fetch 实现）。
 *
 * LLMAdapter 用原生 fetch（[fetchBase](./fetchBase.js)）；message/sense adapter 复用
 * [openaiCompat](./openaiCompat.js)（自动获得 reasoning_content 解析 + image 多模态 + tool_calls）。
 *
 * 思考参数：provider 不内置档位词映射——chat middleware 统一翻译 `options.thinkingParams`
 * 片段（翻译表 .chery/model-thinking.yaml），此处只原样 spread 进请求体。
 * base_url 默认 https://open.bigmodel.cn/api/paas/v4/（可配，也能指向聚合端点）。
 *
 * 详见 [docs/agent/provider.md](../../../docs/agent/provider.md) 「bigmodel provider」。
 */
import type { SenseFunction } from '@/core/sense'
import { registerLLMAdapter, type LLMAdapter, type LLMOptions } from '@/core/llm/adapter'
import { registerProviderUrlPattern } from '@/core/llm/urlPattern'
import { registerMessageAdapter, type MessageProviderAdapterConfig } from '@/core/message/adapter'
import { registerSenseAdapter, type SenseAdapter } from '@/core/sense'
import {
  openaiMessageAdapterConfig,
  openaiSenseAdapterConfig,
  acquireRpm,
} from './openaiCompat.js'
import { assertChatOptions, jsonRequest, streamSSE } from './fetchBase.js'

// ========== LLM Adapter 定义 ==========

const bigmodelLLMAdapter: LLMAdapter = {
  async chat(messages: unknown[], senses: SenseFunction[], options?: LLMOptions): Promise<unknown> {
    const { model, url, key } = assertChatOptions(options)
    await acquireRpm(options)
    const body: Record<string, unknown> = {
      model,
      messages,
      stream: false,
      // thinking 片段直传（翻译在 chat middleware，见 docs/agent/provider.md）
      ...(options?.thinkingParams ?? {}),
      ...(senses.length > 0 && { tools: senses }),
    }
    return jsonRequest(url, body, key, options?.signal, { fullUrl: options?.fullUrl === true })
  },
  async chatStream(
    messages: unknown[],
    senses: SenseFunction[],
    options?: LLMOptions,
  ): Promise<AsyncIterable<unknown>> {
    const { model, url, key } = assertChatOptions(options)
    await acquireRpm(options)
    const body: Record<string, unknown> = {
      model,
      messages,
      stream: true,
      ...(options?.thinkingParams ?? {}),
      ...(senses.length > 0 && { tools: senses }),
    }
    return streamSSE(url, body, key, options?.signal, { fullUrl: options?.fullUrl === true })
  },
}

// ========== 注册函数 ==========
export function registerBigmodelAdapter(): void {
  // message/sense adapter 复用 openaiCompat（OpenAI 兼容协议，结构同形，鸭子类型解析）
  registerMessageAdapter('bigmodel', openaiMessageAdapterConfig as MessageProviderAdapterConfig)
  registerSenseAdapter(
    'bigmodel',
    openaiSenseAdapterConfig as unknown as SenseAdapter<Record<string, unknown>>,
  )
  registerLLMAdapter('bigmodel', bigmodelLLMAdapter)
  // URL 端点声明：chat 拼 /chat/completions（jsonRequest/streamSSE 协议常量消费）；models 不支持
  registerProviderUrlPattern('bigmodel', { chatEndpoint: '/chat/completions' })
}
