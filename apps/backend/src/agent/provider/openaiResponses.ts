/** OpenAI Responses API 协议 adapter（同样可用于透明兼容的中转与 MiniMax Responses）。 */
import { LlmProtocol } from '@chery/protocol'
import { registerLLMAdapter, type LLMAdapter, type LLMOptions } from '@/core/llm/adapter.js'
import {
  registerMessageAdapter,
  groupAttachmentsByMessage,
  orderedMessageInputs,
  type BuildMessagesOptions,
  type LLMAttachment,
  type LLMResponse,
  type MessageProviderAdapterConfig,
  type ServerToolCallDelta,
  type ServerToolCallInfo,
  type ServerToolSource,
} from '@/core/message/adapter.js'
import { sanitizeDisplayUrl, sanitizeServerToolText } from './anthropic.js'
import {
  registerSenseAdapter,
  type Sense,
  type SenseAdapter,
  type SenseCallData,
  type SenseFunction,
} from '@/core/sense/index.js'
import type { ZodType } from 'zod'
import { buildBaseSenseFunction, supportsStrictToolSchema } from '@/core/sense/compiler/utils.js'
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
  | { type: 'input_file'; filename: string; file_data: string }

type ResponsesReasoningPart = { type: 'reasoning_text'; text: string }

interface ResponsesAnnotation {
  type?: string
  url?: string
  title?: string
}

interface ResponsesOutputPart {
  type?: string
  text?: string
  content?: string
  annotations?: ResponsesAnnotation[]
}

interface ResponsesWebSearchAction {
  type?: string
  query?: string
  queries?: string[]
  url?: string
  pattern?: string
  sources?: Array<{ url?: string; title?: string; snippet?: string }>
}

interface ResponsesOutputItem {
  type?: string
  id?: string
  call_id?: string
  name?: string
  arguments?: string
  status?: string
  action?: ResponsesWebSearchAction
  content?: ResponsesOutputPart[] | string
  summary?: ResponsesOutputPart[]
  reasoning_content?: string
}

interface ResponsesResult {
  id?: string
  status?: string
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
  part?: ResponsesOutputPart
  annotation?: ResponsesAnnotation
  response?: ResponsesResult
}

function extractCitationsFromParts(parts: ResponsesOutputPart[] | string | undefined): ServerToolSource[] {
  if (!Array.isArray(parts)) return []
  const sources: ServerToolSource[] = []
  const seen = new Set<string>()
  for (const part of parts) {
    for (const ann of part.annotations ?? []) {
      if (ann.type === 'url_citation' && typeof ann.url === 'string' && ann.url) {
        const cleanUrl = sanitizeDisplayUrl(ann.url)
        if (!seen.has(cleanUrl)) {
          seen.add(cleanUrl)
          sources.push({
            url: cleanUrl,
            ...(ann.title ? { title: sanitizeServerToolText(ann.title) } : {}),
          })
        }
      }
    }
  }
  return sources
}

function extractActionSources(action?: ResponsesWebSearchAction): ServerToolSource[] {
  if (!action?.sources || !Array.isArray(action.sources)) return []
  const out: ServerToolSource[] = []
  const seen = new Set<string>()
  for (const src of action.sources) {
    if (typeof src?.url === 'string' && src.url) {
      const cleanUrl = sanitizeDisplayUrl(src.url)
      if (!seen.has(cleanUrl)) {
        seen.add(cleanUrl)
        out.push({
          url: cleanUrl,
          ...(src.title ? { title: sanitizeServerToolText(src.title) } : {}),
          ...(src.snippet ? { snippet: sanitizeServerToolText(src.snippet) } : {}),
        })
      }
    }
  }
  return out
}

function formatWebSearchActionArgs(action?: ResponsesWebSearchAction): string {
  if (!action || typeof action !== 'object') return '{}'
  const copy: Record<string, unknown> = {}
  if (action.type) copy.type = action.type
  if (action.query) copy.query = action.query
  if (Array.isArray(action.queries) && action.queries.length > 0) copy.queries = action.queries
  if (action.url) copy.url = sanitizeDisplayUrl(action.url)
  if (action.pattern) copy.pattern = action.pattern
  return sanitizeServerToolText(JSON.stringify(copy))
}

