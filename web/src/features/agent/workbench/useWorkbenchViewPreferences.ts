import { ref, watch } from 'vue'

export type FoldMode = 'none' | 'partial' | 'full' | 'participant'

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
  watch([topologyLayout, foldMode, paperMode], saveWorkbenchViewPreference)

  return { topologyLayout, foldMode, paperMode }
}
