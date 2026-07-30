import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useAgentsStore, useChatSessionsStore } from '@/stores'
import type { StreamState } from '@/stores'
import type { NyxusActivity } from '../particles/nyxusParticleEngine'
import {
  selectNyxusSession,
  selectBubble,
  selectRunningTools,
  selectApproval,
  selectQuestionBatches,
} from '@/stores/chats/selectors'

/**
 * nyxus 独立核心工作态投影：从 chatSessions 的 nyxus session（root + preset=cheryNyxus）
 * 派生粒子 + 工作气泡所需字段，不经 PetInstance。NyxusCore 脱离 pets[] 后的唯一数据源。
 *
 * 工作态源头本就在 pet 之外（chatSessions.run.status 权威；pet 仅曾作镜像）。
 * approval/question 不在 nyxus 体上渲染（走 AgentDialog），但保留进 stream 以驱动 isBusy。
 */
export function useNyxusWorkState() {
  const chatSessions = useChatSessionsStore()
  const agents = useAgentsStore()
  const session = computed(() =>
    selectNyxusSession(chatSessions.sessionsById, agents.activeNyxusChatId),
  )
  const bubble = computed(() => {
    const s = session.value
    return s ? selectBubble(s) : null
  })

  const resolved = computed(() => !!session.value)
  const chatId = computed(() => session.value?.chatId)
  const working = computed(() => bubble.value?.isWorking ?? false)
  const runningToolCount = computed(() => (session.value ? selectRunningTools(session.value).length : 0))
  const activity = computed<NyxusActivity>(() => {
    const s = session.value
    const b = bubble.value
    if (!s || !b) return 'idle'
    if (b.error) return 'error'
    if (selectApproval(s) || selectQuestionBatches(s).length > 0) return 'waitingForUser'
    if (selectRunningTools(s).length > 0) return 'toolRunning'
    if (!b.isWorking) return 'idle'
    if (b.content.trim()) return 'responding'
    return 'thinking'
  })

  // 将持续流式文本压成低频视觉事件，避免每个字符都驱动一次粒子波纹。
  const contentPulse = ref(0)
  let lastContent = ''
  let lastPulseAt = Number.NEGATIVE_INFINITY
  let pendingPulse: ReturnType<typeof setTimeout> | undefined

  function emitContentPulse(): void {
    lastPulseAt = performance.now()
    contentPulse.value += 1
  }

  watch(
    () => bubble.value?.content ?? '',
    (content) => {
      if (!content || content === lastContent) {
        lastContent = content
        return
      }
      lastContent = content
      const remaining = 1500 - (performance.now() - lastPulseAt)
      if (remaining <= 0) {
        if (pendingPulse) clearTimeout(pendingPulse)
        pendingPulse = undefined
        emitContentPulse()
        return
      }
      if (!pendingPulse) {
        pendingPulse = setTimeout(() => {
          pendingPulse = undefined
          emitContentPulse()
        }, remaining)
      }
    },
  )

  /** StreamState 投影：供 useStreamBubble 复用气泡逻辑；history 留空（核心不显历史）。 */
  const stream = computed<StreamState | undefined>(() => {
    const s = session.value
    const b = bubble.value
    if (!s || !b) return undefined
    return {
      thinking: b.thinking,
      content: b.content,
      isWorking: b.isWorking,
      history: [],
      historyLoaded: true,
      historyDirty: false,
      retainUntil: b.retainUntil,
      error: b.error,
      approval: selectApproval(s),
      approvalQueue: [],
      questionBatches: selectQuestionBatches(s),
      runningTools: selectRunningTools(s),
    }
  })

  onBeforeUnmount(() => {
    if (pendingPulse) clearTimeout(pendingPulse)
  })

  return { chatId, resolved, working, stream, activity, runningToolCount, contentPulse }
}
