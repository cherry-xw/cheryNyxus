import type {
  BrainCapabilitiesDto,
  BrainConfigDto,
  ModelRecommendationDto,
} from '@/application/backend/public'
import type { LlmProtocol } from '@chery/protocol'

type Recommendation = ModelRecommendationDto['recommend']

export interface ModelRecommendationDraftPatch {
  provider?: string
  protocol?: LlmProtocol
  contextLimit?: number
  thinking?: BrainConfigDto['thinking']
  capabilities?: BrainCapabilitiesDto
}

export interface PlanModelRecommendationDraftUpdateInput {
  draft: BrainConfigDto
  recommendation?: Recommendation
  previousModel?: string
  previousRecommendation?: Recommendation
  isPlaceholderModel?: (model: string) => boolean
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function cloneCapabilities(value: BrainCapabilitiesDto): BrainCapabilitiesDto {
  return structuredClone(value)
}

function shouldFollowRecommendation(
  current: unknown,
  previous: unknown,
  firstModelSelection: boolean,
): boolean {
  return firstModelSelection || current === undefined || valuesEqual(current, previous)
}

/**
 * Plans editor-only changes for a newly selected model.
 *
 * A property present with value `undefined` means that an automatic value from
 * the previous model should be cleared. The caller still owns persistence:
 * applying this patch only mutates the settings draft, and config.save is the
 * point at which the recommendation becomes runtime configuration.
 */
export function planModelRecommendationDraftUpdate(
  input: PlanModelRecommendationDraftUpdateInput,
): ModelRecommendationDraftPatch {
  const {
    draft,
    recommendation,
    previousModel,
    previousRecommendation,
    isPlaceholderModel = () => false,
  } = input
  const firstModelSelection = !previousModel || isPlaceholderModel(previousModel)
  const modelChanged = !!previousModel && previousModel !== draft.model
  const patch: ModelRecommendationDraftPatch = {}

  // 换了模型就强制写入推荐的服务/协议，覆盖草稿当前值，无论是否命中目录规则：
  // 命中规则时按目录推荐（如 gpt-5.6 → openai + openai-responses），未命中时按
  // 模型名推断（GPT 系 → openai + responses；Claude 系 → anthropic-messages；
  // 其余 → openai + chat-completions）。不再要求当前值恰好等于上一模型的推荐值
  // ——从 config.yaml 加载的草稿值与上一推荐不一致是常态，按「用户手改」跳过
  // 会导致切换永不生效。
  // 同一模型下只改协议/服务时不强制：用户手动调整不能被推荐悄悄改回。
  const forceSwitch = modelChanged

  for (const key of ['provider', 'protocol', 'contextLimit', 'thinking', 'capabilities'] as const) {
    const current = draft[key]
    const previous = previousRecommendation?.[key]
    const override =
      forceSwitch && (key === 'provider' || key === 'protocol') && recommendation?.[key] !== undefined
    if (!override && !shouldFollowRecommendation(current, previous, firstModelSelection)) continue

    const next = recommendation?.[key]
    if (next !== undefined) {
      if (key === 'capabilities') patch[key] = cloneCapabilities(next as BrainCapabilitiesDto)
      else Object.assign(patch, { [key]: next })
      continue
    }

    // Only a model change may clear an inherited value that the next model does
    // not recommend. A protocol change for the same model must preserve it:
    // missing protocol-specific metadata means "unknown", not "off".
    // Provider/protocol are never cleared: without a vendor recommendation we
    // keep the current service and wire protocol instead of resetting them.
    if (
      modelChanged &&
      !firstModelSelection &&
      key !== 'provider' &&
      key !== 'protocol' &&
      previous !== undefined &&
      valuesEqual(current, previous)
    ) {
      Object.assign(patch, { [key]: undefined })
    }
  }

  return patch
}

export function applyModelRecommendationDraftPatch(
  draft: BrainConfigDto,
  patch: ModelRecommendationDraftPatch,
  setProvider: (provider: string | undefined) => void,
  setProtocol: (protocol: LlmProtocol | undefined) => void,
  supportedProtocols: () => readonly LlmProtocol[],
): void {
  // Switch the service first; the provider watch maps it to a default URL and
  // protocol, then the explicit protocol patch overrides the wire protocol.
  // Supported protocols are read AFTER the service switch: the wire protocol
  // must be validated against the service the brain ends up on, not the one it
  // started from (e.g. bigmodel would reject openai-responses that openai
  // itself supports).
  if ('provider' in patch && patch.provider !== undefined) {
    setProvider(patch.provider)
  }
  const protocols = supportedProtocols()
  if (
    'protocol' in patch &&
    (patch.protocol === undefined || protocols.includes(patch.protocol))
  ) {
    setProtocol(patch.protocol)
  }
  if ('contextLimit' in patch) draft.contextLimit = patch.contextLimit
  if ('thinking' in patch) draft.thinking = patch.thinking
  if ('capabilities' in patch) draft.capabilities = patch.capabilities
}
