/**
 * Stable application-state entry point for UI features.
 * Store layout is an implementation detail; features must not import `@/stores` directly.
 */
export {
  useAgentsStore,
  useAuthStore,
  useChatSessionsStore,
  useConnectionStore,
  useInteractionsStore,
  usePetPresentationStore,
  useThemeStore,
  useWorkspaceStore,
} from '@/stores'
export type { StreamState } from '@/stores'
