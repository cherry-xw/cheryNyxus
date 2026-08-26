import { watch } from 'vue'
import {
  useAgentsStore,
  useChatSessionsStore,
  useConnectionStore,
  useInteractionsStore,
} from '@/stores'
import { wsClient } from '@/services/ws'

/** Composition root for transport subscriptions and application projections. */
export function startApplicationRuntime(): () => void {
  const connection = useConnectionStore()
  const agents = useAgentsStore()
  const chats = useChatSessionsStore()
  const interactions = useInteractionsStore()

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
    const event = notification as { background?: boolean; type?: string; chatId?: string } | null
    if (event?.type === 'interaction.changed') {
      void interactions
        .refresh()
        .catch((cause) => console.warn('[runtime] refresh interactions failed:', cause))
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
      void interactions
        .refresh()
        .catch((cause) => console.warn('[runtime] refresh interactions failed:', cause))
      void chats
        .refreshCatalog()
        .catch((cause) => console.warn('[runtime] refresh foreground catalog failed:', cause))
    }
  })

  let previousStatus: string | null = null
  const offStatus = wsClient.onStatus((status) => {
    if (status === 'connected') {
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
    chats.unbindWsClient()
  }
}
