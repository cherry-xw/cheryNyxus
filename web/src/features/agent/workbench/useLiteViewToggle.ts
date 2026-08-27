import { computed, ref, watch, type Ref } from 'vue'
import { useLiteStore } from '@/features/lite/liteStore'

/**
 * useLiteViewToggle：工作台 lite 极简视图切换（§2.1）。
 * 以 liteStore.activeByWindow 为单一事实源（computed 派生），persist 到 localStorage。
 * 浏览器面 WorkbenchDialog 自绘 titlebar 与 Electron 面 App.vue WindowFrame
 * title-actions 共用同一 composable，同一 windowId 下两处视图状态天然同步
 * （读写同一 store + 同一 localStorage key）。
 */
const LITE_VIEW_KEY_PREFIX = 'cherynyxus:workbench-lite-view'

export function liteViewKey(windowId: string): string {
  return `${LITE_VIEW_KEY_PREFIX}:${windowId}`
}

export function readLiteViewPersisted(windowId: string): boolean {
  try {
    return localStorage.getItem(liteViewKey(windowId)) === '1'
  } catch {
    return false
  }
}

export function useLiteViewToggle(windowId: Ref<string> | string): {
  liteViewEnabled: Ref<boolean>
  toggleLiteView: () => void
} {
  const liteStore = useLiteStore()
  const id = typeof windowId === 'string' ? ref(windowId) : windowId

  // 单一事实源：store.activeByWindow。首次访问若 store 无记录，用 localStorage 种子值
  // 初始化（保证刷新后保持 + 两入口首读一致）。切换只写纯 UI state，不触碰连接或订阅。
  watch(
    id,
    (currentId) => {
      if (!(currentId in liteStore.activeByWindow)) {
        liteStore.setActive(currentId, readLiteViewPersisted(currentId))
      }
    },
    { immediate: true },
  )

  const liteViewEnabled = computed<boolean>(() => !!liteStore.activeByWindow[id.value])

  function toggleLiteView(): void {
    const currentId = id.value
    const next = !liteStore.activeByWindow[currentId]
    liteStore.setActive(currentId, next)
    try {
      localStorage.setItem(liteViewKey(currentId), next ? '1' : '0')
    } catch {
      /* localStorage 不可用时仅会话内生效 */
    }
  }

  return { liteViewEnabled, toggleLiteView }
}
