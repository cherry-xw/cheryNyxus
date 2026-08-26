import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
  type ComputedRef,
  type Ref,
} from 'vue'

export type WorkbenchMode = 'fullscreen' | 'window'
export type ResizeDirection = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw'

export interface WorkbenchPoint {
  x: number
  y: number
}

export interface WorkbenchSize {
  width: number
  height: number
}

interface PersistedWorkbenchLayout extends WorkbenchPoint {
  mode: WorkbenchMode
}

const STORAGE_KEY_PREFIX = 'cherynyxus:workbench-layout'
const VIEWPORT_GAP = 16
const MIN_WIDTH = 720
const MIN_HEIGHT = 480

function storageKey(windowId: string): string {
  return `${STORAGE_KEY_PREFIX}:${windowId}:v1`
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function defaultWorkbenchSize(viewportWidth: number, viewportHeight: number): WorkbenchSize {
  const availableWidth = Math.max(320, viewportWidth - VIEWPORT_GAP * 2)
  const availableHeight = Math.max(280, viewportHeight - VIEWPORT_GAP * 2)
  return {
    width: Math.min(availableWidth, Math.max(Math.min(MIN_WIDTH, availableWidth), viewportWidth * 0.82), 1440),
    height: Math.min(availableHeight, Math.max(Math.min(MIN_HEIGHT, availableHeight), viewportHeight * 0.82), 960),
  }
}

export function clampWorkbenchGeometry(
  position: WorkbenchPoint,
  size: WorkbenchSize,
  viewportWidth: number,
  viewportHeight: number,
): { position: WorkbenchPoint; size: WorkbenchSize } {
  const maxWidth = Math.max(320, viewportWidth - VIEWPORT_GAP * 2)
  const maxHeight = Math.max(280, viewportHeight - VIEWPORT_GAP * 2)
  const nextSize = {
    width: Math.min(maxWidth, Math.max(Math.min(MIN_WIDTH, maxWidth), size.width)),
    height: Math.min(maxHeight, Math.max(Math.min(MIN_HEIGHT, maxHeight), size.height)),
  }
  return {
    size: nextSize,
    position: {
      x: Math.min(
        Math.max(VIEWPORT_GAP, position.x),
        Math.max(VIEWPORT_GAP, viewportWidth - nextSize.width - VIEWPORT_GAP),
      ),
      y: Math.min(
        Math.max(VIEWPORT_GAP, position.y),
        Math.max(VIEWPORT_GAP, viewportHeight - nextSize.height - VIEWPORT_GAP),
      ),
    },
  }
}

function readLayout(windowId: string): PersistedWorkbenchLayout | undefined {
  if (typeof localStorage === 'undefined') return undefined
  try {
    const value = JSON.parse(localStorage.getItem(storageKey(windowId)) ?? 'null') as Partial<PersistedWorkbenchLayout> | null
    if (!value || (value.mode !== 'fullscreen' && value.mode !== 'window')) return undefined
    if (!finite(value.x) || !finite(value.y)) return undefined
    return { mode: value.mode, x: value.x, y: value.y }
  } catch {
    return undefined
  }
}

function writeLayout(windowId: string, layout: PersistedWorkbenchLayout): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(storageKey(windowId), JSON.stringify(layout))
  } catch (cause) {
    console.warn('[useWorkbenchWindow] 保存工作台布局失败:', cause)
  }
}

export interface WorkbenchInitialGeometry {
  mode: WorkbenchMode
  position: WorkbenchPoint
  size: WorkbenchSize
}

