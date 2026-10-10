import type { PendingInput } from '@/application/backend/public'

export type MainInputPhase = 'idle' | 'editing' | 'pending' | 'consuming' | 'entity'

export interface MainInputState {
  phase: MainInputPhase
  draftKey: string
  content: string
  inputId?: string
  messageId?: string
  anchorKey?: string
  error?: string
}

export type MainInputEvent =
  | { type: 'edit' }
  | { type: 'close' }
  | { type: 'submit-failed'; content: string; error: string }
  | { type: 'submit-accepted'; inputId: string; messageId: string; content: string }
  | { type: 'claimed' }
  | { type: 'committed' }
  | { type: 'reset'; draftKey?: string }

export function createMainInputState(draftKey: string): MainInputState {
  return { phase: 'idle', draftKey, content: '' }
}

/** Pure CP5 lifecycle reducer. Invalid or stale events leave the state unchanged. */
export function reduceMainInputState(
  state: Readonly<MainInputState>,
  event: MainInputEvent,
): MainInputState {
  if (event.type === 'reset') return createMainInputState(event.draftKey ?? state.draftKey)
  if (event.type === 'edit' && state.phase === 'idle') {
    return { ...state, phase: 'editing', error: undefined }
  }
  if (event.type === 'close' && state.phase === 'editing') {
    return createMainInputState(state.draftKey)
  }
  if (event.type === 'submit-failed' && state.phase === 'editing') {
    return { ...state, content: event.content, error: event.error }
  }
  if (event.type === 'submit-accepted' && state.phase === 'editing') {
    return {
      phase: 'pending',
      draftKey: state.draftKey,
      content: event.content,
      inputId: event.inputId,
      messageId: event.messageId,
      anchorKey: event.messageId,
    }
  }
  if (event.type === 'claimed' && state.phase === 'pending') {
    return { ...state, phase: 'consuming' }
  }
  if (event.type === 'committed' && state.phase === 'consuming') {
    return { ...state, phase: 'entity' }
  }
  return { ...state }
}

export function pendingInputPhase(input: Pick<PendingInput, 'state'>): 'pending' | 'consuming' {
  return input.state === 'consumed' ? 'consuming' : 'pending'
}

/** Pending nodes use the final message identity; the input id is command correlation only. */
export function pendingInputAnchor(input: Pick<PendingInput, 'inputId' | 'messageId'>): string {
  return input.messageId ?? `input:${input.inputId}`
}
