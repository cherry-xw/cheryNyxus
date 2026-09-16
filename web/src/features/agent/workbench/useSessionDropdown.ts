/**
 * 标题栏会话下拉分页逻辑（当前预设，chat.list scope=preset 分页）。
 * 打开时拉首页（limit=SESSION_PAGE_SIZE），滚动/按钮触发 loadMore 追加下一页；
 * 按 chatId 去重（分页边界重叠防御），total 用尽后 hasMore=false。
 */
import { computed, ref } from 'vue'
import { agentApi, type ChatSummary } from '@/application/backend/public'

export const SESSION_PAGE_SIZE = 20

export function useSessionDropdown(options: { presetId?: string; presetName?: string }) {
  const items = ref<ChatSummary[]>([])
  const total = ref(0)
  const loading = ref(false)
  const loadingMore = ref(false)
  const error = ref<string>()
  const seen = new Set<string>()

  const hasMore = computed(() => items.value.length < total.value)

  function pagedOptions(offset: number) {
    return {
      scope: 'preset' as const,
      ...(options.presetId ? { presetId: options.presetId } : {}),
      ...(options.presetName ? { preset: options.presetName } : {}),
      includePreview: true,
      limit: SESSION_PAGE_SIZE,
      offset,
    }
  }

  async function open(): Promise<void> {
    if (loading.value || loadingMore.value) return
    loading.value = true
    error.value = undefined
    try {
      const { chats, total: nextTotal } = await agentApi.listChatsPaged(pagedOptions(0))
      items.value = chats
      total.value = nextTotal
      seen.clear()
      for (const chat of chats) seen.add(chat.chatId)
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '会话列表加载失败'
    } finally {
      loading.value = false
    }
  }

  async function loadMore(): Promise<void> {
    if (loading.value || loadingMore.value || !hasMore.value) return
    loadingMore.value = true
    try {
      const { chats, total: nextTotal } = await agentApi.listChatsPaged(
        pagedOptions(items.value.length),
      )
      const fresh = chats.filter((chat) => !seen.has(chat.chatId))
      items.value = [...items.value, ...fresh]
      for (const chat of fresh) seen.add(chat.chatId)
      total.value = nextTotal
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '会话列表加载失败'
    } finally {
      loadingMore.value = false
    }
  }

  function reset(): void {
    items.value = []
    total.value = 0
    error.value = undefined
    seen.clear()
  }

  return { items, total, loading, loadingMore, error, hasMore, open, loadMore, reset }
}
