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
      recommend: { contextLimit: 128_000, thinking: 'on' },
      thinkingLevels: ['off', 'on'],
    })
    expect(
      catalog.resolveModelCatalog({
        model: 'xxx-glm-5.2',
        protocol: LlmProtocol.OPENAI_CHAT_COMPLETIONS,
      }),
    ).toMatchObject({
      id: 'zhipu-glm-5.2',
      recommend: { contextLimit: 128_000, thinking: 'on' },
      thinkingLevels: ['off', 'on'],
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
})
