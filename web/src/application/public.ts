/**
 * Stable application-state entry point for UI features.
 * Store layout is an implementation detail; features must not import `@/stores` directly.
 */
export {
  useAgentsStore,
  useAuthStore,
  useChatSessionsStore,
  useConfigApplyStore,
  useConnectionStore,
  useInteractionsStore,
  useTaskOverviewStore,
  usePetPresentationStore,
  useThemeStore,
  useWorkspaceStore,
} from '@/stores'
export type { StreamState } from '@/stores'
