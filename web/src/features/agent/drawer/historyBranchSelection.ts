import type { ConversationBranchSummary, RootTimelineSnapshot } from '@/application/backend/public'

/**
 * Resolve the task for a drawer chat even when the lightweight history catalog does not contain
 * that branch. Workbench-opened drawers already carry the authoritative branch summaries.
 */
export function resolveHistoryTaskId(
  chatId: string,
  summaryTaskId: string | undefined,
  injectedBranches: readonly ConversationBranchSummary[],
): string | undefined {
  return summaryTaskId ?? injectedBranches.find((branch) => branch.chatId === chatId)?.taskId
}

/** Open a task drawer on its active branch; retain the original branch and current chat fallbacks. */
export function resolveTaskDrawerChatId(
  timeline: Pick<RootTimelineSnapshot, 'activeBranchId' | 'branches'> | undefined,
  currentChatId: string | null | undefined,
): string | undefined {
  const branches = timeline?.branches ?? []
  return (
    branches.find((branch) => branch.branchId === timeline?.activeBranchId)?.chatId ??
    branches.find((branch) => branch.kind === 'original')?.chatId ??
    currentChatId ??
    undefined
  )
}
