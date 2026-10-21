import { configureInputAdoption } from '@/core/middleware/inputAdoption.js'
import type { BackendResumeRepository } from '@/db/backendResume.js'
import type { BackendStopCoordinator } from './backendStopCoordinator.js'
import type { BackendStopBlocker } from '@chery/protocol'

interface WorkBoundary {
  coordinator: BackendStopCoordinator
  resume: BackendResumeRepository
  canContinue(chatId: string): boolean
}

let boundary: WorkBoundary | undefined
const initialChildInputs = new Set<string>()
const blockerProviders = new Set<() => BackendStopBlocker[]>()

export function getBackendLifecycle() {
  if (!boundary) return undefined
  const coordinator = boundary.coordinator
  return {
    snapshot: () => coordinator.snapshot(),
    subscribe: (listener: (state: ReturnType<typeof coordinator.snapshot>) => void) => coordinator.subscribe(listener),
    blockers(provider: () => BackendStopBlocker[]) {
      blockerProviders.add(provider)
      return () => { blockerProviders.delete(provider) }
    },
  }
}

export function getBackendPluginBlockers(): BackendStopBlocker[] {
  return [...blockerProviders].flatMap((provider) => provider())
}

export function configureBackendWork(next: WorkBoundary | undefined): void {
  boundary = next
  initialChildInputs.clear()
  blockerProviders.clear()
  configureInputAdoption(next ? {
    canAdopt: (chatId) => initialChildInputs.has(chatId) ||
      (next.coordinator.canConsumeInput() && !next.resume.required(chatId)),
    canContinue: (chatId) => {
      const state = next.coordinator.snapshot()
      if (state.phase === 'running') return !next.resume.required(chatId)
      return !!state.operationId && ['requesting', 'draining'].includes(state.phase) && next.canContinue(chatId) &&
        !next.resume.continuationRequired(chatId, state.operationId)
    },
    adopted: (chatId) => { initialChildInputs.delete(chatId) },
  } : undefined)
}

export function isBackendStopping(): boolean { return boundary ? !boundary.coordinator.canConsumeInput() : false }
export function backendResumeRequired(chatId: string): boolean { return boundary?.resume.required(chatId) ?? false }
/** Parking the next input does not revoke permission to finish the already-adopted instruction. */
export function backendContinuationResumeRequired(chatId: string): boolean {
  if (!boundary) return false
  const state = boundary.coordinator.snapshot()
  if (state.operationId && ['requesting', 'draining'].includes(state.phase) && boundary.canContinue(chatId))
    return boundary.resume.continuationRequired(chatId, state.operationId)
  return boundary.resume.required(chatId)
}
export function assertNewBackendWork(): void { boundary?.coordinator.assertAdmission() }

/** chatId comes from server-owned adopted-work and child records, not a request flag. */
export function assertBackendContinuation(chatId: string): void {
  boundary?.coordinator.assertAdmission(boundary.canContinue(chatId))
}

export function permitBackendChildInput(childChatId: string, parentChatId: string): void {
  if (!boundary) return
  if (isBackendStopping()) {
    boundary.coordinator.assertAdmission(boundary.canContinue(parentChatId))
    initialChildInputs.add(childChatId)
  }
}

/** Only explicit Resume may release a restart gate; background callbacks may not. */
export function releaseBackendResume(chatId: string): void {
  assertBackendContinuation(chatId)
  boundary?.resume.resume(chatId)
}
