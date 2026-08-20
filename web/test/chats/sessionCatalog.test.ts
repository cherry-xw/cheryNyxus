import { describe, expect, it } from 'vitest'
import type { ChatSummary } from '../../src/services/agentApi'
import { createSessionCatalog } from '../../src/stores/agents/data/sessionCatalog'

function chat(chatId: string, preset: string, preview?: string): ChatSummary {
  return { chatId, preset, preview, createdAt: 1, updatedAt: 1 }
}

describe('session catalog', () => {
  it('merges scoped responses without replacing unrelated list consumers', () => {
    const catalog = createSessionCatalog()
    catalog.replace([chat('a', 'alpha', 'old'), chat('b', 'beta')])
    catalog.replacePreset('alpha', [chat('a', 'alpha', 'new'), chat('c', 'alpha')])

    expect(catalog.summaries.value.map((item) => item.chatId)).toEqual(['b', 'a', 'c'])
    expect(catalog.summaries.value.find((item) => item.chatId === 'a')?.preview).toBe('new')
  })

  it('removes an authoritative deletion set atomically', () => {
    const catalog = createSessionCatalog()
    catalog.replace([chat('root', 'alpha'), chat('child', 'alpha'), chat('other', 'beta')])

    catalog.remove(['root', 'child'])

    expect(catalog.summaries.value.map((item) => item.chatId)).toEqual(['other'])
  })

  it('does not resurrect deleted sessions from a late list response', () => {
    const catalog = createSessionCatalog()
    catalog.replace([chat('deleted', 'alpha')])
    catalog.remove(['deleted'])

    catalog.merge([chat('deleted', 'alpha', 'stale')])
    catalog.replace([chat('deleted', 'alpha', 'stale')])

    expect(catalog.summaries.value).toEqual([])
  })
})
