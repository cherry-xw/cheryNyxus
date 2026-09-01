/** OpenAI Responses API 协议 adapter（同样可用于透明兼容的中转与 MiniMax Responses）。 */
import { LlmProtocol } from '@chery/protocol'
import { registerLLMAdapter, type LLMAdapter, type LLMOptions } from '@/core/llm/adapter.js'
import {
  registerMessageAdapter,
  type BuildMessagesOptions,
  type LLMAttachment,
  type LLMResponse,
  type MessageProviderAdapterConfig,
} from '@/core/message/adapter.js'
import {
  registerSenseAdapter,
  type Sense,
  type SenseAdapter,
  type SenseCallData,
  type SenseFunction,
} from '@/core/sense/index.js'
import type { ZodType } from 'zod'
import { buildBaseSenseFunction } from '@/core/sense/compiler/utils.js'
import { registerProviderUrlPattern } from '@/core/llm/urlPattern.js'
import { acquireRpm } from './openaiCompat.js'
import { assertChatOptions, jsonRequest, streamSSE } from './fetchBase.js'

type ResponsesInputItem =
  | { role: 'system' | 'user' | 'assistant'; content: string | ResponsesInputPart[] }
  | { type: 'reasoning'; content: ResponsesReasoningPart[] }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string }

type ResponsesInputPart =
  { type: 'input_text'; text: string } | { type: 'input_image'; image_url: string }

type ResponsesReasoningPart = { type: 'reasoning_text'; text: string }

interface ResponsesOutputPart {
  type?: string
  text?: string
  content?: string
}

interface ResponsesOutputItem {
  type?: string
  id?: string
  call_id?: string
  name?: string
  arguments?: string
  content?: ResponsesOutputPart[] | string
  summary?: ResponsesOutputPart[]
  reasoning_content?: string
}

interface ResponsesResult {
  id?: string
  output?: ResponsesOutputItem[]
  output_text?: string
}

interface ResponsesStreamEvent {
  type?: string
  delta?: string
  output_index?: number
  item_id?: string
  call_id?: string
  item?: ResponsesOutputItem
  response?: ResponsesResult
}

function textFromParts(parts: ResponsesOutputPart[] | string | undefined): string {
  if (typeof parts === 'string') return parts
  return (parts ?? [])
    .filter((part) =>
      ['output_text', 'text', 'reasoning_text', 'summary_text'].includes(part.type ?? ''),
    )
    .map((part) => part.text ?? part.content ?? '')
    .join('')
}

function responseContent(raw: ResponsesResult): string {
  if (typeof raw.output_text === 'string') return raw.output_text
  return (raw.output ?? [])
    .filter((item) => item.type === 'message')
    .map((item) => textFromParts(item.content))
    .join('')
}

function responseThinking(raw: ResponsesResult): string | undefined {
  const text = (raw.output ?? [])
    .filter((item) => item.type === 'reasoning')
    .map((item) =>
      [item.reasoning_content ?? '', textFromParts(item.summary), textFromParts(item.content)].join(
        '',
      ),
    )
    .join('')
  return text || undefined
}

function buildResponsesInput(
  history: LLMResponse[],
  attachments?: LLMAttachment[],
  buildOptions?: BuildMessagesOptions,
): ResponsesInputItem[] {
  const input: ResponsesInputItem[] = []
  for (const message of history) {
    if (message.revoked) continue
    if (message.role === 'sense') {
      input.push({
        type: 'function_call_output',
        call_id: message.id,
        output: message.replace?.state ? message.replace.content : message.content,
      })
      continue
    }
    const role =
      message.role === 'role' || message.role === 'subagent'
        ? 'user'
        : message.role === 'system'
          ? 'system'
          : message.role === 'assistant'
            ? 'assistant'
            : 'user'
    if (
      role === 'assistant' &&
      message.thinking &&
      buildOptions?.reasoningHistory === 'reasoning-item'
    ) {
      input.push({
        type: 'reasoning',
        content: [{ type: 'reasoning_text', text: message.thinking }],
      })
    }
    if (message.content || !message.senseCalls?.length) {
      if (role === 'user' && attachments?.length) {
        const parts: ResponsesInputPart[] = [{ type: 'input_text', text: message.content }]
        for (const attachment of attachments) {
          if (!attachment.mimeType.startsWith('image/')) continue
          parts.push({
            type: 'input_image',
            image_url: `data:${attachment.mimeType};base64,${attachment.data.toString('base64')}`,
          })
        }
        input.push({ role, content: parts })
      } else {
        input.push({ role, content: message.content })
      }
    }
    for (const call of message.senseCalls ?? []) {
      input.push({
        type: 'function_call',
        call_id: call.id,
        name: call.name,
        arguments: call.arguments,
      })
    }
  }
  return input
}

