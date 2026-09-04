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

  /** 已选择模型且目录未命中任何规则：note 行转警示态、「编辑规则」按钮与 thinking tip 补充说明的依据。 */
  const modelUnmatched = computed(() => {
    const resolved = modelRecommendation.value
    return !!resolved && !resolved.matched
  })
  const modelRuleNotice = computed(() => {
    const resolved = modelRecommendation.value
    if (!resolved) {
      return '模型规则由 model-catalog.yaml 管理，不在此处选择。'
    }
    if (!resolved.matched) {
      return '当前模型未匹配任何目录规则：已填入 unknown 保守推荐，深度思考无可用档位。可编辑规则文件追加匹配规则（精确/glob/正则，中转站别名适用，模板文件底部有示例）。'
    }
    return `模型规则由 model-catalog.yaml 管理，不在此处选择。已匹配 ${resolved.id ?? '目录规则'}；推荐值可修改，保存后才生效。`
  })
  const thinkingTip = computed(() => {
    const lines = [
      '推理模型的思考强度档位（按当前 model 暴露不同档位）。off=关闭；on=由模型决定；low/medium/high/xhigh 由 provider 映射，需在「⚙ 全局」开启思考总闸。',
    ]
    if (modelUnmatched.value) {
      lines.push('档位来自模型目录 wire 映射；当前模型未匹配任何目录规则，无可用档位，需在规则文件中补充。')
    }
    return lines.join('\n')
  })
  const contextLimitTip = computed(() => {
    const facts = modelRecommendation.value?.facts
    const recommend = modelRecommendation.value?.recommend
    const lines = [
      '单位为 K。该值保存到 config.yaml 后才参与运行和工作台上下文百分比计算。\n这个值由于是关联压缩上限判断，实际可用作控制实际最大上下文',
    ]
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

  return { contextLimitTip, modelRuleNotice, modelUnmatched, thinkingTip, thinkingLevels }
}
