import { defineStore } from 'pinia'

/**
 * Lite is a presentation of the canonical workbench session. This store must
 * therefore contain UI state only: no socket, subscription, timeline, replay
 * cursor, interaction inbox or command lifecycle is allowed here.
 */
export interface LiteRootUiState {
  expandedItemIds: string[]
  inputDraft: string
  scrollTop: number
  autoScroll: boolean
  detailNodeId: string | null
  detailFocusToolCallId: string | null
  interactionDrafts: Record<string, Record<string, string[] | string>>
  commandError: { code: string; message: string; interactionId?: string } | null
}

interface LiteStoreState {
  /** Presentation mode is persisted per workbench window. */
  activeByWindow: Record<string, boolean>
  /** Ephemeral UI state is isolated by window and then by the explicit root. */
  uiByWindowRoot: Record<string, Record<string, LiteRootUiState>>
}

export function createLiteRootUiState(): LiteRootUiState {
  return {
    expandedItemIds: [],
    inputDraft: '',
    scrollTop: 0,
    autoScroll: true,
    detailNodeId: null,
    detailFocusToolCallId: null,
    interactionDrafts: {},
    commandError: null,
  }
}

export const useLiteStore = defineStore('lite-workbench', {
  state: (): LiteStoreState => ({
    activeByWindow: {},
    uiByWindowRoot: {},
  }),
  getters: {
    isLiteActive(state): (windowId: string) => boolean {
      return (windowId) => !!state.activeByWindow[windowId]
    },
    rootUi(state): (windowId: string, rootChatId: string) => LiteRootUiState | undefined {
      return (windowId, rootChatId) => state.uiByWindowRoot[windowId]?.[rootChatId]
    },
  },
  actions: {
    setActive(windowId: string, active: boolean): void {
      this.activeByWindow = { ...this.activeByWindow, [windowId]: active }
    },
    ensureRootUi(windowId: string, rootChatId: string): LiteRootUiState {
      const roots = this.uiByWindowRoot[windowId] ?? {}
      const existing = roots[rootChatId]
      if (existing) return existing
      const created = createLiteRootUiState()
      this.uiByWindowRoot = {
        ...this.uiByWindowRoot,
        [windowId]: { ...roots, [rootChatId]: created },
      }
      return created
    },
    patchRootUi(windowId: string, rootChatId: string, patch: Partial<LiteRootUiState>): void {
      const current = this.ensureRootUi(windowId, rootChatId)
      this.uiByWindowRoot = {
        ...this.uiByWindowRoot,
        [windowId]: {
          ...this.uiByWindowRoot[windowId],
          [rootChatId]: { ...current, ...patch },
        },
      }
    },
    clearWindow(windowId: string): void {
      const { [windowId]: _ui, ...uiByWindowRoot } = this.uiByWindowRoot
      this.uiByWindowRoot = uiByWindowRoot
    },
  },
})