const responsesMessageAdapter: MessageProviderAdapterConfig<
  ResponsesResult,
  ResponsesStreamEvent,
  ResponsesInputItem
> = {
  content: responseContent,
  thinking: responseThinking,
  extractStreamDelta: (event) =>
    event.type === 'response.output_text.delta' ? (event.delta ?? '') : '',
  extractStreamThinking: (event) =>
    event.type === 'response.reasoning_summary_text.delta' ||
    event.type === 'response.reasoning_text.delta' ||
    event.type === 'response.reasoning.delta'
      ? event.delta
      : undefined,
  buildMessages: buildResponsesInput,
}

const responsesSenseAdapter: SenseAdapter<ResponsesResult> = {
  buildSenses(senses: Sense<ZodType>[]): SenseFunction[] {
    return senses.map((sense) => ({
      type: 'function',
      function: { ...buildBaseSenseFunction(sense), strict: true },
    }))
  },
  senseCalls(response): SenseCallData[] {
    return (response.output ?? [])
      .filter((item) => item.type === 'function_call')
      .map((item, index) => ({
        index,
        id: item.call_id ?? item.id ?? `sense-${index}`,
        name: item.name,
        arguments: item.arguments ?? '',
      }))
  },
  extractSenseCallDeltas(chunk): SenseCallData[] {
    const event = chunk as ResponsesStreamEvent
    if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
      return [
        {
          index: event.output_index ?? 0,
          id: event.item.call_id ?? event.item.id ?? event.item_id ?? 'sense-0',
          name: event.item.name,
          arguments: event.item.arguments ?? '',
        },
      ]
    }
    if (event.type === 'response.function_call_arguments.delta') {
      return [
        {
          index: event.output_index ?? 0,
          id: event.call_id ?? event.item_id ?? `sense-${event.output_index ?? 0}`,
          arguments: event.delta ?? '',
        },
      ]
    }
    return []
  },
}

function responseTools(senses: SenseFunction[]): Record<string, unknown>[] {
  return senses.map((sense) => ({
    type: 'function',
    name: sense.function.name,
    description: sense.function.description,
    parameters: sense.function.parameters,
    strict: 'strict' in sense.function ? (sense.function as { strict?: boolean }).strict : true,
  }))
}

const responsesLLMAdapter: LLMAdapter = {
  async chat(messages, senses, options?: LLMOptions): Promise<unknown> {
    const { model, url, key } = assertChatOptions(options)
    await acquireRpm(options)
    return jsonRequest(
      url,
      {
        model,
        input: messages,
        ...(options?.thinkingParams ?? {}),
        ...(senses.length > 0 && { tools: responseTools(senses) }),
      },
      key,
      options?.signal,
      { fullUrl: options?.fullUrl === true, endpoint: '/responses' },
    )
  },
  async chatStream(messages, senses, options?: LLMOptions): Promise<AsyncIterable<unknown>> {
    const { model, url, key } = assertChatOptions(options)
    await acquireRpm(options)
    return streamSSE(
      url,
      {
        model,
        input: messages,
        stream: true,
        ...(options?.thinkingParams ?? {}),
        ...(senses.length > 0 && { tools: responseTools(senses) }),
      },
      key,
      options?.signal,
      { fullUrl: options?.fullUrl === true, endpoint: '/responses' },
    )
  },
}

export function registerOpenAIResponsesAdapter(): void {
  const key = LlmProtocol.OPENAI_RESPONSES
  registerMessageAdapter(key, responsesMessageAdapter)
  registerSenseAdapter(key, responsesSenseAdapter)
  registerLLMAdapter(key, responsesLLMAdapter)
  registerProviderUrlPattern(key, { chatEndpoint: '/responses', modelsEndpoint: '' })
}
