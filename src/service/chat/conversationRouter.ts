import type { LLMResponse } from '@/core/message/adapter'
import { getLLMAdapter } from '@/core/llm/adapter'
import { getMessageAdapter } from '@/core/message/adapter'
import { getChatPreviews, listAllChats } from '@/db/chat'
import config from '@/utils/config'
import { safeJsonParse } from '@/utils/json'
import { Method, type ChatRouteSuggestResponseData } from '../message/types.js'
import type { RpcRouter } from '../message/router.js'

const ROUTER_TIMEOUT_MS = 2500
const MAX_CANDIDATES = 10
const MAX_RESULTS = 3

type RouterShape = {
  candidates?: Array<{ chatId?: unknown; confidence?: unknown; reason?: unknown }>
}

function presetForId(presetId: string) {
  return Object.entries(config.presets ?? {}).find(([, preset]) => preset.id === presetId)
}

function stripFence(value: string): string {
  return value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
}

export async function suggestConversationRoute(
  presetId: string,
  draft: string,
  requestVersion: number,
): Promise<ChatRouteSuggestResponseData> {
  const presetEntry = presetForId(presetId)
  if (!presetEntry) throw new Error('这个预设不见了')
  const [presetName, preset] = presetEntry
  if (!preset.routingBrain) throw new Error('当前预设没有配置对话路由大脑')
  const brain = config.llm.brain[preset.routingBrain]
  if (!brain) throw new Error(`对话路由大脑 "${preset.routingBrain}" 不存在`)

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
        metadata.presetId === presetId ||
        (!metadata.presetId && metadata.preset === presetName),
    )
    .sort(
      (a, b) =>
        (b.metadata.lastUserActivityAt ?? b.chat.updated_at) -
        (a.metadata.lastUserActivityAt ?? a.chat.updated_at),
    )
    .slice(0, MAX_CANDIDATES)
  const previews = getChatPreviews(roots.map(({ chat }) => chat))
  const allowedIds = new Set(roots.map(({ chat }) => chat.id))
  const summaries = roots.map(({ chat, metadata }) => ({
    chatId: chat.id,
    preview: previews.get(chat.id)?.preview ?? '',
    lastUserActivityAt: metadata.lastUserActivityAt ?? chat.updated_at,
  }))

  const llm = getLLMAdapter(brain.provider)
  const messages = getMessageAdapter(brain.provider)
  if (!llm || !messages) throw new Error(`对话路由不支持 ${brain.provider} provider`)
  const now = Date.now()
  const prompt = [
    '你是对话路由器。根据用户新消息，从候选历史中选出最多三个最相关目标。',
    '也可以用 chatId=null 推荐新对话。只输出 JSON：',
    '{"candidates":[{"chatId":"候选ID或null","confidence":0到1,"reason":"简短原因"}]}',
    `用户消息：${draft}`,
    `候选历史：${JSON.stringify(summaries)}`,
  ].join('\n')
  const history: LLMResponse[] = [
    { id: `route-${requestVersion}`, role: 'user', content: prompt, createdAt: now, updateAt: now },
  ]
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ROUTER_TIMEOUT_MS)
  try {
    const raw = await Promise.race([
      llm.chat(messages.buildMessages(history), [], {
        model: brain.model,
        url: brain.url,
        key: brain.key,
        rpm: brain.rpm,
        brain: preset.routingBrain,
        thinking: 'off',
        signal: controller.signal,
      }),
      new Promise<never>((_, reject) => {
        const timeout = () => reject(new Error('对话路由超时，请手动选择目标'))
        if (controller.signal.aborted) timeout()
        else controller.signal.addEventListener('abort', timeout, { once: true })
      }),
    ])
    const parsed = JSON.parse(stripFence(messages.content(raw))) as RouterShape
    const candidates = (parsed.candidates ?? [])
      .flatMap((candidate) => {
        const chatId = candidate.chatId === null ? null : String(candidate.chatId ?? '')
        const confidence = Number(candidate.confidence)
        if ((chatId !== null && !allowedIds.has(chatId)) || !Number.isFinite(confidence)) return []
        return [
          {
            chatId,
            confidence: Math.max(0, Math.min(1, confidence)),
            reason: String(candidate.reason ?? '').slice(0, 80),
          },
        ]
      })
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, MAX_RESULTS)
    return { requestVersion, candidates }
  } finally {
    clearTimeout(timer)
  }
}

export function registerConversationRouterHandlers(router: RpcRouter): void {
  router.register(Method.CHAT_ROUTE_SUGGEST, async (_ctx, data) =>
    suggestConversationRoute(data.presetId, data.draft, data.requestVersion),
  )
}
