import { computed, onScopeDispose, ref, watch, type MaybeRefOrGetter, type Ref, toValue } from 'vue'
import { ElMessage } from 'element-plus'
import { agentApi, type RootTimelineSnapshot } from '@/application/backend/public'
import { useAgentsStore, useChatSessionsStore, useConnectionStore } from '@/application/public'

export function useWorkbenchTreeSession(options: {
  windowId: string
  presetId: string
  presetName: MaybeRefOrGetter<string | null | undefined>
  isNyxus: MaybeRefOrGetter<boolean>
  chatId: MaybeRefOrGetter<string | null | undefined>
  taskTimeline: Ref<RootTimelineSnapshot | undefined>
  resetComposerBranch: () => void
  resetDraft: () => void
  setError: (message: string | null) => void
}) {
  const agents = useAgentsStore()
  const chatSessions = useChatSessionsStore()
  const connection = useConnectionStore()
  const treeRootChatId = ref('')
  const treeLoadError = ref<string | null>(null)
  const treeFocusSourceChatId = ref<string>()
  const treeFocusInteractionId = ref<string>()
  const treeFocusNonce = ref(0)
  const rootSubscriptionOwner = `workbench:${options.windowId}`

  function releaseCurrentRoot(): void {
    if (treeRootChatId.value) {
      void chatSessions.releaseRootTimeline(treeRootChatId.value, rootSubscriptionOwner)
    }
  }

  watch(
    () => agents.workbenchWindows[options.windowId]?.interactionFocus,
    (focus) => {
      if (!focus) return
      treeFocusSourceChatId.value = focus.sourceChatId
      treeFocusInteractionId.value = focus.anchorNodeId ?? focus.interactionId
      treeFocusNonce.value++
      agents.setWorkbenchWindowFocus(options.windowId, undefined)
    },
    { immediate: true },
  )
  watch(
    () => toValue(options.chatId),
    (chatId) => {
      if (!chatId) {
        treeRootChatId.value = ''
        treeLoadError.value = null
        options.taskTimeline.value = undefined
        treeFocusSourceChatId.value = undefined
        treeFocusInteractionId.value = undefined
        options.resetComposerBranch()
        return
      }
      options.resetDraft()
      treeRootChatId.value = chatId
      treeLoadError.value = null
      const summary = agents.historyList.find((item) => item.chatId === chatId)
      if (!summary?.taskId) {
        options.taskTimeline.value = undefined
        return
      }
      const requestedChatId = chatId
      options.taskTimeline.value = undefined
      void agentApi
        .getTaskTimeline({ taskId: summary.taskId, view: 'tree' })
        .then((snapshot) => {
          if (treeRootChatId.value === requestedChatId) options.taskTimeline.value = snapshot
        })
        .catch(() => {
          if (treeRootChatId.value === requestedChatId) options.taskTimeline.value = undefined
        })
    },
    { immediate: true },
  )
  watch(
    treeRootChatId,
    (rootChatId, previousRootChatId) => {
      if (!rootChatId) {
        if (previousRootChatId)
          void chatSessions.releaseRootTimeline(previousRootChatId, rootSubscriptionOwner)
        return
      }
      void observeTreeRoot(rootChatId, previousRootChatId)
    },
    { immediate: true },
  )

  async function observeTreeRoot(rootChatId: string, previousRootChatId?: string): Promise<void> {
    treeLoadError.value = null
    try {
      await chatSessions.acquireRootTimeline(rootChatId, rootSubscriptionOwner, 'tree')
      if (previousRootChatId && previousRootChatId !== rootChatId) {
        await chatSessions.releaseRootTimeline(previousRootChatId, rootSubscriptionOwner)
      }
      await chatSessions.ensureQuestionHydrated(rootChatId)
    } catch (cause) {
      if (treeRootChatId.value !== rootChatId) return
      treeLoadError.value = cause instanceof Error ? cause.message : '执行图加载失败，请重试'
      console.error('[WorkbenchDialog] observe root tree failed:', cause)
    }
  }

  const historyLoading = ref(false)
  async function onConnectionReady(): Promise<void> {
    if (!agents.historyList && !historyLoading.value) {
      historyLoading.value = true
      try {
        await agents.fetchHistoryList()
      } catch (cause) {
        console.warn('[WorkbenchDialog] fetchHistoryList 失败:', cause)
      } finally {
        historyLoading.value = false
      }
    }
    if (!toValue(options.chatId) && !treeRootChatId.value) {
      const latest = agents.latestRootInPreset(
        toValue(options.isNyxus) ? undefined : options.presetId,
        toValue(options.presetName) ?? undefined,
      )
      if (latest) agents.setWorkbenchWindowChat(options.windowId, latest)
    }
    const rootChatId = treeRootChatId.value
    if (rootChatId && !chatSessions.rootTimeline(rootChatId, 'tree')) {
      void observeTreeRoot(rootChatId)
    }
  }
  watch(
    () => connection.status,
    (status) => {
      if (status === 'connected') void onConnectionReady()
    },
    { immediate: true },
  )

  const treeLoading = computed(
    () =>
      !!treeRootChatId.value &&
      !chatSessions.rootTimeline(treeRootChatId.value, 'tree') &&
      !treeLoadError.value,
  )
  async function retryTree(): Promise<void> {
    const rootChatId = treeRootChatId.value
    if (!rootChatId) return
    await observeTreeRoot(rootChatId)
  }
  const creating = ref(false)
  async function switchSession(chatId: string): Promise<void> {
    if (!chatId) return
    agents.activeDialogSource = 'history'
    agents.activatePresetSession(options.presetId, chatId, toValue(options.presetName) ?? undefined)
    treeRootChatId.value = chatId
    if (chatId !== toValue(options.chatId)) agents.setWorkbenchWindowChat(options.windowId, chatId)
  }
  async function createSession(): Promise<void> {
    if (creating.value) return
    creating.value = true
    try {
      // 空白复用判定在后端（chat.create 默认启用，契约见 docs/shared/protocol/interactions.md）：命中同预设
      // turnCount===0 的 root 会话直接返回其 chatId（reused:true），前端无须区分，直接跳转。
      // 此前前端曾以 stage 目录的 turnCount 自行判空——stage lean 响应恒无 turnCount，判定恒真，
      // 导致「新建会话」永远复用当前会话而不发创建请求（2026-08-29 修复，判定移交后端）。
      // Nyxus 判定只用 isNyxus（按预设名比较）：presetId 是配置稳定 ID，不再与预设名比较。
      let chatId: string
      if (toValue(options.isNyxus)) chatId = await agents.createNyxusSession()
      else {
        const presetName = toValue(options.presetName)
        if (!presetName) throw new Error('工作台未关联到预设，无法新建会话，请在设置中配置预设')
        chatId = await agents.createMasterPet({ preset: presetName })
      }
      // 复用/新建都会改变目录（stage 每预设仅最新 1 root），switchSession 的 taskId 查询依赖目录
      await agents.fetchHistoryList()
      await switchSession(chatId)
    } catch (cause) {
      console.error('[WorkbenchDialog] createSession failed:', cause)
      const message = cause instanceof Error ? cause.message : '新建会话失败，请重试'
      options.setError(message)
      ElMessage.error(message)
    } finally {
      creating.value = false
    }
  }

  onScopeDispose(releaseCurrentRoot)

  return {
    connection,
    createSession,
    creating,
    historyLoading,
    releaseCurrentRoot,
    switchSession,
    treeFocusInteractionId,
    treeFocusNonce,
    treeFocusSourceChatId,
    treeLoading,
    treeLoadError,
    retryTree,
    treeRootChatId,
  }
}
