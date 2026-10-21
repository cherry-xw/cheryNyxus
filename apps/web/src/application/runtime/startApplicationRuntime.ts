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
import { ChatLifecycleChangedSchema } from '@chery/protocol'
import { invalidateArchives } from '../archiveChanges'
import { useAgentCommandsStore } from '@/stores/agentCommands'

/** Composition root for transport subscriptions and application projections. */
export function startApplicationRuntime(): () => void {
  const connection = useConnectionStore()
  const configApply = useConfigApplyStore()
  const agents = useAgentsStore()
  const chats = useChatSessionsStore()
  const interactions = useInteractionsStore()
  const taskOverview = useTaskOverviewStore()
  const workspace = useWorkspaceStore()
  const commands = useAgentCommandsStore()
  commands.connectionChanged(wsClient.getStatus())
  const commandPoll = setInterval(() => commands.poll(), 2000)

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
    commands.apply(notification)
    const event = notification as {
      background?: boolean
      type?: string
      chatId?: string
      data?:
        | { interaction?: InteractionRecord }
        | TaskOverviewChangedData
        | import('@chery/protocol').ConfigApplyState
    } | null
    if (event?.type === 'chat.lifecycle.changed') {
      const parsed = ChatLifecycleChangedSchema.safeParse(event.data)
      if (!parsed.success) return
      const { chatIds, action } = parsed.data
      agents.removePetsOnly(chatIds)
      void chats
        .evictSessions(chatIds, action === 'deleted')
        .then(() => chats.refreshCatalog())
        .catch((cause) => console.warn('[archive] refresh failed:', cause))
      invalidateArchives()
      void interactions.refresh().catch((cause) => console.warn('[archive] interactions:', cause))
    }
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

  let needsFreshStartup = false
  const stopCapabilities = watch(() => {
    const value = currentCapabilities()
    return value ? `${value.instanceId}:${value.revision}` : ''
  }, (next, previous) => {
    if (!next || next === previous) return
    needsFreshStartup = true
    clearServerConfigCache()
    chats.resetTarget()
    commands.resetTarget()
    interactions.resetTarget()
    taskOverview.resetTarget()
    configApply.resetTarget()
    agents.resetTarget()
    invalidateArchives()
    workspace.activeDialogChatId = null
    workspace.activeNyxusChatId = null
    workspace.activeRootByPreset = {}
    workspace.closeAllHistory()
    workspace.settingsOpen = false
    for (const window of [...workspace.workbenchWindowsList]) workspace.closeWorkbenchWindow(window.id)
    for (const window of [...workspace.workspaceWindowsList]) workspace.removeWorkspaceWindow(window.id)
  }, { flush: 'sync' })
  let previousStatus: string | null = null
  const offStatus = wsClient.onStatus((status) => {
    commands.connectionChanged(status)
    if (status === 'connected') {
      invalidateArchives()
      void configApply.refresh()
      void taskOverview
        .reopen()
        .catch((cause) => console.warn('[taskOverview] open failed:', cause))
      void interactions
        .refresh()
        .catch((cause) => console.warn('[interactions] refresh failed:', cause))
      if (previousStatus === 'disconnected' && !needsFreshStartup) {
        void Promise.all([chats.refreshCatalog(), chats.reconnect()]).catch((cause) =>
          console.warn('[chatSessions] reconnect failed:', cause),
        )
      } else {
        needsFreshStartup = false
        void chats
          .startup()
          .then(() => agents.initFromChats())
          .catch((cause) => console.warn('[runtime] startup failed:', cause))
      }
    }
    previousStatus = status
  })

  const stopIdentity = watch(() => useAuthStore().locked, (locked) => {
    if (!locked) return
    clearServerConfigCache()
    chats.resetTarget()
    commands.resetTarget()
    interactions.resetTarget()
    taskOverview.resetTarget()
    configApply.resetTarget()
    invalidateArchives()
    agents.resetTarget()
    workspace.activeDialogChatId = null
    workspace.activeNyxusChatId = null
    workspace.activeRootByPreset = {}
    workspace.closeAllHistory()
    workspace.settingsOpen = false
    for (const window of [...workspace.workbenchWindowsList]) workspace.closeWorkbenchWindow(window.id)
    for (const window of [...workspace.workspaceWindowsList]) workspace.removeWorkspaceWindow(window.id)
  }, { flush: 'sync' })
  const stopOptional = watch(
    [() => workspace.settingsOpen, () => Boolean(workspace.workspaceWindows['window:task-center']), () => connection.status],
    ([settings, overview, status]) => {
      if (status !== 'connected') return
      if (settings && capabilityEnabled('settings.manage')) void configApply.refresh()
      if (overview && capabilityEnabled('task.overview')) void taskOverview.reopen().catch(() => undefined)
      else void taskOverview.close().catch(() => undefined)
    },
  )
  connection.init()
  return () => {
    clearInterval(commandPoll)
    commands.resetTarget()
    stopCapabilities()
    stopOptional()
    stopIdentity()
    stopPetProjection()
    offNotification()
    offStatus()
    void taskOverview.close().catch(() => undefined)
    chats.unbindWsClient()
  }
}
