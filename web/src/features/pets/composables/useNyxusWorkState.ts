import { computed } from 'vue'
import { useChatSessionsStore } from '@/stores'
import type { StreamState } from '@/stores'
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
  const session = computed(() => selectNyxusSession(chatSessions.sessionsById))
  const bubble = computed(() => {
    const s = session.value
    return s ? selectBubble(s) : null
  })

  const resolved = computed(() => !!session.value)
  const chatId = computed(() => session.value?.chatId)
  const working = computed(() => bubble.value?.isWorking ?? false)

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

  return { chatId, resolved, working, stream }
}
