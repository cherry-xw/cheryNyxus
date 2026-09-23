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

  for (const key of ['provider', 'protocol', 'contextLimit', 'thinking', 'capabilities'] as const) {
    const current = draft[key]
    const previous = previousRecommendation?.[key]
    if (!shouldFollowRecommendation(current, previous, firstModelSelection)) continue

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
  supportedProtocols: readonly LlmProtocol[],
): void {
  // Switch the service first; the provider watch maps it to a default URL and
  // protocol, then the explicit protocol patch overrides the wire protocol.
  if ('provider' in patch && patch.provider !== undefined) {
    setProvider(patch.provider)
  }
  if (
    'protocol' in patch &&
    (patch.protocol === undefined || supportedProtocols.includes(patch.protocol))
  ) {
    setProtocol(patch.protocol)
  }
  if ('contextLimit' in patch) draft.contextLimit = patch.contextLimit
  if ('thinking' in patch) draft.thinking = patch.thinking
  if ('capabilities' in patch) draft.capabilities = patch.capabilities
}
