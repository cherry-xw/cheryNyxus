import { computed } from 'vue'
import { useNyxusHost } from '../application/host'
import { selectNyxusSession } from '@/application/chat/public'

/** Cherry Nyxus 入口只投影运行中/空闲，不暴露 Agent 的细分过程状态。 */
export function useNyxusWorkState() {
  const { chats: chatSessions, agents } = useNyxusHost()
  const session = computed(() =>
    selectNyxusSession(chatSessions.sessionsById, agents.activeNyxusChatId),
  )
  const working = computed(() => session.value?.run.status === 'running')

  return { working }
}
