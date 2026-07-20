import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { hasActiveChatRun } from '../src/stores/agents/data/historyLoadState'

describe('history while a sub-agent approval is pending', () => {
  it('preserves live state when either stream or pet is still working', () => {
    expect(hasActiveChatRun({ isWorking: true }, { isWorking: false })).toBe(true)
    expect(hasActiveChatRun({ isWorking: false }, { isWorking: true })).toBe(true)
    expect(hasActiveChatRun({ isWorking: false }, { isWorking: false })).toBe(false)
  })

  it('keeps the pet stage out of a root stacking context', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../src/features/pets/PetStage.vue', import.meta.url)),
      'utf8',
    )
    const petStageRule = source.match(/\.pet-stage\s*\{(?<body>[\s\S]*?)\n\}/)?.groups?.body

    expect(petStageRule).toContain('position: absolute')
    expect(petStageRule).not.toContain('position: fixed')
  })
})