export function useWorkbenchWindow(options: {
  windowId?: string
  initialGeometry?: WorkbenchInitialGeometry
} = {}): {
  shellRef: Ref<HTMLElement | null>
  mode: Ref<WorkbenchMode>
  position: Ref<WorkbenchPoint>
  size: Ref<WorkbenchSize>
  shellStyle: ComputedRef<Record<string, string>>
  setMode: (mode: WorkbenchMode) => void
  toggleMode: () => void
  resetForOpen: () => void
  onTitlePointerDown: (event: PointerEvent) => void
  onResizePointerDown: (direction: ResizeDirection, event: PointerEvent) => void
} {
  const windowId = options.windowId ?? 'default'
  const persisted = readLayout(windowId)
  const initialSize = defaultWorkbenchSize(window.innerWidth, window.innerHeight)
  const centered = {
    x: (window.innerWidth - initialSize.width) / 2,
    y: (window.innerHeight - initialSize.height) / 2,
  }
  const initial = ((): { position: WorkbenchPoint; size: WorkbenchSize } => {
    if (options.initialGeometry) {
      return clampWorkbenchGeometry(
        options.initialGeometry.position,
        options.initialGeometry.size,
        window.innerWidth,
        window.innerHeight,
      )
    }
    return clampWorkbenchGeometry(
      persisted ? { x: persisted.x, y: persisted.y } : centered,
      initialSize,
      window.innerWidth,
      window.innerHeight,
    )
  })()

  const shellRef = ref<HTMLElement | null>(null)
  const mode = ref<WorkbenchMode>(options.initialGeometry ? options.initialGeometry.mode : (persisted?.mode ?? 'fullscreen'))
  const position = ref(initial.position)
  const size = ref(initial.size)

  const shellStyle = computed<Record<string, string>>(() =>
    mode.value === 'fullscreen'
      ? ({} as Record<string, string>)
      : {
          left: `${position.value.x}px`,
          top: `${position.value.y}px`,
          width: `${size.value.width}px`,
          height: `${size.value.height}px`,
        },
  )

  function persist(): void {
    writeLayout(windowId, { mode: mode.value, ...position.value })
  }

  function normalize(): void {
    const next = clampWorkbenchGeometry(
      position.value,
      size.value,
      window.innerWidth,
      window.innerHeight,
    )
    position.value = next.position
    size.value = next.size
  }

  function setMode(nextMode: WorkbenchMode): void {
    if (mode.value === nextMode) return
    mode.value = nextMode
    if (nextMode === 'window') normalize()
    persist()
  }

  function toggleMode(): void {
    setMode(mode.value === 'fullscreen' ? 'window' : 'fullscreen')
  }

  function resetForOpen(): void {
    size.value = defaultWorkbenchSize(window.innerWidth, window.innerHeight)
    normalize()
  }

  let cleanupPointerInteraction: (() => void) | undefined

  function beginPointerInteraction(
    event: PointerEvent,
    cursor: string,
    onMove: (moveEvent: PointerEvent) => void,
    onEnd?: () => void,
  ): void {
    cleanupPointerInteraction?.()
    const target = event.currentTarget as HTMLElement
    target.setPointerCapture?.(event.pointerId)
    document.body.style.userSelect = 'none'
    document.body.style.cursor = cursor
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId === event.pointerId) onMove(moveEvent)
    }
    const end = (endEvent: PointerEvent) => {
      if (endEvent.pointerId !== event.pointerId) return
      cleanupPointerInteraction?.()
      onEnd?.()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    cleanupPointerInteraction = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      target.releasePointerCapture?.(event.pointerId)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      cleanupPointerInteraction = undefined
    }
  }

  function onTitlePointerDown(event: PointerEvent): void {
    if (mode.value !== 'window' || event.button !== 0) return
    if ((event.target as Element | null)?.closest('button')) return
    event.preventDefault()
    const start = { ...position.value }
    const startPointer = { x: event.clientX, y: event.clientY }
    beginPointerInteraction(
      event,
      'grabbing',
      (moveEvent) => {
        position.value = clampWorkbenchGeometry(
          {
            x: start.x + moveEvent.clientX - startPointer.x,
            y: start.y + moveEvent.clientY - startPointer.y,
          },
          size.value,
          window.innerWidth,
          window.innerHeight,
        ).position
      },
      persist,
    )
  }

  function onResizePointerDown(direction: ResizeDirection, event: PointerEvent): void {
    if (mode.value !== 'window' || event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const startPosition = { ...position.value }
    const startSize = { ...size.value }
    const startPointer = { x: event.clientX, y: event.clientY }
    const cursor = `${direction}-resize`
    beginPointerInteraction(
      event,
      cursor,
      (moveEvent) => {
        const dx = moveEvent.clientX - startPointer.x
        const dy = moveEvent.clientY - startPointer.y
        let x = startPosition.x
        let y = startPosition.y
        let width = startSize.width
        let height = startSize.height
        if (direction.includes('e')) width += dx
        if (direction.includes('s')) height += dy
        if (direction.includes('w')) {
          width -= dx
          x += dx
        }
        if (direction.includes('n')) {
          height -= dy
          y += dy
        }
        const next = clampWorkbenchGeometry(
          { x, y },
          { width, height },
          window.innerWidth,
          window.innerHeight,
        )
        if (direction.includes('w') && next.size.width !== width) {
          next.position.x = startPosition.x + startSize.width - next.size.width
        }
        if (direction.includes('n') && next.size.height !== height) {
          next.position.y = startPosition.y + startSize.height - next.size.height
        }
        position.value = next.position
        size.value = next.size
      },
      persist,
    )
  }

  function onViewportResize(): void {
    normalize()
    if (mode.value === 'window') persist()
  }

  onMounted(() => window.addEventListener('resize', onViewportResize))
  onBeforeUnmount(() => {
    window.removeEventListener('resize', onViewportResize)
    cleanupPointerInteraction?.()
  })

  return {
    shellRef,
    mode,
    position,
    size,
    shellStyle,
    setMode,
    toggleMode,
    resetForOpen,
    onTitlePointerDown,
    onResizePointerDown,
  }
}
