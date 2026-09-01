import { computed, ref, watch } from 'vue'
import {
  agentApi,
  type BrainConfigDto,
  type ModelRecommendationDto,
  type ThinkingLevel,
} from '@/application/backend/public'
import type { LlmProtocol } from '@chery/protocol'
import {
  applyModelRecommendationDraftPatch,
  planModelRecommendationDraftUpdate,
} from './modelRecommendationDraft'

interface UseModelRecommendationOptions {
  cfg: BrainConfigDto
  effectiveProtocol: () => LlmProtocol | undefined
  supportedProtocols: () => readonly LlmProtocol[]
  setProtocol: (protocol: LlmProtocol | undefined) => void
  isPlaceholderModel: (model: string) => boolean
}

/** Model catalog state plus editor-only recommendation application. */
export function useModelRecommendation(options: UseModelRecommendationOptions) {
  const modelRecommendation = ref<ModelRecommendationDto | null>(null)
  const thinkingLevels = ref<readonly ThinkingLevel[]>([])
  let requestId = 0

  function applyRecommendation(
    recommendation: ModelRecommendationDto['recommend'],
    previousModel?: string,
    previousRecommendation?: ModelRecommendationDto['recommend'],
  ): void {
    const patch = planModelRecommendationDraftUpdate({
      draft: options.cfg,
      recommendation,
      previousModel,
      previousRecommendation,
      isPlaceholderModel: options.isPlaceholderModel,
    })
    applyModelRecommendationDraftPatch(
      options.cfg,
      patch,
      options.setProtocol,
      options.supportedProtocols(),
    )
  }

  async function refresh(
    applyToDraft: boolean,
    previousModel?: string,
    previousRecommendation?: ModelRecommendationDto['recommend'],
  ): Promise<void> {
    const currentRequest = ++requestId
    const model = options.cfg.model
    if (!model || options.isPlaceholderModel(model)) {
      modelRecommendation.value = null
      thinkingLevels.value = []
      if (applyToDraft) applyRecommendation(undefined, previousModel, previousRecommendation)
      return
    }

    try {
      const resolved = await agentApi.getModelRecommendation(
        model,
        options.cfg.provider,
        options.effectiveProtocol(),
      )
      if (currentRequest !== requestId) return
      modelRecommendation.value = resolved
      thinkingLevels.value = resolved.thinkingLevels
      if (applyToDraft) {
        applyRecommendation(resolved.recommend, previousModel, previousRecommendation)
      }
    } catch {
      if (currentRequest !== requestId) return
      modelRecommendation.value = null
      thinkingLevels.value = []
    }
  }

  watch(
    () => [options.cfg.model, options.cfg.provider, options.cfg.protocol] as const,
    (current, previous) => {
      const modelChanged = !!previous && current[0] !== previous[0]
      const previousRecommendation = modelRecommendation.value?.recommend
      void refresh(modelChanged, previous?.[0], previousRecommendation)
    },
    { immediate: true },
  )

  const modelRuleNotice = computed(() => {
    const resolved = modelRecommendation.value
    if (!resolved?.matched) {
      return '模型规则由 model-catalog.yaml 管理，不在此处选择。当前未匹配具体规则，已填入 unknown 中的保守推荐；保存前可修改。'
    }
    return `模型规则由 model-catalog.yaml 管理，不在此处选择。已匹配 ${resolved.id ?? '目录规则'}；推荐值可修改，保存后才生效。`
  })
  const contextLimitTip = computed(() => {
    const facts = modelRecommendation.value?.facts
    const recommend = modelRecommendation.value?.recommend
    const lines = ['单位为 K。该值保存到 config.yaml 后才参与运行和工作台上下文百分比计算。']
    if (facts?.contextWindow) {
      lines.push(`目录记录的模型最大值：${facts.contextWindow / 1000}K。`)
    }
    if (recommend?.contextLimit) {
      lines.push(`目录推荐值：${recommend.contextLimit / 1000}K，可手动修改。`)
    }
    if (!facts?.contextWindow && !recommend?.contextLimit) {
      lines.push('目录信息未知时留空；工作台不显示虚假的百分比。')
    }
    return lines.join('\n')
  })

  return { contextLimitTip, modelRuleNotice, thinkingLevels }
}
