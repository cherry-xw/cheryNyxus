import { computed, onScopeDispose, ref, watch, type MaybeRefOrGetter, type Ref, toValue } from 'vue'
import { ElMessage } from 'element-plus'
import { agentApi, type InteractionRecord, type RootTimelineSnapshot } from '@/application/backend/public'
import { useAgentsStore, useChatSessionsStore, useConnectionStore } from '@/application/public'
import { CHERY_NYXUS_PRESET } from '@/domain/pets/presets'
import type { PendingInteractionFocus } from '../attention/public'

export function useWorkbenchTreeSession(options: {
  windowId: string
  presetId: string
  presetName: MaybeRefOrGetter<string | null | undefined>
  isNyxus: MaybeRefOrGetter<boolean>
  chatId: MaybeRefOrGetter<string | null | undefined>
  taskTimeline: Ref<RootTimelineSnapshot | undefined>
  drawerAnchor: () => { top: number; left: number; width: number; height: number } | null
  resetComposerBranch: () => void
  resetDraft: () => void
  setError: (message: string | null) => void
}) {
  const agents = useAgentsStore()
  const chatSessions = useChatSessionsStore()
  const connection = useConnectionStore()
  const treeRootChatId = ref('')
  const treeFocusSourceChatId = ref<string>()
  const treeFocusInteractionId = ref<string>()
  const treeFocusedInteraction = ref<PendingInteractionFocus>()
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
      agents.setWorkbenchWindowFocus(options.windowId, undefined)
    },
    { immediate: true },
  )
  watch(
    () => toValue(options.chatId),
    (chatId) => {
      if (!chatId) {
        treeRootChatId.value = ''
        options.taskTimeline.value = undefined
        treeFocusSourceChatId.value = undefined
        treeFocusInteractionId.value = undefined
        options.resetComposerBranch()
        return
      }
      options.resetDraft()
      treeRootChatId.value = chatId
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
      void chatSessions
        .acquireRootTimeline(rootChatId, rootSubscriptionOwner, 'tree')
        .then(async () => {
          if (previousRootChatId && previousRootChatId !== rootChatId) {
            await chatSessions.releaseRootTimeline(previousRootChatId, rootSubscriptionOwner)
          }
          void chatSessions.ensureQuestionHydrated(rootChatId)
        })
        .catch((cause) => console.error('[WorkbenchDialog] observe root tree failed:', cause))
    },
    { immediate: true },
  )

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
      void chatSessions
        .acquireRootTimeline(rootChatId, rootSubscriptionOwner, 'tree')
        .then(() => void chatSessions.ensureQuestionHydrated(rootChatId))
        .catch((cause) => console.error('[WorkbenchDialog] retry observe root tree failed:', cause))
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
    () => !!treeRootChatId.value && !chatSessions.rootTimeline(treeRootChatId.value, 'tree'),
  )
  const creating = ref(false)
  async function switchSession(chatId: string): Promise<void> {
    if (!chatId) return
    agents.activeDialogSource = 'history'
    agents.activatePresetSession(options.presetId, chatId, toValue(options.presetName) ?? undefined)
    treeRootChatId.value = chatId
    if (chatId !== toValue(options.chatId)) agents.setWorkbenchWindowChat(options.windowId, chatId)
    try {
      if (agents.historyDrawerStack.length > 0) {
        agents.openHistoryRoot(chatId, agents.historyDrawerMode, options.drawerAnchor())
      }
    } catch (cause) {
      console.error('[WorkbenchDialog] switch session failed:', cause)
    }
  }
  async function openWorkspaceTree(
    rootChatId: string,
    sourceChatId?: string,
    interactionId?: string,
    anchorNodeId?: string,
  ): Promise<void> {
    treeFocusSourceChatId.value = sourceChatId
    treeFocusInteractionId.value = anchorNodeId ?? interactionId
    agents.setWorkbenchWindowView(options.windowId, 'tree')
    await switchSession(rootChatId)
  }
  function locateInteraction(item: InteractionRecord): void {
    const rootChatId = item.rootChatId
    treeFocusedInteraction.value = {
      chatId: item.chatId,
      interactionId: item.interactionId,
      anchorNodeId: item.anchorNodeId,
    }
    if (rootChatId && rootChatId === treeRootChatId.value) {
      treeFocusSourceChatId.value = item.chatId
      treeFocusInteractionId.value = item.anchorNodeId ?? item.interactionId
      agents.setWorkbenchWindowView(options.windowId, 'tree')
      return
    }
    void openWorkspaceTree(rootChatId, item.chatId, item.interactionId, item.anchorNodeId)
  }
  function onTreeInteractionFocus(focus: PendingInteractionFocus): void {
    treeFocusedInteraction.value = focus
  }
  async function deletePresetSession(chatId: string): Promise<void> {
    if (!chatId) return
    try {
      await agents.deleteSession(chatId)
      ElMessage.success('会话已删除')
    } catch (cause) {
      console.error('[WorkbenchDialog] deletePresetSession failed:', cause)
      const message = '删除会话失败，请重试'
      options.setError(message)
      ElMessage.error(message)
    }
  }
  async function createSession(): Promise<void> {
    if (creating.value) return
    creating.value = true
    try {
      await agents.fetchHistoryList()
      const isNyxusWindow = options.presetId === CHERY_NYXUS_PRESET
      const blank = agents.historyList.find(
        (session) =>
          !session.parentChatId &&
          (isNyxusWindow
            ? session.preset === CHERY_NYXUS_PRESET
            : session.presetId === options.presetId) &&
          (session.turnCount ?? 0) === 0,
      )
      let chatId: string
      if (blank) chatId = blank.chatId
      else if (isNyxusWindow || toValue(options.isNyxus)) chatId = await agents.createNyxusSession()
      else {
        const presetName = toValue(options.presetName)
        if (!presetName) throw new Error('工作台未关联到预设，无法新建会话，请在设置中配置预设')
        chatId = await agents.createMasterPet({ preset: presetName })
      }
      if (!blank) await agents.fetchHistoryList()
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
  async function deleteNyxusSession(chatId: string): Promise<void> {
    await deletePresetSession(chatId)
  }

  onScopeDispose(releaseCurrentRoot)

  return {
    connection,
    createSession,
    creating,
    deleteNyxusSession,
    deletePresetSession,
    historyLoading,
    locateInteraction,
    onTreeInteractionFocus,
    releaseCurrentRoot,
    switchSession,
    treeFocusedInteraction,
    treeFocusInteractionId,
    treeFocusSourceChatId,
    treeLoading,
    treeRootChatId,
  }
}
