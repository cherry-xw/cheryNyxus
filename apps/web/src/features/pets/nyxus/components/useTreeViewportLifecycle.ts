import { nextTick, onMounted, onBeforeUnmount, type Ref } from 'vue'

/** Viewport measurement, keyboard dismissal and paired GPU/detail cleanup. */
export function useTreeViewportLifecycle({
  pinnedDetailNodeId,
  pinnedCrtIds,
  closeNodeDetail,
  unpinCrt,
  viewportRef,
  viewportSize,
  tryInitialFit,
  mountGpuRenderer,
  resizeGpuRenderer,
  disposeGpuRenderer,
  cleanupDetail,
}: {
  pinnedDetailNodeId: Ref<string | undefined>
  pinnedCrtIds: Ref<Set<string>>
  closeNodeDetail: () => void
  unpinCrt: (id: string) => void
  viewportRef: Ref<HTMLElement | null>
  viewportSize: Ref<{ width: number; height: number }>
  tryInitialFit: () => void
  mountGpuRenderer: () => Promise<void>
  resizeGpuRenderer: (width: number, height: number) => void
  disposeGpuRenderer: () => void
  cleanupDetail: () => void
}) {
  function onEscape(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    if (pinnedDetailNodeId.value) closeNodeDetail()
    else {
      const latest = [...pinnedCrtIds.value].at(-1)
      if (latest) unpinCrt(latest)
    }
  }
  let viewportRO: ResizeObserver | undefined
  onMounted(() => {
    viewportRO = new ResizeObserver(() => {
      const width = viewportRef.value?.clientWidth ?? 0
      const height = viewportRef.value?.clientHeight ?? 0
      viewportSize.value = { width, height }
      // 与画布相机同步：resizeTo 对工作台瞬时全屏切换可能漏触发，导致 GPU 位图停留在旧高度、
      // 图底部被裁剪。这里显式重设渲染器尺寸，与 SVG 视口保持一致。
      resizeGpuRenderer(width, height)
    })
    if (viewportRef.value) viewportRO.observe(viewportRef.value)
    void nextTick(() => {
      tryInitialFit()
    })
    void mountGpuRenderer()
    window.addEventListener('keydown', onEscape)
  })
  onBeforeUnmount(() => {
    disposeGpuRenderer()
    viewportRO?.disconnect()
    cleanupDetail()
    window.removeEventListener('keydown', onEscape)
  })
}
