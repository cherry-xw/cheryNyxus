import { ref } from 'vue'
import { agentApi, type ChatEpochSummary, type PromptSnapshotTool } from '@/application/backend/public'

export function useEpochSnapshotLoader(getChatId: () => string) {
  const promptSnap = ref<{
    systemPrompt: string
    tools: PromptSnapshotTool[]
    status: 'idle' | 'loading' | 'error' | 'loaded'
    error?: string
    epochs: ChatEpochSummary[]
    selectedEpochId?: string
    activeEpochId?: string
    snapshotQuality?: 'exact' | 'partial' | 'reconstructed'
  } | null>(null)
  let promptSnapKey = ''
  async function loadPromptSnapshot(chatId: string, epochId?: string): Promise<void> {
    // 同 chat 已加载或加载中 → 不重复请求
    const key = `${chatId}:${epochId ?? 'active'}`
    if (promptSnapKey === key && promptSnap.value && promptSnap.value.status !== 'error') return
    promptSnapKey = key
    try {
      const epochResult = await agentApi.listEpochs(chatId)
      const selectedEpochId = epochId ?? epochResult.activeEpochId
      promptSnap.value = {
        systemPrompt: '',
        tools: [],
        status: 'loading',
        epochs: epochResult.epochs,
        selectedEpochId,
        activeEpochId: epochResult.activeEpochId,
      }
      const res = await agentApi.promptSnapshot(chatId, selectedEpochId)
      const effectiveSelectedEpochId = res.epochId ?? selectedEpochId
      // chatId 期间未切换才写入（避免竞态覆盖）
      if (promptSnapKey === key) {
        promptSnap.value = {
          systemPrompt: res.systemPrompt,
          tools: res.tools,
          status: 'loaded',
          epochs: epochResult.epochs,
          selectedEpochId: effectiveSelectedEpochId,
          activeEpochId: epochResult.activeEpochId,
          snapshotQuality: res.snapshotQuality,
        }
      }
    } catch (err) {
      if (promptSnapKey === key) {
        promptSnap.value = {
          systemPrompt: '',
          tools: [],
          status: 'error',
          error: (err as Error).message,
          epochs: promptSnap.value?.epochs ?? [],
          selectedEpochId: epochId,
        }
      }
    }
  }
  function onPromptSnapShow(): void {
    if (!getChatId()) return
    void loadPromptSnapshot(getChatId())
  }
  function onPromptEpochChange(epochId: string): void {
    if (!getChatId()) return
    void loadPromptSnapshot(getChatId(), epochId)
  }

  return { promptSnap, onPromptSnapShow, onPromptEpochChange }
}
