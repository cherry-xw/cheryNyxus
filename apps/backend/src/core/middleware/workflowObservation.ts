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

const observers = new Map<string, Set<(boundary: WorkflowBoundary) => void>>()

/** Read-only, optional observer. It is never an execution owner. */
export function observeWorkflow(
  chatId: string,
  observer: (boundary: WorkflowBoundary) => void,
): () => void {
  const listeners = observers.get(chatId) ?? new Set()
  listeners.add(observer)
  observers.set(chatId, listeners)
  return () => {
    const current = observers.get(chatId)
    current?.delete(observer)
    if (!current?.size) observers.delete(chatId)
  }
}

export function hasWorkflowObserver(chatId: string): boolean {
  return observers.has(chatId)
}

export function reportWorkflow(chatId: string, boundary: WorkflowBoundary): void {
  for (const observer of observers.get(chatId) ?? []) {
    try {
      observer(boundary)
    } catch {
      /* Observation cannot interrupt execution or another observer. */
    }
  }
}
