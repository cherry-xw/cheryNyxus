import { onMounted, onUnmounted, reactive, ref } from 'vue'
import { fitWindow, type WindowGeometry } from './windowGeometry'
export function useWindowDrag() {
  const viewport = () => ({ width: window.innerWidth, height: window.innerHeight })
  const position = reactive(fitWindow({ x: 16, y: 16, width: 960, height: 740 }, viewport()))
  const maximized = ref(false)
  let previous: WindowGeometry | null = null
  let drag: { id: number; x: number; y: number; geometry: WindowGeometry; resize: boolean } | null = null
  function begin(event: PointerEvent, resize: boolean) {
    if (event.button !== 0 || maximized.value) return
    if (!resize && (event.target as HTMLElement).closest('button')) return
    const target = event.currentTarget as HTMLElement
    drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      geometry: { ...position },
      resize,
    }
    target.setPointerCapture(event.pointerId)
    event.preventDefault()
  }
  const start = (event: PointerEvent) => begin(event, false)
  const resizeStart = (event: PointerEvent) => begin(event, true)
  function move(event: PointerEvent) {
    if (!drag || drag.id !== event.pointerId) return
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y
    const next = drag.resize
      ? { ...drag.geometry, width: drag.geometry.width + dx, height: drag.geometry.height + dy }
      : { ...drag.geometry, x: drag.geometry.x + dx, y: drag.geometry.y + dy }
    if (drag.resize) {
      next.width = Math.min(next.width, window.innerWidth - next.x - 8)
      next.height = Math.min(next.height, window.innerHeight - next.y - 8)
    }
    Object.assign(position, fitWindow(next, viewport()))
  }
  function end(event: PointerEvent) {
    if (drag?.id === event.pointerId) drag = null
  }
  function toggleMaximize() {
    drag = null
    if (maximized.value && previous) Object.assign(position, fitWindow(previous, viewport()))
    else {
      previous = { ...position }
      Object.assign(position, fitWindow({ x: 8, y: 8, width: window.innerWidth, height: window.innerHeight }, viewport()))
    }
    maximized.value = !maximized.value
  }
  function resizeKey(event: KeyboardEvent) {
    const delta = event.shiftKey ? 40 : 10
    const changes: Record<string, [number, number]> = { ArrowLeft: [-delta, 0], ArrowRight: [delta, 0], ArrowUp: [0, -delta], ArrowDown: [0, delta] }
    const change = changes[event.key]
    if (!change || maximized.value) return
    event.preventDefault()
    Object.assign(position, fitWindow({ ...position,
      width: Math.min(position.width + change[0], window.innerWidth - position.x - 8),
      height: Math.min(position.height + change[1], window.innerHeight - position.y - 8),
    }, viewport()))
  }
  function fit() {
    drag = null
    Object.assign(position, fitWindow(maximized.value
      ? { x: 8, y: 8, width: window.innerWidth, height: window.innerHeight }
      : position, viewport()))
  }
  onMounted(() => window.addEventListener('resize', fit))
  onUnmounted(() => window.removeEventListener('resize', fit))
  return { position, maximized, start, resizeStart, move, end, resizeKey, toggleMaximize }
}
