import type { RootTimelineSnapshot } from '@/application/backend/public'

export function selectTreeTimelineOverride(
  live: RootTimelineSnapshot | undefined,
  fallback: RootTimelineSnapshot | undefined,
): RootTimelineSnapshot | undefined {
  if (!fallback) return undefined
  if (!live || live.revision < fallback.revision) return fallback
  return undefined
}
