import { getChatPreviews, listAllChats } from '@/db/chat'
import { readFileSync } from 'node:fs'
import config, { isShadowRole } from '@/utils/config'
import { safeJsonParse } from '@/utils/json'
import { ShadowRunner } from '@/agent/shadow/ShadowRunner.js'
import {
  clearConversationSelectionRun,
  getConversationSelection,
  registerConversationSelectionRun,
  type ConversationSelection,
} from '@/agent/shadow/conversationSelectionRegistry.js'
import {
  createChunk,
  Method,
  type ChatRouteSuggestResponseData,
  type Chunk,
  type RouteDeltaData,
} from '../message/types.js'
import type { RpcRouter } from '../message/router.js'

const SHADOW_TIMEOUT_MS = 25_000
const MAX_CANDIDATES = 10

function loadShadowBackground(systemPromptFile?: string): string {
  return systemPromptFile ? readFileSync(systemPromptFile, 'utf8').trim() : ''
}

function presetForId(presetId: string) {
  return Object.entries(config.presets ?? {}).find(([, preset]) => preset.id === presetId)
}

export async function suggestConversationRoute(
  presetId: string,
  draft: string,
  requestVersion: number,
  onDelta?: (delta: RouteDeltaData) => void,
): Promise<ChatRouteSuggestResponseData> {
  const presetEntry = presetForId(presetId)
  if (!presetEntry) throw new Error('这个预设不见了')
  const [presetName, preset] = presetEntry
  const shadowName = preset.shadows?.conversationRouting
  if (!shadowName) throw new Error('当前预设没有配置会话路由 Shadow')
  const shadow = config.roles?.[shadowName]
  if (!isShadowRole(shadow)) throw new Error(`会话路由 Shadow "${shadowName}" 不存在`)

  const roots = listAllChats()
    .filter((chat) => !chat.parent_chat_id)
    .map((chat) => {
      const metadata = safeJsonParse(chat.metadata ?? '', {}) as {
        preset?: string
        presetId?: string
        lastUserActivityAt?: number
      }
      return { chat, metadata }
    })
    .filter(
      ({ metadata }) =>
        metadata.presetId === presetId || (!metadata.presetId && metadata.preset === presetName),
    )
    .sort(
      (a, b) =>
        (b.metadata.lastUserActivityAt ?? b.chat.updated_at) -
        (a.metadata.lastUserActivityAt ?? a.chat.updated_at),
    )
    .slice(0, MAX_CANDIDATES)
  const previews = getChatPreviews(roots.map(({ chat }) => chat))
  const candidates = roots.map(({ chat, metadata }) => ({
    chatId: chat.id,
    preview: previews.get(chat.id)?.preview ?? '',
    lastUserActivityAt: metadata.lastUserActivityAt ?? chat.updated_at,
  }))

  const systemPrompt = [
    loadShadowBackground(shadow.systemPrompt),
    '你是会话路由 Shadow。你的唯一任务是判断这条新消息应该继续哪个历史根会话，还是新建会话。',
    '你只能使用 select_conversation 工具结束流程；不得回答用户消息本身。',
    '选择历史会话时 chatId 必须逐字取自候选列表；没有合适候选时使用 chatId=null。',
    'confidence 是 0 到 1 的信息性判断，reason 用一句简短中文解释语义关联。',
  ]
    .filter(Boolean)
    .join('\n\n')
  const input = [
    `待发送消息：${draft}`,
    `候选历史（按最近活跃排序）：${JSON.stringify(candidates)}`,
    '现在调用 select_conversation 完成选择。',
  ].join('\n')
  const correctiveInput =
    '你尚未完成路由。不要输出说明或回答消息；现在必须调用一次 select_conversation。只能使用候选中的 chatId，或用 null 新建会话。'

  const runner = new ShadowRunner()
  const run = await runner
    .run<ConversationSelection>({
      roleName: shadowName,
      role: shadow,
      systemPrompt,
      input,
      correctiveInput,
      maxTurns: 2,
      timeoutMs: SHADOW_TIMEOUT_MS,
      setup: (runId) =>
        registerConversationSelectionRun(
          runId,
          candidates.map((candidate) => candidate.chatId),
        ),
      readResult: getConversationSelection,
      cleanup: clearConversationSelectionRun,
      // 转发 Shadow 的增量 thinking/content（调用方在前端累积，仅取 streaming 增量）。
      onChunk: (chunk) => {
        if (chunk.type !== 'stream') return
        onDelta?.({ thinking: chunk.thinkingDelta, content: chunk.contentDelta })
      },
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      if (/超时/.test(message)) throw new Error('对话路由超时，请手动选择目标')
      throw new Error(`对话路由失败：${message}，请手动选择目标`)
    })

  const content = [...run.messages]
    .reverse()
    .find((message) => message.role === 'assistant')
    ?.content.trim()
    .slice(0, 4000)
  const target = run.result
  return {
    requestVersion,
    target,
    trace: {
      context: { draft, candidates },
      response: {
        ...(content ? { content } : {}),
        toolCall: { name: 'select_conversation', arguments: target },
      },
    },
  }
}

/**
 * 极简 push-channel：把回调式增量流适配为 async-iterator，供流式 handler generator 消费。
 */
class PushChannel<T> {
  private queue: T[] = []
  private resolvers: Array<(entry: IteratorResult<T>) => void> = []
  private closed = false

  push(value: T): void {
    if (this.closed) return
    const r = this.resolvers.shift()
    if (r) r({ done: false, value })
    else this.queue.push(value)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const r of this.resolvers.splice(0)) r({ done: true, value: undefined })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const head = this.queue.shift()
        if (head !== undefined) return Promise.resolve({ done: false, value: head })
        if (this.closed) return Promise.resolve({ done: true, value: undefined })
        return new Promise((resolve) => this.resolvers.push(resolve))
      },
    }
  }
}

/** 流式推算：先实时 yield 路由 Shadow 的 thinking/content 增量，最后 yield 完整结果。 */
export async function* suggestConversationRouteStream(
  presetId: string,
  draft: string,
  requestVersion: number,
): AsyncGenerator<Chunk, ChatRouteSuggestResponseData, unknown> {
  const channel = new PushChannel<RouteDeltaData>()
  let error: unknown
  let final: ChatRouteSuggestResponseData | undefined
  const pending = suggestConversationRoute(presetId, draft, requestVersion, (delta) =>
    channel.push(delta),
  )
    .then((result) => {
      final = result
    })
    .catch((cause: unknown) => {
      error = cause
    })
    .finally(() => channel.close())

  for await (const delta of channel) {
    yield createChunk('route', presetId, { delta })
  }
  await pending
  if (error) throw error
  if (!final) throw new Error('会话路由未返回结果')
  yield createChunk('route', presetId, final)
  return final
}

export function registerConversationRouterHandlers(router: RpcRouter): void {
  router.register(Method.CHAT_ROUTE_SUGGEST, async function* (_ctx, data) {
    return yield* suggestConversationRouteStream(data.presetId, data.draft, data.requestVersion)
  })
}
