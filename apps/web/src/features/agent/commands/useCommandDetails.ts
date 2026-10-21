import { computed, onUnmounted, ref } from 'vue'
import { useAgentCommandsStore } from '@/application/commands/public'
import { commandLogText } from '@/domain/commands/logView'
import { canStopCommand } from './model'

export function useCommandDetails(id: string) {
  const commands = useAgentCommandsStore()
  commands.acquireLog(id)
  onUnmounted(() => commands.releaseLog(id))
  const command = computed(() => commands.records[id])
  const log = computed(() => commands.logs[id])
  const text = computed(() => commandLogText(log.value?.chunks ?? [], log.value?.gaps ?? []))
  const tab = ref<'original' | 'summary'>('original')
  const stopping = ref(false)
  const stopError = ref('')
  const stopMessage = ref('')
  const canStop = computed(() => commands.online && !stopping.value && canStopCommand(command.value))
  async function stop() {
    stopping.value = true
    stopError.value = ''
    stopMessage.value = ''
    try { await commands.stop(id); stopMessage.value = '已请求停止该命令，等待执行方确认；所属 Agent 任务未停止。' }
    catch (error) { stopError.value = error instanceof Error ? error.message : '停止未获确认' }
    finally { stopping.value = false }
  }
  return { commands, command, log, text, tab, stopping, stopError, stopMessage, canStop, stop,
    read: (mode: 'first' | 'latest' | 'older' | 'newer') => commands.readLog(id, mode) }
}
