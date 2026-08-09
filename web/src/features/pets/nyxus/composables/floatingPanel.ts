import type { CanvasPoint, CanvasSize } from './useTreeCanvas'

export interface FloatingPanelRect extends CanvasSize {
  left: number
  top: number
}

/** Keeps a translated floating panel inside the viewport without changing its anchor. */
export function constrainFloatingOffset(
  offset: CanvasPoint,
  baseRect: FloatingPanelRect,
  viewport: CanvasSize,
  margin = 8,
): CanvasPoint {
  const minX = margin - baseRect.left
  const maxX = viewport.width - margin - baseRect.left - baseRect.width
  const minY = margin - baseRect.top
  const maxY = viewport.height - margin - baseRect.top - baseRect.height
  const clamp = (value: number, min: number, max: number): number =>
    max < min ? (min + max) / 2 : Math.min(max, Math.max(min, value))
  return {
    x: clamp(offset.x, minX, maxX),
    y: clamp(offset.y, minY, maxY),
  }
}