function formatWebSearchResultSummary(
  action: ResponsesWebSearchAction | undefined,
  sources: ServerToolSource[],
  status: string | undefined,
): string {
  if (status === 'failed') return '云端搜索执行失败'
  const lines: string[] = []
  if (action?.type === 'open_page' && action.url) {
    lines.push(`已请求打开页面：${sanitizeDisplayUrl(action.url)}`)
  } else if (action?.type === 'find_in_page' && action.pattern) {
    lines.push(`页内查找：${action.pattern}`)
  } else if (action?.query) {
    lines.push(`搜索查询：${action.query}`)
  }
  if (sources.length > 0) {
    lines.push(
      `来源引用（${sources.length}）：`,
      ...sources.map((s, idx) => `${idx + 1}. ${s.title ? `${s.title} - ` : ''}${s.url}`),
    )
  } else if (lines.length === 0) {
    lines.push(status === 'completed' ? '服务端搜索已完成' : '服务端搜索处理中')
  }
  return sanitizeServerToolText(lines.join('\n'))
}

function webSearchStatus(status: string | undefined): Exclude<ServerToolCallInfo['status'], 'skipped-local'> {
  if (status === 'completed' || status === 'failed') return status
  if (status === 'in_progress' || status === 'searching') return 'started'
  return 'unknown'
}

