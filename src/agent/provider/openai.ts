/**
 * OpenAI（含兼容服务）provider。
 *
 * LLMAdapter 用官方 SDK（保留原有依赖）；message/sense adapter、RPM 限流、必填项校验
 * 复用 [openaiCompat](./openaiCompat.js) 与 [fetchBase](./fetchBase.js)。
 *
 * thinking 参数：provider 不内置档位词映射——chat middleware 统一把显示词翻译成
 * `options.thinkingParams` 片段（翻译表 .chery/model-thinking.yaml），此处只原样 spread 进请求体。
 *
 * 详见 [docs/agent/provider.md](../../../docs/agent/provider.md)。
 */
import OpenAI from 'openai'
import type { ChatCompletion, ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import { registerLLMAdapter, type LLMAdapter, type LLMOptions } from '@/core/llm/adapter'
import { registerProviderUrlPattern } from '@/core/llm/urlPattern'
import { registerMessageAdapter } from '@/core/message/adapter'
import { registerSenseAdapter, type SenseFunction } from '@/core/sense'
import { openaiMessageAdapterConfig, openaiSenseAdapterConfig, acquireRpm } from './openaiCompat.js'
import { assertChatOptions, jsonRequest, resolveProviderUrl, streamSSE, classifyBrainError, wrapBrainStream } from './fetchBase.js'

// ========== LLM Adapter 定义 ==========

const openaiLLMAdapter: LLMAdapter = {
  async chat(messages: unknown[], senses: SenseFunction[], options?: LLMOptions): Promise<unknown> {
    const { model, url, key } = assertChatOptions(options)
    const msgArray = messages as ChatCompletionMessageParam[]
    await acquireRpm(options)
    const fullUrl = options?.fullUrl === true
    if (fullUrl) {
      // fullUrl=true：绕开 SDK（SDK 强制拼 /chat/completions），原生 fetch 直接请求用户填写的
      // URL——实际请求 = 用户值本身，与 bigmodel/deepseek 的 fetch 路径一致（docs/agent/provider.md）。
      return jsonRequest(
        url,
        {
          model,
          messages: msgArray,
          ...(options?.thinkingParams ?? {}),
          ...(senses.length > 0 && { tools: senses }),
        },
        key,
        options?.signal,
        { fullUrl: true },
      )
    }
    // 未勾选：SDK 自拼 /chat/completions，baseURL 原样（版本段由用户填写，见 resolveProviderUrl）
    // thinkingParams 含 SDK 类型未声明的协议字段（如 MiniMax thinking/reasoning_split），整体 cast
    const client = new OpenAI({
      baseURL: resolveProviderUrl('openai', url, { fullUrl: false, kind: 'chat' }),
      apiKey: key,
    })
    try {
      const params: Record<string, unknown> = {
        model,
        messages: msgArray,
        ...(options?.thinkingParams ?? {}),
        ...(senses.length > 0 && { tools: senses }),
      }
      return await client.chat.completions.create(
        params as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
      )
    } catch (err) {
      throw classifyBrainError(err)
    }
  },
  async chatStream(
    messages: unknown[],
    senses: SenseFunction[],
    options?: LLMOptions,
  ): Promise<AsyncIterable<unknown>> {
    const { model, url, key } = assertChatOptions(options)
    const msgArray = messages as ChatCompletionMessageParam[]
    await acquireRpm(options)
    const fullUrl = options?.fullUrl === true
    if (fullUrl) {
      // fullUrl=true：绕开 SDK，原生 SSE 直接请求用户填写的 URL（实际请求 = 用户值本身）
      return streamSSE(
        url,
        {
          model,
          messages: msgArray,
          stream: true,
          ...(options?.thinkingParams ?? {}),
          ...(senses.length > 0 && { tools: senses }),
        },
        key,
        options?.signal,
        { fullUrl: true },
      )
    }
    const client = new OpenAI({
      baseURL: resolveProviderUrl('openai', url, { fullUrl: false, kind: 'chat' }),
      apiKey: key,
    })
    try {
      // thinkingParams 含 SDK 类型未声明的协议字段，整体 cast（同 chat）
      const params: Record<string, unknown> = {
        model,
        messages: msgArray,
        stream: true,
        ...(options?.thinkingParams ?? {}),
        ...(senses.length > 0 && { tools: senses }),
      }
      const stream = await client.chat.completions.create(
        params as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
        options?.signal ? { signal: options.signal } : undefined,
      )
      // 包裹迭代：流中途抛错（连接中断/限流/鉴权）映射为大脑 ClassifiedError，避免裸抛漏到 compose 兜底。
      return wrapBrainStream(stream as AsyncIterable<unknown>)
    } catch (err) {
      throw classifyBrainError(err)
    }
  },
}

// ========== 注册函数 ==========
export function registerOpenAIAdapter(): void {
  registerMessageAdapter<
    ChatCompletion,
    OpenAI.Chat.Completions.ChatCompletionChunk,
    ChatCompletionMessageParam
  >('openai', openaiMessageAdapterConfig)
  registerSenseAdapter<ChatCompletion>('openai', openaiSenseAdapterConfig)
  registerLLMAdapter('openai', openaiLLMAdapter)
  // URL 端点声明：SDK 自拼端点，base 原样（''）；chat/models 同规则
  registerProviderUrlPattern('openai', { chatEndpoint: '', modelsEndpoint: '' })
}
