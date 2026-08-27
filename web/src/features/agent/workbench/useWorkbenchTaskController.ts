import { computed, onScopeDispose, ref, watch, type MaybeRefOrGetter, toValue } from 'vue'
import { ElMessage } from 'element-plus'
import { agentApi, type RootTimelineSnapshot } from '@/application/backend/public'
import { useAgentsStore, useChatSessionsStore } from '@/application/public'
import { terminalActionMode } from '@/features/pets/nyxus/composables/nodeInteraction'
import { selectCanResume } from '@/application/chat/public'
import { desktopBridge } from '@/features/desktop/public'

type WorkbenchControlMode = 'pause' | 'resume-tree' | 'resume-root'

export function useWorkbenchTaskController(options: {
  chatId: MaybeRefOrGetter<string | null>
  windowId: string
}) {
  const agents = useAgentsStore()
  const chatSessions = useChatSessionsStore()
  const taskTimeline = ref<RootTimelineSnapshot>()
  let refreshTimer: ReturnType<typeof setInterval> | undefined

  watch(
    () => taskTimeline.value?.taskId,
    (taskId) => {
      if (refreshTimer) clearInterval(refreshTimer)
      refreshTimer = undefined
      if (!taskId) return
      refreshTimer = setInterval(() => {
        void agentApi
          .getTaskTimeline({ taskId, view: 'tree' })
          .then((snapshot) => {
            if (taskTimeline.value?.taskId === taskId) taskTimeline.value = snapshot
          })
          .catch(() => undefined)
      }, 1200)
    },
  )
  onScopeDispose(() => {
    if (refreshTimer) clearInterval(refreshTimer)
  })

  const taskHasRunningBranches = computed(
    () =>
      taskTimeline.value?.activeRuns.some(
        (run) => run.status === 'running' || run.status === 'waiting',
      ) ?? false,
  )
  const controlTimeline = computed(() => {
    const chatId = toValue(options.chatId)
    return chatId ? (taskTimeline.value ?? chatSessions.rootTimeline(chatId, 'tree')) : undefined
  })
  const sessionControl = computed<{ mode: WorkbenchControlMode; label: string } | undefined>(() => {
    const chatId = toValue(options.chatId)
    if (!chatId) return undefined
    const session = chatSessions.sessionsById[chatId]
    if (!session) return undefined
    const timeline = controlTimeline.value
    const liveRuns = chatSessions.rootLiveActiveRuns(chatId)
    const cacheRuns = timeline?.activeRuns ?? []
    const treeRunning =
      liveRuns.some((run) => run.status === 'running' || run.status === 'waiting') ||
      (session.run.status === 'running' &&
        cacheRuns.some((run) => run.status === 'running' || run.status === 'waiting'))
    if (treeRunning || (!timeline && session.run.status === 'running')) {
      return { mode: 'pause', label: '暂停' }
    }
    const resumableTargets = timeline?.controlState?.targets.filter(
      (target) => target.status === 'paused' || target.status === 'failed',
    )
    if (resumableTargets?.length) return { mode: 'resume-tree', label: '继续' }
    const hasUnfinishedDirectChild = Object.values(chatSessions.sessionsById).some(
      (candidate) => candidate.meta.parentChatId === chatId && candidate.meta.finished !== true,
    )
    return terminalActionMode(
      session.run.status === 'running',
      selectCanResume(session),
      hasUnfinishedDirectChild,
    ) === 'run'
      ? { mode: 'resume-root', label: '继续' }
      : undefined
  })

  const sessionControlPending = ref(false)
  function handleControlError(mode: string, cause: unknown): void {
    console.error(`[WorkbenchDialog] ${mode} failed:`, cause)
    if ((cause as Error & { code?: string }).code === 'RUNTIME_SELECTION_REQUIRED') {
      const chatId = toValue(options.chatId)
      if (!chatId) return
      const bridge = desktopBridge()
      if (bridge) {
        bridge.openWindow({ kind: 'composer', chatId, source: 'history', view: 'composer' })
      } else {
        agents.closeWorkbenchWindow(options.windowId)
        agents.activeDialogSource = 'history'
        agents.activeDialogView = 'composer'
        agents.activeDialogChatId = chatId
      }
      ElMessage.warning('请先选择当前运行配置，再继续该历史任务')
      return
    }
    ElMessage.error(cause instanceof Error ? cause.message : '会话控制失败，请重试')
  }

  async function executeSessionControl(): Promise<void> {
    const mode = sessionControl.value?.mode
    const chatId = toValue(options.chatId)
    if (!mode || !chatId || sessionControlPending.value) return
    sessionControlPending.value = true
    try {
      if (mode === 'pause') await chatSessions.abortAgent(chatId)
      else if (mode === 'resume-tree') {
        let pauseId = controlTimeline.value?.controlState?.pauseId
        if (!pauseId && taskTimeline.value?.taskId) {
          const snapshot = await agentApi.getTaskTimeline({
            taskId: taskTimeline.value.taskId,
            view: 'tree',
          })
          taskTimeline.value = snapshot
          pauseId = snapshot?.controlState?.pauseId
        }
        if (!pauseId) throw new Error('暂停状态已变化，请重试')
        await chatSessions.resumeTree(chatId, pauseId)
      } else {
        void chatSessions
          .resumeAgent(chatId)
          .catch((cause) => handleControlError('resume-root', cause))
      }
    } catch (cause) {
      handleControlError(mode, cause)
    } finally {
      sessionControlPending.value = false
    }
  }

  const taskControlPending = ref(false)
  async function pauseWholeTask(): Promise<void> {
    const taskId = taskTimeline.value?.taskId
    if (!taskId || taskControlPending.value) return
    taskControlPending.value = true
    try {
      await agentApi.abortTask(taskId, crypto.randomUUID())
      taskTimeline.value = await agentApi.getTaskTimeline({ taskId, view: 'tree' })
    } catch (cause) {
      ElMessage.error(cause instanceof Error ? cause.message : '暂停全部分支失败')
    } finally {
      taskControlPending.value = false
    }
  }

  return {
    executeSessionControl,
    pauseWholeTask,
    sessionControl,
    sessionControlPending,
    taskControlPending,
    taskHasRunningBranches,
    taskTimeline,
  }
}