function extractResponsesServerToolCalls(raw: ResponsesResult | undefined): ServerToolCallInfo[] {
  if (!raw?.output || !Array.isArray(raw.output)) return []
  const messageCitations: ServerToolSource[] = []
  for (const item of raw.output) {
    if (item.type === 'message') {
      for (const c of extractCitationsFromParts(item.content)) {
        if (!messageCitations.some((existing) => existing.url === c.url)) {
          messageCitations.push(c)
        }
      }
    }
  }
  const calls: ServerToolCallInfo[] = []
  for (const [index, item] of raw.output.entries()) {
    if (item.type !== 'web_search_call') continue
    const actionSources = extractActionSources(item.action)
    const combinedSources = [...actionSources]
    for (const c of messageCitations) {
      if (!combinedSources.some((existing) => existing.url === c.url)) {
        combinedSources.push(c)
      }
    }
    const status = webSearchStatus(item.status)
    calls.push({
      id: item.id ?? item.call_id ?? `ws-${index}`,
      name: 'web_search_call',
      arguments: formatWebSearchActionArgs(item.action),
      executionOwner: 'server',
      status,
      result: formatWebSearchResultSummary(item.action, combinedSources, item.status),
      ...(combinedSources.length > 0 ? { sources: combinedSources } : {}),
      protocol: 'openai-responses',
      ...(raw.id ? { responseId: raw.id } : {}),
      index,
    })
  }
  return calls
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
  const visible = history.filter((m) => !m.revoked)
  const lastUser = [...visible].reverse().find((m) => m.role === 'user')
  const attachmentsByMessage = groupAttachmentsByMessage(attachments, lastUser?.id)
  for (const message of visible) {
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
      const myAttachments = role === 'user' ? attachmentsByMessage.get(message.id) : undefined
      if (myAttachments && myAttachments.length > 0) {
        const parts: ResponsesInputPart[] = []
        for (const segment of orderedMessageInputs(message, myAttachments)) {
          if (segment.type === 'text') { parts.push({ type: 'input_text', text: segment.text }); continue }
          const attachment = segment.attachment
          if (attachment.mimeType === 'application/pdf') {
            parts.push({ type: 'input_file', filename: 'document.pdf', file_data: `data:application/pdf;base64,${attachment.data.toString('base64')}` })
            continue
          }
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
      if (call.executionOwner === 'server' || call.serverState === 'skipped-local') continue
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
  stopReason: (raw) => raw.status,
  serverToolCalls: (raw) => {
    const calls = extractResponsesServerToolCalls(raw)
    return calls.length > 0 ? calls : undefined
  },
  extractStreamDelta: (event) =>
    event.type === 'response.output_text.delta' ? (event.delta ?? '') : '',
  extractStreamThinking: (event) =>
    event.type === 'response.reasoning_summary_text.delta' ||
    event.type === 'response.reasoning_text.delta' ||
    event.type === 'response.reasoning.delta'
      ? event.delta
      : undefined,
  extractStreamStopReason: (event) =>
    event.type === 'response.completed' ? (event.response?.status ?? 'completed') : undefined,
  extractStreamServerToolDeltas: (event): ServerToolCallDelta[] | undefined => {
    if (
      (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') &&
      event.item?.type === 'web_search_call'
    ) {
      const item = event.item
      const id = item.id ?? event.item_id ?? `ws-${event.output_index ?? 0}`
      const index = event.output_index ?? 0
      const sources = extractActionSources(item.action)
      const isDone = event.type === 'response.output_item.done' || item.status === 'completed' || item.status === 'failed'
      const status = webSearchStatus(item.status)
      const deltas: ServerToolCallDelta[] = [
        {
          kind: 'start',
          index,
          id,
          name: 'web_search_call',
          arguments: formatWebSearchActionArgs(item.action),
          status,
          protocol: 'openai-responses',
        },
      ]
      if (isDone) {
        deltas.push({
          kind: 'result',
          index,
          callId: id,
          name: 'web_search_call',
          status: status === 'started' ? 'unknown' : status,
          result: formatWebSearchResultSummary(item.action, sources, item.status),
          ...(sources.length > 0 ? { sources } : {}),
        })
      }
      return deltas
    }
    if (
      event.type === 'response.web_search_call.in_progress' ||
      event.type === 'response.web_search_call.searching' ||
      event.type === 'response.web_search_call.completed'
    ) {
      const id = event.item_id ?? event.call_id ?? `ws-${event.output_index ?? 0}`
      const index = event.output_index ?? 0
      if (event.type === 'response.web_search_call.completed') {
        return [
          {
            kind: 'result',
            index,
            callId: id,
            name: 'web_search_call',
            status: 'completed',
          },
        ]
      }
      return [
        {
          kind: 'start',
          index,
          id,
          name: 'web_search_call',
          status: 'started',
          protocol: 'openai-responses',
        },
      ]
    }
    if (
      event.type === 'response.output_text.annotation.added' &&
      event.annotation?.type === 'url_citation' &&
      typeof event.annotation.url === 'string'
    ) {
      return [
        {
          kind: 'citations',
          sources: [
            {
              url: sanitizeDisplayUrl(event.annotation.url),
              ...(event.annotation.title ? { title: sanitizeServerToolText(event.annotation.title) } : {}),
            },
          ],
        },
      ]
    }
    if (event.type === 'response.completed' && event.response) {
      const finalCalls = extractResponsesServerToolCalls(event.response)
      if (finalCalls.length > 0) {
        return finalCalls.flatMap((c): ServerToolCallDelta[] => [
          {
            kind: 'start',
            index: c.index ?? 0,
            id: c.id,
            name: c.name,
            arguments: c.arguments,
            status: c.status,
            protocol: 'openai-responses',
            ...(c.responseId ? { responseId: c.responseId } : {}),
          },
          {
            kind: 'result',
            index: c.index ?? 0,
            callId: c.id,
            name: c.name,
            status: c.status === 'completed' || c.status === 'failed' ? c.status : 'unknown',
            result: c.result,
            ...(c.sources ? { sources: c.sources } : {}),
          },
        ])
      }
    }
    return undefined
  },
  buildMessages: buildResponsesInput,
}

const responsesSenseAdapter: SenseAdapter<ResponsesResult> = {
  buildSenses(senses: Sense<ZodType>[]): SenseFunction[] {
    return senses.map((sense) => {
      const definition = buildBaseSenseFunction(sense)
      return {
        type: 'function',
        function: {
          ...definition,
          strict: supportsStrictToolSchema(definition.parameters),
        },
      }
    })
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

function isGptModel(model: string): boolean {
  return /(?:^|[/_.:-])gpt[-_.]?\d/i.test(model)
}

function responseTools(senses: SenseFunction[], model?: string): Record<string, unknown>[] {
  const useHostedWebSearch = model ? isGptModel(model) : false
  return senses.map((sense) => {
    if (useHostedWebSearch && sense.function.name === 'web_search') {
      return {
        type: 'web_search',
        external_web_access: true,
      }
    }
    return {
      type: 'function',
      name: sense.function.name,
      description: sense.function.description,
      parameters: sense.function.parameters,
      strict: supportsStrictToolSchema(sense.function.parameters),
    }
  })
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
        ...(senses.length > 0 && { tools: responseTools(senses, model) }),
      },
      key,
      options?.signal,
      {
        fullUrl: options?.fullUrl === true,
        endpoint: '/responses',
        observation: options?.observation,
        hookOptions: { ...options!, protocol: 'openai-responses' },
      },
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
        ...(senses.length > 0 && { tools: responseTools(senses, model) }),
      },
      key,
      options?.signal,
      {
        fullUrl: options?.fullUrl === true,
        endpoint: '/responses',
        observation: options?.observation,
        hookOptions: { ...options!, protocol: 'openai-responses' },
      },
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
