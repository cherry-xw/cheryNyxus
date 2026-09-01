/** Stable application-shell port for dialogs, drawers and workbench windows. */
export { useWorkspaceStore } from '@/stores/workspace'
export type {
  HistoryDrawerAnchor,
  HistoryDrawerMode,
  OverlayKind,
  SubagentDisplayMode,
  WorkbenchWindowState,
} from '@/stores/workspace/uiState'
export type {
  DiagnosticSeverity,
  OpenWorkspaceWindowInput,
  WorkspaceLayoutSnapshot,
  WorkspaceWindowContext,
  WorkspaceWindowGeometry,
  WorkspaceWindowKind,
  WorkspaceWindowLifecycle,
  WorkspaceWindowState,
} from '@/stores/workspace/windowModel'
