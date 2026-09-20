export interface ComposerTurnState {
  active: boolean
  awaitingInput: boolean
}
export function advanceComposerTurn(
  previous: ComposerTurnState,
  input: { active: boolean; pending: number; dismissed: boolean },
): { state: ComposerTurnState; open: boolean; resetDismissal: boolean } {
  const resetDismissal = input.active && !previous.active
  const awaitingInput = !input.active && (previous.active || previous.awaitingInput)
  const open = awaitingInput && input.pending === 0 && !input.dismissed
  return {
    state: { active: input.active, awaitingInput: awaitingInput && !open },
    open,
    resetDismissal,
  }
}
