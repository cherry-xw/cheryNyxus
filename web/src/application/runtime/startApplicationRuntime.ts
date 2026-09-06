import { watch } from 'vue'
import {
  useAgentsStore,
  useChatSessionsStore,
  useConfigApplyStore,
  useConnectionStore,
  useInteractionsStore,
  useTaskOverviewStore,
  useWorkspaceStore,
} from '@/stores'
import type { InteractionRecord } from '@/services/agentApi'
import type { TaskOverviewChangedData } from '@/stores/taskOverview'
import { wsClient } from '@/services/ws'

/** Composition root for transport subscriptions and application projections. */
export function startApplicationRuntime(): () => void {
  const connection = useConnectionStore()
  const configApply = useConfigApplyStore()
  const agents = useAgentsStore()
  const chats = useChatSessionsStore()
  const interactions = useInteractionsStore()
  const taskOverview = useTaskOverviewStore()
  const workspace = useWorkspaceStore()

  chats.bindWsClient()
  chats.bindEffects({
    onWorkingChange: agents.setWorkingForChat,
    onRoleDestroyed: (chatId) => agents.removePetsOnly([chatId]),
  })
  agents.bindSessionEvictor((chatIds) => chats.evictSessions(chatIds))

  const stopPetProjection = watch(
    () =>
      Object.values(chats.sessionsById).map((session) =>
        [
          session.chatId,
          session.meta.parentChatId,
          session.meta.agentType,
          session.meta.avatar,
          session.meta.finished,
          session.run.status,
        ].join('|'),
      ),
    () => agents.reconcilePetsFromSessions(chats.sessionsById),
    { immediate: true },
  )

  const offNotification = wsClient.onNotification((notification) => {
    const event = notification as {
      background?: boolean
      type?: string
      chatId?: string
      data?:
        | { interaction?: InteractionRecord }
        | TaskOverviewChangedData
        | import('@chery/protocol').ConfigApplyState
    } | null
    if (event?.type === 'interaction.changed') {
      const interaction = (event.data as { interaction?: InteractionRecord } | undefined)
        ?.interaction
      if (interaction) interactions.upsert(interaction)
      else {
        void interactions
          .refresh()
          .catch((cause) => console.warn('[runtime] refresh interactions failed:', cause))
      }
    }
    if (event?.type === 'chat.overview.changed') {
      const previousPending = taskOverview.pendingCount
      taskOverview.applyChanged(event.data as TaskOverviewChangedData)
      if (taskOverview.pendingCount > previousPending) {
        workspace.setWorkspaceWindowAttention('window:task-center', true)
      }
    }
    if (event?.type === 'config.apply.changed' && configApply.apply(event.data)) {
      void agents
        .refreshPresentationConfig()
        .catch((cause) => console.warn('[runtime] refresh presentation config failed:', cause))
    }
    if (event?.background) {
      void chats
        .refreshCatalog()
        .catch((cause) => console.warn('[runtime] refresh background catalog failed:', cause))
      return
    }
    if (
      event?.type &&
      [
        'interrupt',
        'accept',
        'rejected',
        'question_batch_requested',
        'question_batch_completed',
        'role_created',
        'role_destroyed',
        'done',
      ].includes(event.type)
    ) {
      void chats
        .refreshCatalog()
        .catch((cause) => console.warn('[runtime] refresh foreground catalog failed:', cause))
    }
  })

  let previousStatus: string | null = null
  const offStatus = wsClient.onStatus((status) => {
    if (status === 'connected') {
      void configApply.refresh()
      void taskOverview
        .reopen()
        .catch((cause) => console.warn('[taskOverview] open failed:', cause))
      void interactions
        .refresh()
        .catch((cause) => console.warn('[interactions] refresh failed:', cause))
      if (previousStatus === 'disconnected') {
        void Promise.all([chats.refreshCatalog(), chats.reconnect()]).catch((cause) =>
          console.warn('[chatSessions] reconnect failed:', cause),
        )
      } else {
        void chats
          .startup()
          .then(() => agents.initFromChats())
          .catch((cause) => console.warn('[runtime] startup failed:', cause))
      }
    }
    previousStatus = status
  })

  connection.init()
  return () => {
    stopPetProjection()
    offNotification()
    offStatus()
    void taskOverview.close().catch(() => undefined)
    chats.unbindWsClient()
  }
}
