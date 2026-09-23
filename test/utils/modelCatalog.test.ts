import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LlmProtocol } from '@chery/protocol'

describe('modelCatalog', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    delete process.env.CHERY_DIR
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
    vi.resetModules()
  })

  async function loadProjectCatalog(content: string) {
    const dir = mkdtempSync(path.join(tmpdir(), 'chery-model-catalog-'))
    tempDirs.push(dir)
    mkdirSync(path.join(dir, '.chery'), { recursive: true })
    writeFileSync(path.join(dir, '.chery', 'model-catalog.yaml'), content, 'utf8')
    process.env.CHERY_DIR = dir
    vi.resetModules()
    return await import('@/utils/modelCatalog.js')
  }

  async function loadDefaultCatalog() {
    return await loadProjectCatalog(readFileSync('.chery.template/model-catalog.yaml', 'utf8'))
  }

  it('separates facts, recommendations, and wire mappings', async () => {
    const catalog = await loadDefaultCatalog()
    const resolved = catalog.resolveModelCatalog({
      model: 'MiniMax-M3',
      provider: 'newapi',
      protocol: LlmProtocol.OPENAI_CHAT_COMPLETIONS,
    })

    expect(resolved.id).toBe('minimax-m3')
    expect(resolved.facts?.contextWindow).toBe(1_000_000)
    expect(resolved.recommend?.contextLimit).toBe(250_000)
    expect(resolved.thinkingLevels).toEqual(['off', 'on'])
    expect(
      catalog.resolveCatalogThinkingParams({
        model: 'MiniMax-M3',
        provider: 'newapi',
        protocol: LlmProtocol.OPENAI_CHAT_COMPLETIONS,
        display: 'on',
      }),
    ).toEqual({ thinking: { type: 'adaptive' }, reasoning_split: true })
  })

  it('selects the recommendation for the active protocol', async () => {
    const catalog = await loadProjectCatalog(`
models:
  - id: protocol-model
    match: { models: [protocol-model] }
    recommend:
      contextLimit: 100000
      thinking: low
    recommendByProtocol:
      openai-responses:
        protocol: openai-responses
        contextLimit: 200000
        thinking: high
    wire:
      openai-responses:
        thinking:
          - { display: off, params: { reasoning: { effort: none } } }
          - { display: high, params: { reasoning: { effort: high } } }
`)

    expect(
      catalog.resolveModelCatalog({
        model: 'protocol-model',
        protocol: LlmProtocol.OPENAI_RESPONSES,
      }),
    ).toMatchObject({
      recommend: {
        protocol: LlmProtocol.OPENAI_RESPONSES,
        contextLimit: 200000,
        thinking: 'high',
      },
    })
    expect(catalog.resolveModelCatalog({ model: 'protocol-model' }).recommend).toEqual({
      contextLimit: 100000,
      thinking: 'low',
    })
  })

  it('applies configurable conservative recommendations to unknown models', async () => {
    const catalog = await loadDefaultCatalog()
    const resolved = catalog.resolveModelCatalog({
      model: 'private-unknown-model',
      protocol: LlmProtocol.OPENAI_CHAT_COMPLETIONS,
    })

    expect(resolved.matched).toBe(false)
    expect(resolved.thinkingLevels).toEqual([])
    expect(resolved.recommend).toMatchObject({
      protocol: LlmProtocol.OPENAI_CHAT_COMPLETIONS,
      contextLimit: 128_000,
      thinking: 'off',
      capabilities: { toolCall: true },
    })
    expect(resolved.unknown.capabilities?.toolCall).toBe(true)
  })

  it('matches default catalog rules by stable model family and version boundaries', async () => {
    const catalog = await loadDefaultCatalog()

    expect(catalog.resolveModelCatalog({ model: 'relay/MiniMax_M2-7-20260901' }).id).toBe(
      'minimax-m2.7',
    )
    expect(catalog.resolveModelCatalog({ model: 'newapi-deepseek_v3_2-chat' }).id).toBe(
      'deepseek-v3.2',
    )
    expect(catalog.resolveModelCatalog({ model: 'vendor:gpt_5_6-terra-2026-08-31' }).id).toBe(
      'openai-gpt-5.6',
    )
    expect(
      catalog.resolveModelCatalog({
        model: 'xxx-glm-5.3',
        protocol: LlmProtocol.OPENAI_CHAT_COMPLETIONS,
      }),
    ).toMatchObject({
      id: 'zhipu-glm-5.3',
      recommend: { contextLimit: 128_000, thinking: 'max' },
      thinkingLevels: ['low', 'high', 'max'],
    })
    expect(
      catalog.resolveModelCatalog({
        model: 'xxx-glm-5.2',
        protocol: LlmProtocol.OPENAI_CHAT_COMPLETIONS,
      }),
    ).toMatchObject({
      id: 'zhipu-glm-5.2',
      recommend: { contextLimit: 128_000, thinking: 'max' },
      thinkingLevels: ['low', 'high', 'max'],
    })
    expect(catalog.resolveModelCatalog({ model: 'glm5_1-relay' }).id).toBe('zhipu-glm-5.1')
    expect(catalog.resolveModelCatalog({ model: 'deepseek-v4.1' }).matched).toBe(false)
    expect(catalog.resolveModelCatalog({ model: 'glm-5.10' }).matched).toBe(false)
    expect(catalog.resolveModelCatalog({ model: 'gpt-5.60' }).matched).toBe(false)
  })

  it('does not hide vendor model rules in application code', async () => {
    const catalog = await loadProjectCatalog('version: 1\nmodels: []\n')
    expect(catalog.resolveModelCatalog({ model: 'MiniMax-M3' }).matched).toBe(false)
  })

  it('supports exact, glob, and regular-expression matches', async () => {
    const catalog = await loadProjectCatalog(`
version: 1
models:
  - id: exact-rule
    match:
      models: [{ exact: exact-model }]
    recommend: { contextLimit: 111000 }
  - id: regex-rule
    match:
      models:
        - { regex: '^relay-(alpha|beta)-\\d+$', flags: i }
    recommend: { contextLimit: 222000 }
  - id: glob-rule
    match:
      models: ['relay-*']
    recommend: { contextLimit: 333000 }
`)

    expect(catalog.resolveModelCatalog({ model: 'exact-model' }).id).toBe('exact-rule')
    expect(catalog.resolveModelCatalog({ model: 'RELAY-alpha-42' }).id).toBe('regex-rule')
    expect(catalog.resolveModelCatalog({ model: 'relay-other' }).id).toBe('glob-rule')
  })

  it('project rules may define only thinking wire data', async () => {
    const catalog = await loadProjectCatalog(`
models:
  - id: minimax-m3
    match:
      models: [{ regex: '^private-minimax$' }]
    wire:
      openai-chat-completions:
        thinking:
          - { display: off, params: {} }
          - { display: turbo, params: { thinking: { type: enabled }, budget: 9 } }
`)

    const resolved = catalog.resolveModelCatalog({
      model: 'private-minimax',
      protocol: LlmProtocol.OPENAI_CHAT_COMPLETIONS,
    })
    expect(resolved.thinkingLevels).toEqual(['off', 'turbo'])
    expect(resolved.facts).toBeUndefined()
    expect(resolved.recommend).toBeUndefined()
    expect(
      catalog.resolveCatalogThinkingParams({
        model: 'private-minimax',
        protocol: LlmProtocol.OPENAI_CHAT_COMPLETIONS,
        display: 'turbo',
      }),
    ).toEqual({ thinking: { type: 'enabled' }, budget: 9 })
  })

  it('adopts a changed catalog only after cache reset', async () => {
    const catalog = await loadProjectCatalog(`models:
  - id: old
    match: { models: [target] }
`)
    const file = path.join(process.env.CHERY_DIR!, '.chery', 'model-catalog.yaml')
    expect(catalog.resolveModelCatalog({ model: 'target' }).id).toBe('old')
    writeFileSync(
      file,
      `models:
  - id: new
    match: { models: [target] }
`,
      'utf8',
    )

    expect(catalog.resolveModelCatalog({ model: 'target' }).id).toBe('old')
    catalog.resetModelCatalogCache()
    expect(catalog.resolveModelCatalog({ model: 'target' }).id).toBe('new')
  })

  it('keeps DeepSeek reasoning history protocol-specific', async () => {
    const catalog = await loadDefaultCatalog()
    expect(
      catalog.resolveCatalogReasoningHistory({
        model: 'deepseek-v4-pro',
        protocol: LlmProtocol.OPENAI_CHAT_COMPLETIONS,
      }),
    ).toBe('assistant-field')
    expect(
      catalog.resolveCatalogReasoningHistory({
        model: 'deepseek-v4-pro',
        protocol: LlmProtocol.OPENAI_RESPONSES,
      }),
    ).toBe('reasoning-item')
    expect(
      catalog.resolveCatalogReasoningHistory({
        model: 'deepseek-v4-pro',
        protocol: LlmProtocol.ANTHROPIC_MESSAGES,
      }),
    ).toBe('thinking-block')
  })

  it('uses official multi-level thinking rules for GLM and Step models', async () => {
    const catalog = await loadDefaultCatalog()

    expect(
      catalog.resolveCatalogThinkingParams({
        model: 'relay/GLM-5.3-flash',
        protocol: LlmProtocol.OPENAI_CHAT_COMPLETIONS,
        display: 'max',
      }),
    ).toEqual({ thinking: { type: 'enabled' }, reasoning_effort: 'max' })
    expect(
      catalog.resolveModelCatalog({
        model: 'relay/GLM-5.3-flash',
        protocol: LlmProtocol.OPENAI_CHAT_COMPLETIONS,
      }),
    ).toMatchObject({
      id: 'zhipu-glm-5.3-flash',
      facts: { capabilities: { input: { image: true } } },
    })

    expect(
      catalog.resolveModelCatalog({
        model: 'vendor/step-3.7-flash',
        protocol: LlmProtocol.OPENAI_CHAT_COMPLETIONS,
      }),
    ).toMatchObject({
      id: 'step-3.7',
      recommend: { thinking: 'medium' },
      thinkingLevels: ['low', 'medium', 'high'],
    })

    expect(
      catalog.resolveModelCatalog({
        model: 'vendor/step-3.5-flash-2603',
        protocol: LlmProtocol.OPENAI_CHAT_COMPLETIONS,
      }).thinkingLevels,
    ).toEqual(['low', 'high'])
  })

  it('keeps GLM thinking levels available when using the Anthropic protocol', async () => {
    const catalog = await loadDefaultCatalog()
    expect(
      catalog.resolveModelCatalog({
        model: 'glm-5.3',
        protocol: LlmProtocol.ANTHROPIC_MESSAGES,
      }),
    ).toMatchObject({
      recommend: { protocol: LlmProtocol.ANTHROPIC_MESSAGES, thinking: 'max' },
      thinkingLevels: ['low', 'high', 'max'],
    })
    expect(
      catalog.resolveCatalogThinkingParams({
        model: 'glm-5.3',
        protocol: LlmProtocol.ANTHROPIC_MESSAGES,
        display: 'high',
      }),
    ).toEqual({ thinking: { type: 'adaptive' }, output_config: { effort: 'high' } })
  })

  it('matches the GPT-6 family and recommends the OpenAI service', async () => {
    const catalog = await loadDefaultCatalog()
    // Astra 官方不支持 none（off），档位从 low 到 max
    for (const model of ['gpt-6-astra', 'relay/gpt-6-astra-pro']) {
      expect(
        catalog.resolveModelCatalog({ model, protocol: LlmProtocol.OPENAI_RESPONSES }),
      ).toMatchObject({
        id: 'openai-gpt-6-astra',
        recommend: {
          provider: 'openai',
          protocol: LlmProtocol.OPENAI_RESPONSES,
          thinking: 'medium',
        },
        thinkingLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      })
    }
    // Sol/Luna 官方支持 none（off）到 max
    for (const model of ['gpt-6-sol', 'gpt-6-luna']) {
      expect(
        catalog.resolveModelCatalog({ model, protocol: LlmProtocol.OPENAI_RESPONSES }),
      ).toMatchObject({
        id: 'openai-gpt-6',
        thinkingLevels: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
      })
    }
    expect(
      catalog.resolveCatalogThinkingParams({
        model: 'gpt-6-sol',
        protocol: LlmProtocol.OPENAI_RESPONSES,
        display: 'max',
      }),
    ).toEqual({ reasoning: { effort: 'max' } })
    expect(
      catalog.resolveCatalogThinkingParams({
        model: 'gpt-6-astra',
        protocol: LlmProtocol.OPENAI_RESPONSES,
        display: 'max',
      }),
    ).toEqual({ reasoning: { effort: 'max' } })
    expect(
      catalog.resolveModelCatalog({ model: 'gpt-6-astra', protocol: LlmProtocol.OPENAI_RESPONSES })
        .facts?.capabilities?.input?.image,
    ).toBe(true)
    expect(catalog.resolveModelCatalog({ model: 'gpt-6.1' }).matched).toBe(false)
  })

  it('exposes max reasoning effort for GPT-5.6', async () => {
    const catalog = await loadDefaultCatalog()
    expect(
      catalog.resolveModelCatalog({
        model: 'gpt-5.6-sol',
        protocol: LlmProtocol.OPENAI_RESPONSES,
      }).thinkingLevels,
    ).toEqual(['off', 'low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('recommends a vendor provider for catalogued models', async () => {
    const catalog = await loadDefaultCatalog()
    expect(catalog.resolveModelCatalog({ model: 'glm-5.3' }).recommend?.provider).toBe('bigmodel')
    expect(catalog.resolveModelCatalog({ model: 'MiniMax-M3' }).recommend?.provider).toBe('minimax')
    expect(catalog.resolveModelCatalog({ model: 'deepseek-v4-pro' }).recommend?.provider).toBe(
      'deepseek',
    )
    expect(catalog.resolveModelCatalog({ model: 'claude-opus-4.7' }).recommend?.provider).toBe(
      'anthropic',
    )
    expect(catalog.resolveModelCatalog({ model: 'step-3.7-flash' }).recommend?.provider).toBeUndefined()
  })

  it('keeps known media facts while staying conservative for unverified thinking wires', async () => {
    const catalog = await loadDefaultCatalog()

    expect(
      catalog.resolveModelCatalog({
        model: 'mimo-v2.6-flash',
        protocol: LlmProtocol.OPENAI_CHAT_COMPLETIONS,
      }),
    ).toMatchObject({
      id: 'xiaomi-mimo-v2',
      facts: { capabilities: { input: { image: true, video: true, audio: true } } },
      thinkingLevels: [],
    })
  })
})
