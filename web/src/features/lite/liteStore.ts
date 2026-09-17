import { defineStore } from 'pinia'
import {
  createLiteNodeDetailCache,
  type LiteDetailSectionName,
  type LiteDetailSectionState,
  type LiteNodeDetailCache,
} from './detailSections'

const DETAIL_NODE_CACHE_LIMIT = 12

/**
 * 单个问题在本 Lite 窗口内的作答草稿（UI 态，仅存于 store）。
 * selected：已选 label；notes：label → 选项补充；freeText：自由回答或「其他」选项的输入内容；
 * otherActive：「其他」输入框作为选项时的激活态（单选=radio 选中抢走其他选项；多选=复选框勾选，输入内容自动勾选）。
 */
export interface LiteQuestionDraft {
  selected: string[]
  notes: Record<string, string>
  freeText: string
  otherActive?: boolean
}

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
  detailInitialSection: LiteDetailSectionName | null
  detailCache: Record<string, LiteNodeDetailCache>
  interactionDrafts: Record<string, Record<string, LiteQuestionDraft>>
  commandError: { code: string; message: string; interactionId?: string } | null
  /** 顶部待操作 tab：激活的 interactionId（null=收起）。 */
  pendingTab: string | null
  /** 待处理面板收起态（v1.1）：true=仅保留标签栏；按窗口 × 根会话隔离。 */
  pendingCollapsed: boolean
  /** 详情抽屉拖拽宽度（v1.2，px）：null=默认 min(460px, 92%)；按窗口 × 根会话隔离。 */
  detailDrawerWidth: number | null
}

/** 工作台视图模式：树（Pixi 节点树主画布）/ 对话（整屏会话气泡视图）/ 精简（lite 紧凑会话视图）。 */
export type WorkbenchViewMode = 'tree' | 'conversation' | 'lite'

interface LiteStoreState {
  /** 视图模式持久化，按工作台窗口隔离（key = windowId/presetId）。 */
  viewModeByWindow: Record<string, WorkbenchViewMode>
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
    detailInitialSection: null,
    detailCache: {},
    interactionDrafts: {},
    commandError: null,
    pendingTab: null,
    pendingCollapsed: false,
    detailDrawerWidth: null,
  }
}

export const useLiteStore = defineStore('lite-workbench', {
  state: (): LiteStoreState => ({
    viewModeByWindow: {},
    uiByWindowRoot: {},
  }),
  getters: {
    isLiteActive(state): (windowId: string) => boolean {
      return (windowId) => state.viewModeByWindow[windowId] === 'lite'
    },
    rootUi(state): (windowId: string, rootChatId: string) => LiteRootUiState | undefined {
      return (windowId, rootChatId) => state.uiByWindowRoot[windowId]?.[rootChatId]
    },
  },
  actions: {
    setViewMode(windowId: string, mode: WorkbenchViewMode): void {
      this.viewModeByWindow = { ...this.viewModeByWindow, [windowId]: mode }
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
    ensureNodeDetail(windowId: string, rootChatId: string, nodeId: string): LiteNodeDetailCache {
      const current = this.ensureRootUi(windowId, rootChatId)
      const existing = current.detailCache[nodeId]
      if (existing) return existing
      const created = createLiteNodeDetailCache()
      const retained = Object.fromEntries(
        Object.entries(current.detailCache).slice(-(DETAIL_NODE_CACHE_LIMIT - 1)),
      )
      this.patchRootUi(windowId, rootChatId, {
        detailCache: { ...retained, [nodeId]: created },
      })
      return created
    },
    patchDetailSection(
      windowId: string,
      rootChatId: string,
      nodeId: string,
      section: LiteDetailSectionName,
      value: LiteDetailSectionState,
    ): void {
      const detail = this.ensureNodeDetail(windowId, rootChatId, nodeId)
      const current = this.ensureRootUi(windowId, rootChatId)
      this.patchRootUi(windowId, rootChatId, {
        detailCache: {
          ...current.detailCache,
          [nodeId]: { ...detail, [section]: value },
        },
      })
    },
    clearWindow(windowId: string): void {
      const { [windowId]: _ui, ...uiByWindowRoot } = this.uiByWindowRoot
      this.uiByWindowRoot = uiByWindowRoot
    },
  },
})
