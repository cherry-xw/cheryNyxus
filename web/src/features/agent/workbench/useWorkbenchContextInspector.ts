import { computed, ref, watch, type MaybeRefOrGetter, toValue } from 'vue'
import {
  agentApi,
  type ChatEpochSummary,
  type ContextBreakdown,
  type PromptSnapshotTool,
} from '@/application/backend/public'
import { useChatSessionData } from '@/application/chat/public'

type RoleSelection = { brain: string }
type BrainConfig = (brain: string) => { contextLimit?: number } | undefined

export function usageClass(usage: number): 'usage-low' | 'usage-mid' | 'usage-high' {
  if (usage >= 0.8) return 'usage-high'
  if (usage >= 0.5) return 'usage-mid'
  return 'usage-low'
}

export function useWorkbenchContextInspector(options: {
  treeRootChatId: MaybeRefOrGetter<string>
  pet: MaybeRefOrGetter<{ contextUsed?: number } | null | undefined>
  roleSelections: MaybeRefOrGetter<Record<string, RoleSelection>>
  brainConfig: BrainConfig
}) {
  const rootSessionData = useChatSessionData(() => toValue(options.treeRootChatId) || undefined)
  const treeCtxUsage = ref<{ usage: number; breakdown: ContextBreakdown | null }>({
    usage: 0,
    breakdown: null,
  })
  let treeCtxUsageChatId = ''

  async function loadTreeContextUsage(chatId: string): Promise<void> {
    if (treeCtxUsageChatId === chatId) return
    treeCtxUsageChatId = chatId
    try {
      const result = await agentApi.contextUsage(chatId)
      if (treeCtxUsageChatId === chatId) {
        treeCtxUsage.value = { usage: result.contextUsage, breakdown: result.contextBreakdown }
      }
    } catch {
      // Runtime data may become available later; retain the empty fallback meanwhile.
    }
  }

  watch(
    () => toValue(options.treeRootChatId),
    (chatId) => {
      treeCtxUsage.value = { usage: 0, breakdown: null }
      if (chatId) void loadTreeContextUsage(chatId)
    },
    { immediate: true },
  )

  const treeUsage = computed(() => rootSessionData.contextUsage.value ?? treeCtxUsage.value.usage)
  const treeUsagePct = computed(() => Math.round(treeUsage.value * 100))
  const treeBreakdown = computed(
    () => rootSessionData.contextBreakdown.value ?? treeCtxUsage.value.breakdown,
  )
  const roleUsages = computed<
    Record<string, { used: number; total: number; usage: number } | null>
  >(() => {
    const pet = toValue(options.pet)
    const usages: Record<string, { used: number; total: number; usage: number } | null> = {}
    for (const [role, selection] of Object.entries(toValue(options.roleSelections))) {
      const limit = options.brainConfig(selection.brain)?.contextLimit
      if (!limit || !pet) {
        usages[role] = null
        continue
      }
      const used = pet.contextUsed ?? 0
      usages[role] = { used, total: limit, usage: Math.min(1, Math.max(0, used / limit)) }
    }
    return usages
  })

  const treePromptSnap = ref<{
    systemPrompt: string
    tools: PromptSnapshotTool[]
    status: 'idle' | 'loading' | 'error' | 'loaded'
    error?: string
    epochs: ChatEpochSummary[]
    selectedEpochId?: string
    activeEpochId?: string
    snapshotQuality?: 'exact' | 'partial' | 'reconstructed'
  } | null>(null)
  let treePromptSnapKey = ''

  async function loadTreePromptSnapshot(chatId: string, epochId?: string): Promise<void> {
    const key = `${chatId}:${epochId ?? 'active'}`
    if (treePromptSnapKey === key && treePromptSnap.value?.status !== 'error') return
    treePromptSnapKey = key
    try {
      const epochsResult = await agentApi.listEpochs(chatId)
      const selectedEpochId = epochId ?? epochsResult.activeEpochId
      treePromptSnap.value = {
        systemPrompt: '',
        tools: [],
        status: 'loading',
        epochs: epochsResult.epochs,
        selectedEpochId,
        activeEpochId: epochsResult.activeEpochId,
      }
      const result = await agentApi.promptSnapshot(chatId, selectedEpochId)
      const effectiveSelectedEpochId = result.epochId ?? selectedEpochId
      if (treePromptSnapKey === key) {
        treePromptSnap.value = {
          systemPrompt: result.systemPrompt,
          tools: result.tools,
          status: 'loaded',
          epochs: epochsResult.epochs,
          selectedEpochId: effectiveSelectedEpochId,
          activeEpochId: epochsResult.activeEpochId,
          snapshotQuality: result.snapshotQuality,
        }
      }
    } catch (error) {
      if (treePromptSnapKey === key) {
        treePromptSnap.value = {
          systemPrompt: '',
          tools: [],
          status: 'error',
          error: (error as Error).message,
          epochs: treePromptSnap.value?.epochs ?? [],
          selectedEpochId: epochId,
        }
      }
    }
  }

  function onTreePromptSnapShow(): void {
    const chatId = toValue(options.treeRootChatId)
    if (chatId) void loadTreePromptSnapshot(chatId)
  }

  function onTreeEpochChange(epochId: string): void {
    const chatId = toValue(options.treeRootChatId)
    if (chatId) void loadTreePromptSnapshot(chatId, epochId)
  }

  return {
    onTreePromptSnapShow,
    onTreeEpochChange,
    roleUsages,
    treeBreakdown,
    treePromptSnap,
    treeUsage,
    treeUsagePct,
  }
}
