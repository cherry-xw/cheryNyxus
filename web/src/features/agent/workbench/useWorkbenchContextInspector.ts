import { computed, ref, watch, type MaybeRefOrGetter, toValue } from 'vue'
import { agentApi, type ContextBreakdown, type PromptSnapshotTool } from '@/application/backend/public'
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
  } | null>(null)
  let treePromptSnapChatId = ''

  async function loadTreePromptSnapshot(chatId: string): Promise<void> {
    if (treePromptSnapChatId === chatId && treePromptSnap.value?.status !== 'error') return
    treePromptSnapChatId = chatId
    treePromptSnap.value = { systemPrompt: '', tools: [], status: 'loading' }
    try {
      const result = await agentApi.promptSnapshot(chatId)
      if (treePromptSnapChatId === chatId) {
        treePromptSnap.value = {
          systemPrompt: result.systemPrompt,
          tools: result.tools,
          status: 'loaded',
        }
      }
    } catch (error) {
      if (treePromptSnapChatId === chatId) {
        treePromptSnap.value = {
          systemPrompt: '',
          tools: [],
          status: 'error',
          error: (error as Error).message,
        }
      }
    }
  }

  function onTreePromptSnapShow(): void {
    const chatId = toValue(options.treeRootChatId)
    if (chatId) void loadTreePromptSnapshot(chatId)
  }

  return {
    onTreePromptSnapShow,
    roleUsages,
    treeBreakdown,
    treePromptSnap,
    treeUsage,
    treeUsagePct,
  }
}
