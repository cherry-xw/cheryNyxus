import { describe, expect, it } from 'vitest'
import {
  isPianoRootSession,
  layoutPianoKeys,
  sessionPianoKeyCount,
} from '../../../src/features/pets/nyxus/composables/pianoNotes'

describe('Nyxus history piano key count', () => {
  it('creates exactly one key per root history item without filler keys', () => {
    expect(sessionPianoKeyCount(0)).toBe(0)
    expect(sessionPianoKeyCount(3)).toBe(3)
    expect(layoutPianoKeys(sessionPianoKeyCount(3)).keys).toHaveLength(3)
  })
})

describe('Nyxus piano root session filter', () => {
  it('keeps original root sessions (branchKind missing or original)', () => {
    expect(isPianoRootSession({})).toBe(true)
    expect(isPianoRootSession({ branchKind: 'original' })).toBe(true)
  })

  it('drops branch sessions even though they are independent root chats', () => {
    expect(isPianoRootSession({ branchKind: 'continuation' })).toBe(false)
    expect(isPianoRootSession({ branchKind: 'detail' })).toBe(false)
  })

  it('drops spawned child chats regardless of branchKind', () => {
    expect(isPianoRootSession({ parentChatId: 'p1' })).toBe(false)
    expect(isPianoRootSession({ parentChatId: 'p1', branchKind: 'original' })).toBe(false)
    expect(isPianoRootSession({ parentChatId: 'p1', branchKind: 'continuation' })).toBe(false)
  })
})
