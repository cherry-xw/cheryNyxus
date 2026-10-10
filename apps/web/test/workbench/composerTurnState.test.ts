import { describe, expect, it } from 'vitest'
import { advanceComposerTurn } from '../../src/features/agent/workbench/composerTurnState'

describe('composer after a response', () => {
  it('opens once after the response finishes', () => {
    const result = advanceComposerTurn(
      { active: true, awaitingInput: false },
      { active: false, pending: 0, dismissed: false },
    )
    expect(result.open).toBe(true)
    expect(
      advanceComposerTurn(result.state, { active: false, pending: 0, dismissed: false }).open,
    ).toBe(false)
  })
  it('waits for approval or question handling to finish', () => {
    const waiting = advanceComposerTurn(
      { active: true, awaitingInput: false },
      { active: false, pending: 1, dismissed: false },
    )
    expect(waiting.open).toBe(false)
    expect(
      advanceComposerTurn(waiting.state, { active: false, pending: 0, dismissed: false }).open,
    ).toBe(true)
  })
  it('respects a manual close and resets that choice only on the next turn', () => {
    const closed = advanceComposerTurn(
      { active: true, awaitingInput: false },
      { active: false, pending: 0, dismissed: true },
    )
    expect(closed.open).toBe(false)
    expect(
      advanceComposerTurn(closed.state, { active: true, pending: 0, dismissed: true })
        .resetDismissal,
    ).toBe(true)
  })
  it('does not open just because an idle conversation is loaded or a run is active', () => {
    expect(
      advanceComposerTurn(
        { active: false, awaitingInput: false },
        { active: false, pending: 0, dismissed: false },
      ).open,
    ).toBe(false)
    expect(
      advanceComposerTurn(
        { active: false, awaitingInput: true },
        { active: true, pending: 0, dismissed: false },
      ).open,
    ).toBe(false)
  })
})
