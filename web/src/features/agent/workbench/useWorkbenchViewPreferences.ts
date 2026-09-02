import { ref, watch } from 'vue'

export type FoldMode = 'none' | 'partial' | 'full' | 'participant'
export type WorkbenchPresentationMode = 'horizontal-signal' | 'vertical-classic'

type WorkbenchViewPreference = {
  layout: 'timeline' | 'topology'
  foldMode: FoldMode
  paperMode: boolean
}

const DEFAULT_WORKBENCH_VIEW: WorkbenchViewPreference = {
  layout: 'timeline',
  foldMode: 'participant',
  paperMode: false,
}
const WORKBENCH_VIEW_STORAGE_PREFIX = 'nx-workbench-view:'
const FOLD_MODES = new Set<FoldMode>(['none', 'partial', 'participant', 'full'])

function loadPreference(presetId: string): WorkbenchViewPreference {
  if (typeof localStorage === 'undefined') return DEFAULT_WORKBENCH_VIEW
  try {
    const value = JSON.parse(
      localStorage.getItem(`${WORKBENCH_VIEW_STORAGE_PREFIX}${presetId}`) ?? 'null',
    ) as Partial<WorkbenchViewPreference> | null
    return {
      layout: value?.layout === 'topology' ? 'topology' : 'timeline',
      foldMode:
        typeof value?.foldMode === 'string' && FOLD_MODES.has(value.foldMode as FoldMode)
          ? (value.foldMode as FoldMode)
          : DEFAULT_WORKBENCH_VIEW.foldMode,
      paperMode: value?.paperMode === true,
    }
  } catch {
    return DEFAULT_WORKBENCH_VIEW
  }
}

export function useWorkbenchViewPreferences(presetId: string) {
  const initial = loadPreference(presetId)
  const topologyLayout = ref(initial.layout === 'topology')
  const foldMode = ref<FoldMode>(initial.foldMode)
  const paperMode = ref(initial.paperMode)
  // 2026-09-02 返工：图谱方向由卡牌阅读开关单一派生（卡牌开 → 纵向 Classic，关 → 横向 Signal），
  // 不再独立持久化——load 时忽略旧持久化的 presentationMode 字段完成迁移（见 workbench-multi-window.md）。
  const presentationMode = ref<WorkbenchPresentationMode>(
    initial.paperMode ? 'vertical-classic' : 'horizontal-signal',
  )

  function saveWorkbenchViewPreference(): void {
    if (typeof localStorage === 'undefined') return
    try {
      localStorage.setItem(
        `${WORKBENCH_VIEW_STORAGE_PREFIX}${presetId}`,
        JSON.stringify({
          layout: topologyLayout.value ? 'topology' : 'timeline',
          foldMode: foldMode.value,
          paperMode: paperMode.value,
        } satisfies WorkbenchViewPreference),
      )
    } catch {
      // Storage may be unavailable in privacy mode; keep the in-memory selection usable.
    }
  }
  // 卡牌开关是唯一方向入口。Signal 投影初始化失败回退（fallbackToClassic 直接写
  // presentationMode，不经本 watch）后，用户下一次手动切换卡牌时重新按派生规则联动；
  // 重载后派生值自然重置为按 paperMode 推导（即重试 Signal）。
  watch(paperMode, (paper) => {
    presentationMode.value = paper ? 'vertical-classic' : 'horizontal-signal'
  })
  watch([topologyLayout, foldMode, paperMode], saveWorkbenchViewPreference)

  return { topologyLayout, foldMode, paperMode, presentationMode }
}
