import type { WorkflowSnapshot } from '@chery/protocol'

export type WorkflowBoundary = Partial<
  Pick<
    WorkflowSnapshot,
    | 'activeNodeId'
    | 'status'
    | 'waitReason'
    | 'phaseLabel'
    | 'compactRequested'
    | 'iteration'
    | 'attempt'
    | 'batch'
    | 'resources'
    | 'contextStageId'
    | 'epochId'
  >
> & { newIteration?: boolean }

const observers = new Map<string, (boundary: WorkflowBoundary) => void>()

/** Read-only, optional observer. It is never an execution owner. */
export function observeWorkflow(
  chatId: string,
  observer: (boundary: WorkflowBoundary) => void,
): () => void {
  observers.set(chatId, observer)
  return () => {
    if (observers.get(chatId) === observer) observers.delete(chatId)
  }
}

export function hasWorkflowObserver(chatId: string): boolean {
  return observers.has(chatId)
}

export function reportWorkflow(chatId: string, boundary: WorkflowBoundary): void {
  try {
    observers.get(chatId)?.(boundary)
  } catch {
    /* Observation cannot interrupt execution. */
  }
}
