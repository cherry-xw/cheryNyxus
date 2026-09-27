import { computed, toValue, type ComputedRef, type MaybeRefOrGetter } from 'vue'
import { useChatSessionsStore, useInteractionsStore, useWorkspaceStore } from '@/stores'
import { useLiteStore } from '@/features/lite/public'
import { resolveWorkspaceRootChatId } from '@/features/agent/attention/public'

/**
 * useWorkbenchAttentionCount：树模式待处理交互计数（标题栏指示器数据源）。
 *
 * 与 useWorkbenchDialogController.currentAttentionCount 同口径——树视图模式下，
 * 当前窗口根会话（时间线 root 优先、窗口会话回退）内的 pending 审批/提问数量。
 * 对话/精简模式有各自的待处理入口（消息内 / 工具图标），计数归零、指示器不显示。
 *
 * 数据全部来自 Pinia store（窗口注册表 + 会话订阅 + 交互 store），
 * 因此 WorkbenchDialog 内部标题栏与外层标题栏（Electron 原生窗 WindowFrame、
 * 浏览器多窗 CyberWindow 的 title-actions）读取到的是同一份事实。
 */
export function useWorkbenchAttentionCount(
  windowId: MaybeRefOrGetter<string>,
): ComputedRef<number> {
  const workspace = useWorkspaceStore()
  const chatSessions = useChatSessionsStore()
  const interactions = useInteractionsStore()
  const liteStore = useLiteStore()
  return computed(() => {
    const id = toValue(windowId)
    // 视图门控与 WorkbenchDialog 的警告条一致：判定直接基于 viewMode（单一事实源
    // liteStore.viewModeByWindow），不依赖 treeRootChatId 加载时序
    if ((liteStore.viewModeByWindow[id] ?? 'tree') !== 'tree') return 0
    const chatId = workspace.workbenchWindows[id]?.chatId ?? ''
    if (!chatId) return 0
    // 根身份解析与控制器同口径：时间线 rootChatId 优先，窗口会话回退
    const root = resolveWorkspaceRootChatId(
      chatSessions.rootTimeline(chatId, 'tree')?.rootChatId,
      chatId,
    )
    return interactions.pending.filter((item) => item.rootChatId === root).length
  })
}
