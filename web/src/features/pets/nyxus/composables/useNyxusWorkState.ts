import { computed } from 'vue'
import { useAgentsStore, useChatSessionsStore } from '@/stores'
import { selectNyxusSession } from '@/stores/chats/selectors'

/** Cherry Nyxus 入口只投影运行中/空闲，不暴露 Agent 的细分过程状态。 */
export function useNyxusWorkState() {
  const chatSessions = useChatSessionsStore()
  const agents = useAgentsStore()
  const session = computed(() =>
    selectNyxusSession(chatSessions.sessionsById, agents.activeNyxusChatId),
  )
  const working = computed(() => session.value?.run.status === 'running')

  return { working }
}
