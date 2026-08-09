import { describe, expect, it } from 'vitest'
import {
  layoutPianoKeys,
  sessionPianoKeyCount,
} from '../../../src/features/pets/nyxus/composables/pianoNotes'

describe('Nexus history piano key count', () => {
  it('creates exactly one key per root history item without filler keys', () => {
    expect(sessionPianoKeyCount(0)).toBe(0)
    expect(sessionPianoKeyCount(3)).toBe(3)
    expect(layoutPianoKeys(sessionPianoKeyCount(3)).keys).toHaveLength(3)
  })
})
