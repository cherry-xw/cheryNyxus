import { computed, ref, watch, type Ref } from 'vue'
import { useLiteStore, type WorkbenchViewMode } from '@/features/lite/liteStore'

/**
 * useWorkbenchViewMode：工作台三视图模式切换（树 / 对话 / 精简）。
 * 以 liteStore.viewModeByWindow 为单一事实源（computed 派生），persist 到 localStorage。
 * 浏览器面 WorkbenchDialog 自绘 titlebar 与 Electron 面 App.vue WindowFrame
 * title-actions 共用同一 composable，同一 windowId 下各处视图状态天然同步
 * （读写同一 store + 同一 localStorage key）。
 * 旧两档键（cherynyxus:workbench-lite-view，'1'=精简）读取时迁移到三档键。
 */
const VIEW_MODE_KEY_PREFIX = 'cherynyxus:workbench-view-mode'
const LEGACY_LITE_KEY_PREFIX = 'cherynyxus:workbench-lite-view'

export function viewModeKey(windowId: string): string {
  return `${VIEW_MODE_KEY_PREFIX}:${windowId}`
}

export function legacyLiteViewKey(windowId: string): string {
  return `${LEGACY_LITE_KEY_PREFIX}:${windowId}`
}

export function readViewModePersisted(windowId: string): WorkbenchViewMode {
  try {
    const value = localStorage.getItem(viewModeKey(windowId))
    if (value === 'tree' || value === 'conversation' || value === 'lite') return value
    // 旧两档键迁移：'1' 表示精简视图，其余缺省为树视图。
    if (localStorage.getItem(legacyLiteViewKey(windowId)) === '1') return 'lite'
    return 'tree'
  } catch {
    return 'tree'
  }
}

export function useWorkbenchViewMode(windowId: Ref<string> | string): {
  viewMode: Ref<WorkbenchViewMode>
  setViewMode: (mode: WorkbenchViewMode) => void
  isLite: Ref<boolean>
  isConversation: Ref<boolean>
} {
  const liteStore = useLiteStore()
  const id = typeof windowId === 'string' ? ref(windowId) : windowId

  // 单一事实源：store.viewModeByWindow。首次访问若 store 无记录，用 localStorage 种子值
  // 初始化（保证刷新后保持 + 双入口首读一致）。切换只写纯 UI state，不触碰连接或订阅。
  watch(
    id,
    (currentId) => {
      if (!(currentId in liteStore.viewModeByWindow)) {
        liteStore.setViewMode(currentId, readViewModePersisted(currentId))
      }
    },
    { immediate: true },
  )

  const viewMode = computed<WorkbenchViewMode>(() => liteStore.viewModeByWindow[id.value] ?? 'tree')

  function setViewMode(mode: WorkbenchViewMode): void {
    const currentId = id.value
    liteStore.setViewMode(currentId, mode)
    try {
      localStorage.setItem(viewModeKey(currentId), mode)
      localStorage.removeItem(legacyLiteViewKey(currentId))
    } catch {
      /* localStorage 不可用时仅会话内生效 */
    }
  }

  const isLite = computed(() => viewMode.value === 'lite')
  const isConversation = computed(() => viewMode.value === 'conversation')

  return { viewMode, setViewMode, isLite, isConversation }
}
