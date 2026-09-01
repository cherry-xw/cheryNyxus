import { defineStore, storeToRefs } from 'pinia'
import { createUiState } from './uiState'

/**
 * Application-shell state: dialogs, drawers and workbench windows.
 *
 * This store deliberately owns no chat, transport, interaction or pet runtime data.
 * Chat deletion is applied through `pruneDeletedChats`, the sole shell projection effect.
 */
export const useWorkspaceStore = defineStore('workspace', () => createUiState())

/** Ref-preserving compatibility port for non-component orchestration code. */
export function useWorkspacePort() {
  const store = useWorkspaceStore()
  return {
    ...storeToRefs(store),
    openHistoryRoot: store.openHistoryRoot,
    openHistoryGeneration: store.openHistoryGeneration,
    closeHistoryGeneration: store.closeHistoryGeneration,
    updateHistoryDrawerAnchor: store.updateHistoryDrawerAnchor,
    drillHistoryChild: store.drillHistoryChild,
    closeHistoryTop: store.closeHistoryTop,
    closeAllHistory: store.closeAllHistory,
    pruneHistoryStack: store.pruneHistoryStack,
    pruneDeletedChats: store.pruneDeletedChats,
    setSubagentDisplay: store.setSubagentDisplay,
    setSenseCallsCollapsed: store.setSenseCallsCollapsed,
    openOrFocusWindow: store.openOrFocusWindow,
    focusWorkspaceWindow: store.focusWorkspaceWindow,
    markWorkspaceWindowOpen: store.markWorkspaceWindowOpen,
    minimizeWorkspaceWindow: store.minimizeWorkspaceWindow,
    restoreWorkspaceWindow: store.restoreWorkspaceWindow,
    beginWorkspaceWindowClose: store.beginWorkspaceWindowClose,
    removeWorkspaceWindow: store.removeWorkspaceWindow,
    setWorkspaceWindowGeometry: store.setWorkspaceWindowGeometry,
    restoreWorkspaceLayout: store.restoreWorkspaceLayout,
    openWorkbenchWindow: store.openWorkbenchWindow,
    closeWorkbenchWindow: store.closeWorkbenchWindow,
    focusWorkbenchWindow: store.focusWorkbenchWindow,
    setWorkbenchWindowMinimized: store.setWorkbenchWindowMinimized,
    setWorkbenchWindowChat: store.setWorkbenchWindowChat,
    setWorkbenchWindowView: store.setWorkbenchWindowView,
    setWorkbenchWindowGeometry: store.setWorkbenchWindowGeometry,
    setWorkbenchWindowCapsulePos: store.setWorkbenchWindowCapsulePos,
    setWorkbenchWindowBlink: store.setWorkbenchWindowBlink,
    setWorkbenchWindowFocus: store.setWorkbenchWindowFocus,
    setWorkbenchWindowDrawer: store.setWorkbenchWindowDrawer,
    setWorkbenchWindowWorkspaceBrowser: store.setWorkbenchWindowWorkspaceBrowser,
  }
}
