import { describe, expect, it } from 'vitest'
import type {
  BrainCapabilitiesDto,
  BrainConfigDto,
  ModelRecommendationDto,
} from '@/application/backend/public'
import {
  applyModelRecommendationDraftPatch,
  planModelRecommendationDraftUpdate,
} from '@/features/agent/settings/tabs/brain/modelRecommendationDraft'
import { LlmProtocol } from '@chery/protocol'

const textCapabilities: BrainCapabilitiesDto = {
  toolCall: true,
  input: { image: false },
}

const visionCapabilities: BrainCapabilitiesDto = {
  toolCall: true,
  input: { image: true },
}

function recommendation(
  value: NonNullable<ModelRecommendationDto['recommend']>,
): ModelRecommendationDto['recommend'] {
  return value
}

describe('model recommendation draft updates', () => {
  it('writes every recommendation into the UI draft on first model selection', () => {
    const draft: BrainConfigDto = {
      provider: 'newapi',
      model: 'MiniMax-M3',
      protocol: LlmProtocol.OPENAI_CHAT_COMPLETIONS,
    }
    const patch = planModelRecommendationDraftUpdate({
      draft,
      previousModel: '',
      recommendation: recommendation({
        protocol: LlmProtocol.OPENAI_RESPONSES,
        contextLimit: 250_000,
        thinking: 'on',
        capabilities: textCapabilities,
      }),
    })

    expect(patch).toEqual({
      protocol: LlmProtocol.OPENAI_RESPONSES,
      contextLimit: 250_000,
      thinking: 'on',
      capabilities: textCapabilities,
    })
    expect(patch.capabilities).not.toBe(textCapabilities)
  })

  it('replaces values that still equal the previous model recommendation', () => {
    const previous = recommendation({
      protocol: LlmProtocol.OPENAI_CHAT_COMPLETIONS,
      contextLimit: 128_000,
      thinking: 'on',
      capabilities: textCapabilities,
    })
    const draft: BrainConfigDto = {
      provider: 'newapi',
      model: 'next-model',
      ...previous,
    }

    expect(
      planModelRecommendationDraftUpdate({
        draft,
        previousModel: 'previous-model',
        previousRecommendation: previous,
        recommendation: recommendation({
          protocol: LlmProtocol.OPENAI_RESPONSES,
          contextLimit: 250_000,
          thinking: 'high',
          capabilities: visionCapabilities,
        }),
      }),
    ).toEqual({
      protocol: LlmProtocol.OPENAI_RESPONSES,
      contextLimit: 250_000,
      thinking: 'high',
      capabilities: visionCapabilities,
    })
  })

  it('preserves values modified by the user', () => {
    const previous = recommendation({
      protocol: LlmProtocol.OPENAI_CHAT_COMPLETIONS,
      contextLimit: 128_000,
      thinking: 'on',
      capabilities: textCapabilities,
    })
    const draft: BrainConfigDto = {
      provider: 'newapi',
      model: 'next-model',
      protocol: LlmProtocol.ANTHROPIC_MESSAGES,
      contextLimit: 64_000,
      thinking: 'low',
      capabilities: visionCapabilities,
    }

    expect(
      planModelRecommendationDraftUpdate({
        draft,
        previousModel: 'previous-model',
        previousRecommendation: previous,
        recommendation: recommendation({
          protocol: LlmProtocol.OPENAI_RESPONSES,
          contextLimit: 250_000,
          thinking: 'high',
          capabilities: textCapabilities,
        }),
      }),
    ).toEqual({})
  })

  it('replaces old automatic values with conservative unknown-model recommendations', () => {
    const previous = recommendation({
      protocol: LlmProtocol.OPENAI_RESPONSES,
      contextLimit: 250_000,
      thinking: 'high',
      capabilities: visionCapabilities,
    })
    const draft: BrainConfigDto = {
      provider: 'newapi',
      model: 'unknown-model',
      ...previous,
    }
    const patch = planModelRecommendationDraftUpdate({
      draft,
      previousModel: 'known-model',
      previousRecommendation: previous,
      recommendation: recommendation({
        protocol: LlmProtocol.OPENAI_CHAT_COMPLETIONS,
        contextLimit: 128_000,
        thinking: 'off',
        capabilities: textCapabilities,
      }),
    })

    expect(patch).toEqual({
      protocol: LlmProtocol.OPENAI_CHAT_COMPLETIONS,
      contextLimit: 128_000,
      thinking: 'off',
      capabilities: textCapabilities,
    })
  })

  it('only mutates the editor draft when the caller applies the planned patch', () => {
    const draft: BrainConfigDto = { provider: 'newapi', model: 'MiniMax-M3' }
    const patch = planModelRecommendationDraftUpdate({
      draft,
      previousModel: '',
      recommendation: recommendation({
        protocol: LlmProtocol.OPENAI_RESPONSES,
        contextLimit: 250_000,
        thinking: 'on',
      }),
    })

    expect(draft).toEqual({ provider: 'newapi', model: 'MiniMax-M3' })
    applyModelRecommendationDraftPatch(
      draft,
      patch,
      (protocol) => {
        draft.protocol = protocol
      },
      [LlmProtocol.OPENAI_RESPONSES],
    )
    expect(draft).toMatchObject({
      protocol: LlmProtocol.OPENAI_RESPONSES,
      contextLimit: 250_000,
      thinking: 'on',
    })
  })
})
