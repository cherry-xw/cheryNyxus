/**
 * OpenAI（含兼容服务）provider。
 *
 * LLMAdapter 用官方 SDK（保留原有依赖）；message/sense adapter 与 thinking 映射、RPM 限流、
 * 必填项校验复用 [openaiCompat](./openaiCompat.js) 与 [fetchBase](./fetchBase.js)。
 *
 * 思考参数：按 ThinkingLevel 映射为 reasoning_effort（off 省略）。
 * 历史问题：曾硬编码 `thinking: { type: "enabled" }`，被聚合端点忽略导致思考丢失；
 * 现按 reasoning_effort 映射（OpenAI o1 系 / 智谱 bigmodel / 兼容聚合端点均认）。
 *
 * 详见 [docs/agent/provider.md](../../../docs/agent/provider.md)。
 */
import OpenAI from 'openai'
import type { ChatCompletion, ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import { registerLLMAdapter, type LLMAdapter, type LLMOptions } from '@/core/llm/adapter'
import { registerProviderUrlPattern } from '@/core/llm/urlPattern'
import { registerMessageAdapter } from '@/core/message/adapter'
import { registerSenseAdapter, type SenseFunction } from '@/core/sense'
import {
  openaiMessageAdapterConfig,
  openaiSenseAdapterConfig,
  acquireRpm,
  mapThinkingToReasoningEffort,
} from './openaiCompat.js'
import { assertChatOptions, jsonRequest, resolveProviderUrl, streamSSE, classifyBrainError, wrapBrainStream } from './fetchBase.js'

// ========== LLM Adapter 定义 ==========

const openaiLLMAdapter: LLMAdapter = {
  async chat(messages: unknown[], senses: SenseFunction[], options?: LLMOptions): Promise<unknown> {
    const { model, url, key } = assertChatOptions(options)
    const msgArray = messages as ChatCompletionMessageParam[]
    const effort = mapThinkingToReasoningEffort(options?.thinking)
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
          ...(effort ? { reasoning_effort: effort } : {}),
          ...(senses.length > 0 && { tools: senses }),
        },
        key,
        options?.signal,
        { fullUrl: true },
      )
    }
    // 未勾选：SDK 自拼 /chat/completions，baseURL 原样（版本段由用户填写，见 resolveProviderUrl）
    const client = new OpenAI({
      baseURL: resolveProviderUrl('openai', url, { fullUrl: false, kind: 'chat' }),
      apiKey: key,
    })
    try {
      return await client.chat.completions.create({
        model,
        messages: msgArray,
        // 思考强度：low/medium/high → reasoning_effort；off/undefined 省略（非推理模型也安全）
        ...(effort ? { reasoning_effort: effort } : {}),
        ...(senses.length > 0 && { tools: senses }),
      })
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
    const effort = mapThinkingToReasoningEffort(options?.thinking)
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
          ...(effort ? { reasoning_effort: effort } : {}),
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
      const stream = await client.chat.completions.create(
        {
          model,
          messages: msgArray,
          stream: true,
          ...(effort ? { reasoning_effort: effort } : {}),
          ...(senses.length > 0 && { tools: senses }),
        },
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
