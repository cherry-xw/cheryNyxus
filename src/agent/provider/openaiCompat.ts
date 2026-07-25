/**
 * OpenAI 兼容 provider 共享件：message adapter / sense adapter / RPM 限流 / ThinkingLevel 映射。
 *
 * 供 openai.ts（SDK 实现）和 bigmodel.ts（fetch 实现）复用，保证 OpenAI 兼容协议的行为一致。
 *
 * 详见 [docs/agent/provider.md](../../../docs/agent/provider.md) 「共享件」。
 */
import OpenAI from 'openai'
import type {
  ChatCompletion,
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions'
import type { ZodType } from 'zod'
import type { ThinkingLevel } from '@/core/llm/adapter'
import type { LLMResponse, LLMAttachment } from '@/core/message/adapter'
import type { Sense, SenseCallData, SenseFunction } from '@/core/sense'
import { buildBaseSenseFunction } from '@/core/sense/compiler/utils.js'
import { getRateLimiter } from '@/utils/rateLimiter.js'

// ========== RPM 限流 ==========

/**
 * RPM 限流：在发起 LLM 请求前按 (url, key) 滑动窗口节流。
 * rpm 未配置 / 非正数 / 无 url 时跳过（不限流）。
 */
export async function acquireRpm(options?: {
  rpm?: number
  url?: string
  key?: string
}): Promise<void> {
  const rpm = options?.rpm
  const url = options?.url
  if (!rpm || rpm <= 0 || !url) return
  await getRateLimiter(url, options.key, rpm).acquire()
}

// ========== ThinkingLevel 映射 ==========

/**
 * 把 ThinkingLevel 映射成 OpenAI o1 系列的 reasoning_effort 参数值。
 * - off / thinking / undefined → undefined（provider 省略该参数）
 *   - off = 显式关闭
 *   - thinking = 由模型/服务端决定，不传参
 * - low/medium/high → 返回对应字符串；xhigh 降级为 high（OpenAI 兼容端点未统一支持 max）
 *
 * 智谱 BigModel（open.bigmodel.cn）同样认 reasoning_effort；其他 OpenAI 兼容聚合端点亦然。
 * ollama 不走此映射（忽略 thinking 参数）。
 */
export function mapThinkingToReasoningEffort(
  level: ThinkingLevel | undefined,
): 'low' | 'medium' | 'high' | undefined {
  if (level === undefined || level === 'off' || level === 'on') return undefined
  if (level === 'xhigh') return 'high'
  return level
}

// ========== Message Adapter ==========

/**
 * OpenAI 兼容的 Message Provider Adapter：
 * - content/thinking 从完整响应提取
 * - extractStreamDelta/extractStreamThinking 从流式 chunk 提取
 * - buildMessages 把 LLMResponse[] + 可选 attachments 构造成 OpenAI 消息数组
 *
 * attachments 支持 image/video/audio（OpenAI 兼容端点：image_url/video_url/input_audio，均为 data URI base64）。
 * video_url / input_audio 是 SDK 类型里不存在的字段，用 `as unknown as` 强转。
 */
export function buildOpenAICompatibleMessages(
  history: LLMResponse[],
  attachments?: LLMAttachment[],
  includeReasoningContent: (message: LLMResponse) => boolean = () => false,
) {
  return history
    .filter((m) => !m.revoked)
    .map((m) => {
      if (m.role === 'sense') {
        // 如果被替换，使用 replace.content
        const content = m.replace?.state ? m.replace.content : m.content
        return {
          role: 'tool',
          content,
          tool_call_id: m.id,
        } as ChatCompletionMessageParam
      }
      if (m.role === 'assistant' && m.senseCalls && m.senseCalls.length > 0) {
        return {
          role: m.role,
          content: m.content || null,
          ...(includeReasoningContent(m) && m.thinking
            ? { reasoning_content: m.thinking }
            : {}),
          tool_calls: m.senseCalls.map((sc) => ({
            id: sc.id,
            type: 'function' as const,
            function: {
              name: sc.name,
              arguments: sc.arguments,
            },
          })),
        } as ChatCompletionMessageParam
      }
      if (m.role === 'assistant' && includeReasoningContent(m) && m.thinking) {
        return {
          role: 'assistant',
          content: m.content,
          reasoning_content: m.thinking,
        } as ChatCompletionMessageParam
      }
      // role（wait=true 子完成注入的角色回复）映射为 user：OpenAI 拒未知 role
      // 兼容旧历史消息 role:subagent（与 role 等价）
      const role = m.role === 'subagent' || m.role === 'role' ? 'user' : m.role
      // user 消息携带 attachments → 构造 OpenAI vision content array（多模态）
      if (role === 'user' && attachments && attachments.length > 0) {
        const parts: ChatCompletionContentPart[] = [{ type: 'text', text: m.content }]
        for (const att of attachments) {
          if (att.mimeType.startsWith('image/')) {
            parts.push({
              type: 'image_url',
              image_url: {
                url: `data:${att.mimeType};base64,${att.data.toString('base64')}`,
              },
            })
          } else if (att.mimeType.startsWith('video/')) {
            // video_url 不是 SDK 标准类型，用强转
            parts.push({
              type: 'video_url',
              video_url: {
                url: `data:${att.mimeType};base64,${att.data.toString('base64')}`,
              },
            } as unknown as ChatCompletionContentPart)
          } else if (att.mimeType.startsWith('audio/')) {
            // input_audio 是 OpenAI 语音输入格式
            parts.push({
              type: 'input_audio',
              input_audio: {
                data: att.data.toString('base64'),
                format: att.mimeType.split('/')[1] ?? 'wav',
              },
            } as unknown as ChatCompletionContentPart)
          }
        }
        return { role: 'user', content: parts } as ChatCompletionMessageParam
      }
      return {
        role,
        content: m.content,
      } as ChatCompletionMessageParam
    })
}

export const openaiMessageAdapterConfig = {
  content: (raw: ChatCompletion) => raw.choices[0]?.message?.content ?? '',

  thinking: (raw: ChatCompletion) => {
    const msg = raw.choices[0]?.message
    if (msg && 'reasoning_content' in msg && msg.reasoning_content) {
      return msg.reasoning_content as string
    }
    return undefined
  },

  extractStreamDelta: (chunk: OpenAI.Chat.Completions.ChatCompletionChunk) =>
    chunk.choices[0]?.delta?.content ?? '',

  extractStreamThinking: (chunk: OpenAI.Chat.Completions.ChatCompletionChunk) => {
    const delta = chunk.choices[0]?.delta
    if (delta && 'reasoning_content' in delta && delta.reasoning_content) {
      return delta.reasoning_content as string
    }
    return undefined
  },

  buildMessages: (history: LLMResponse[], attachments?: LLMAttachment[]) =>
    buildOpenAICompatibleMessages(history, attachments, (message) => message.role === 'assistant'),
}

// ========== Sense Adapter ==========

/**
 * OpenAI 兼容的 Sense Provider Adapter：
 * - buildSenses：转成 OpenAI tool 格式（加 strict:true）
 * - senseCalls：从完整响应提取 tool_calls
 * - extractSenseCallDeltas：从流式 chunk 提取 tool_calls 增量
 */
export const openaiSenseAdapterConfig = {
  buildSenses(senses: Sense<ZodType>[]): SenseFunction[] {
    return senses.map((s) => ({
      type: 'function',
      function: {
        ...buildBaseSenseFunction(s),
        strict: true,
      },
    }))
  },

  senseCalls(response: ChatCompletion): SenseCallData[] {
    const senseCalls = (response.choices?.[0]?.message?.tool_calls ??
      []) as OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall[]
    return senseCalls.map((sc, index) => ({
      index,
      id: sc.id ?? `sense-${index}`,
      name: sc.function?.name ?? undefined,
      arguments: sc.function?.arguments ?? '',
    }))
  },

  /**
   * 从流式 chunk 提取 sense call 增量
   * OpenAI 流式响应结构：choices[0].delta.tool_calls[]
   * 返回 SenseCallData（index 定位，arguments 为增量片段）
   */
  extractSenseCallDeltas(chunk: unknown): SenseCallData[] {
    const streamChunk = chunk as OpenAI.Chat.Completions.ChatCompletionChunk
    const deltas = streamChunk.choices?.[0]?.delta?.tool_calls ?? []
    return deltas.map((delta) => ({
      index: delta.index ?? 0,
      id: delta.id ?? `sense-${delta.index ?? 0}`,
      name: delta.function?.name ?? undefined,
      arguments: delta.function?.arguments ?? '',
    }))
  },
}
