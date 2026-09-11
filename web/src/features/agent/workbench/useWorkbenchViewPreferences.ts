import { ref, watch } from 'vue'

export type FoldMode = 'none' | 'partial' | 'full' | 'participant'

type WorkbenchViewPreference = {
  foldMode: FoldMode
  readerOpen: boolean
}

type LegacyWorkbenchViewPreference = Partial<WorkbenchViewPreference> & {
  paperMode?: boolean
  layout?: 'timeline' | 'topology'
  presentationMode?: 'horizontal-signal' | 'vertical-classic'
}

const DEFAULT_WORKBENCH_VIEW: WorkbenchViewPreference = {
  foldMode: 'participant',
  readerOpen: false,
}
const WORKBENCH_VIEW_STORAGE_PREFIX = 'nx-workbench-view:'
const FOLD_MODES = new Set<FoldMode>(['none', 'partial', 'participant', 'full'])

function loadPreference(presetId: string): WorkbenchViewPreference {
  if (typeof localStorage === 'undefined') return DEFAULT_WORKBENCH_VIEW
  try {
    const value = JSON.parse(
      localStorage.getItem(`${WORKBENCH_VIEW_STORAGE_PREFIX}${presetId}`) ?? 'null',
    ) as LegacyWorkbenchViewPreference | null
    return {
      foldMode:
        typeof value?.foldMode === 'string' && FOLD_MODES.has(value.foldMode as FoldMode)
          ? (value.foldMode as FoldMode)
          : DEFAULT_WORKBENCH_VIEW.foldMode,
      readerOpen:
        typeof value?.readerOpen === 'boolean' ? value.readerOpen : value?.paperMode === true,
    }
  } catch {
    return DEFAULT_WORKBENCH_VIEW
  }
}

export function useWorkbenchViewPreferences(presetId: string) {
  const initial = loadPreference(presetId)
  const foldMode = ref<FoldMode>(initial.foldMode)
  const readerOpen = ref(initial.readerOpen)

  function saveWorkbenchViewPreference(): void {
    if (typeof localStorage === 'undefined') return
    try {
      localStorage.setItem(
        `${WORKBENCH_VIEW_STORAGE_PREFIX}${presetId}`,
        JSON.stringify({ foldMode: foldMode.value, readerOpen: readerOpen.value }),
      )
    } catch {
      // Storage may be unavailable in privacy mode; keep the in-memory selection usable.
    }
  }

  watch([foldMode, readerOpen], saveWorkbenchViewPreference)

  return { foldMode, readerOpen }
}
