import type { InteractionRecord } from '@/application/backend/public'

export function resolveWorkspaceRootChatId(
  timelineRootChatId?: string,
  selectedChatId?: string,
): string | undefined {
  return timelineRootChatId || selectedChatId || undefined
}

/** A root identity remains usable when the request has no preset metadata. */
export function belongsToWorkspace(
  item: Pick<InteractionRecord, 'presetId' | 'rootChatId'>,
  presetId?: string,
  rootChatId?: string,
): boolean {
  if (rootChatId) return item.rootChatId === rootChatId
  return !presetId || item.presetId === presetId
}
