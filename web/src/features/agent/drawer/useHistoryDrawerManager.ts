import { computed, inject, type ComputedRef, type InjectionKey } from 'vue'
import { useAgentsStore, useChatSessionsStore } from '@/stores'
import type { HistoryItem } from '@/stores/agents'

/**
 * useHistoryDrawerManager：历史抽屉跨层管理层。
 *
 * 设计动机（CP4 演进）：spawn 多级下钻需要"点击子会话 → 打开新抽屉盖在当前之上"。
 * 渲染器（SpawnRenderer）触发下钻时不直接耦合 store 数据层，而是经本管理层（App 顶层
 * provide、任意后代 inject）。管理层同时是消息缓存的天然承载点（当前预留，未启用）。
 *
 * 三项职责：
 * 1. 跨层下发（provide/inject）：渲染器 / panel / container inject 同一实例，统一栈操作入口。
 * 2. 抽屉栈门面：转发 store uiState 的栈 actions（openRoot / drillChild / closeTop / closeAll）。
 * 3. 历史加载 + 缓存预留：loadHistory 透传 store.getHistory；historyCache 接口预留命中逻辑，
 *    实时对话一致性需脏标记/版本号失效配合，当前一律全量，避免陈旧。
 *
 * 详见 docs/web/pet/agent-integration.md CP4、docs/web/renderer.md「跨层服务」。
 */

/** 缓存条目结构（预留，当前 loadHistory 不启用命中）。 */
export interface HistoryCacheEntry {
  /** 已合并去重排序的 HistoryItem[]（store.getHistory 的最终 stream.history）。 */
  items: HistoryItem[]
  /** 写入缓存的时间戳（命中 TTL 判断用，预留）。 */
  ts: number
}

export interface HistoryDrawerManager {
  /** 抽屉栈（只读 computed；栈底=根，栈顶=当前可见层）。 */
  stack: ComputedRef<string[]>
  /** 打开根抽屉（PetStage 从 pet 列表打开）：重置栈为单元素。 */
  openRoot: (chatId: string) => void
  /** 下钻子 chat（SpawnRenderer「详情」）：push 栈顶。 */
  drillChild: (chatId: string) => void
  /** 关闭栈顶（✕ / 遮罩 / ESC）：逐层返回。 */
  closeTop: () => void
  /** 关闭全部抽屉。 */
  closeAll: () => void
  /** 加载 chat 历史（当前透传 store.getHistory 全量；缓存命中待后续启用）。 */
  loadHistory: (chatId: string) => Promise<void>
  /** 消息缓存（预留）：chatId → { items, ts }。当前 loadHistory 不读写命中，仅占位供后续接入。 */
  historyCache: Map<string, HistoryCacheEntry>
}

/** provide/inject key（Symbol 唯一标识）。 */
export const HISTORY_DRAWER_MANAGER_KEY: InjectionKey<HistoryDrawerManager> =
  Symbol('HistoryDrawerManager')

/**
 * 创建 manager 实例（App 顶层调一次，provide 给全局）。
 * 内部 useAgentsStore（pinia 单例）；historyCache 随实例存活（单例）。
 */
export function createHistoryDrawerManager(): HistoryDrawerManager {
  const store = useAgentsStore()
  const chatSessions = useChatSessionsStore()
  const historyCache = new Map<string, HistoryCacheEntry>()

  return {
    stack: computed(() => store.historyDrawerStack),
    openRoot: (chatId: string) => store.openHistoryRoot(chatId),
    drillChild: (chatId: string) => store.drillHistoryChild(chatId),
    closeTop: () => store.closeHistoryTop(),
    closeAll: () => store.closeAllHistory(),
    async loadHistory(chatId: string) {
      // V2 timeline is authoritative. Open the root and all currently known
      // descendants so group selectors can aggregate canonical messages without
      // replaying legacy chat.get/staged history.
      const ids = new Set<string>([chatId])
      for (const pet of store.pets) {
        let parent = pet.parentChatId
        const seen = new Set<string>()
        while (parent && !seen.has(parent)) {
          if (parent === chatId) {
            ids.add(pet.chatId)
            break
          }
          seen.add(parent)
          parent = store.pets.find((candidate) => candidate.chatId === parent)?.parentChatId
        }
      }
      await Promise.all([...ids].map((id) => chatSessions.openSession(id)))
      // Root projection is the authoritative group history. Child sessions are
      // still opened for direct/ghost views and active runtime state.
      await chatSessions.openRootTimeline(chatId, 'conversation')
    },
    historyCache,
  }
}

/** 后代组件 inject manager（未 provide 则 fail loud）。 */
export function useHistoryDrawerManager(): HistoryDrawerManager {
  const mgr = inject(HISTORY_DRAWER_MANAGER_KEY)
  if (!mgr) {
    throw new Error(
      '[useHistoryDrawerManager] 未 provide：App 顶层需 createHistoryDrawerManager() + provide(HISTORY_DRAWER_MANAGER_KEY, ...)',
    )
  }
  return mgr
}
