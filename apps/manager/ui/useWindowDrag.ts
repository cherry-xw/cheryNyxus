import { reactive } from 'vue'
export function useWindowDrag() {
  const position = reactive({ x: 16, y: 16 })
  let drag: { id: number; x: number; y: number; left: number; top: number } | null = null
  function start(event: PointerEvent) {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return
    const target = event.currentTarget as HTMLElement
    drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: position.x,
      top: position.y,
    }
    target.setPointerCapture(event.pointerId)
    event.preventDefault()
  }
  function move(event: PointerEvent) {
    if (!drag || drag.id !== event.pointerId) return
    const window = (event.currentTarget as HTMLElement).parentElement!
    const host = window.parentElement!
    position.x = Math.max(
      0,
      Math.min(host.clientWidth - window.offsetWidth, drag.left + event.clientX - drag.x),
    )
    position.y = Math.max(
      0,
      Math.min(host.clientHeight - window.offsetHeight, drag.top + event.clientY - drag.y),
    )
  }
  function end(event: PointerEvent) {
    if (drag?.id === event.pointerId) drag = null
  }
  return { position, start, move, end }
}
