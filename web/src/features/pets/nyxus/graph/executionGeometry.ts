import type { CanvasPoint } from '../composables/useTreeCanvas'

export interface ExecutionEdgeGeometry {
  from: CanvasPoint
  to: CanvasPoint
  control1: CanvasPoint
  control2: CanvasPoint
  path: string
}

/**
 * Builds a top-to-bottom cubic edge whose endpoints touch the icon circles.
 * Vertical tangents keep the curve outside both icons; lateral span gently
 * increases the bend without allowing the controls to pass their midpoint.
 */
export function executionEdgeGeometry(
  source: CanvasPoint,
  target: CanvasPoint,
  iconRadius: number,
  routeX?: number,
): ExecutionEdgeGeometry {
  const direction = target.y >= source.y ? 1 : -1
  const from = { x: source.x, y: source.y + iconRadius * direction }
  const to = { x: target.x, y: target.y - iconRadius * direction }
  const verticalSpan = Math.abs(to.y - from.y)
  const lateralSpan = Math.abs(to.x - from.x)
  const bend = Math.min(
    verticalSpan / 2,
    Math.max(iconRadius * 1.5, verticalSpan * 0.38 + lateralSpan * 0.12),
  )
  const control1 = {
    x: routeX ?? from.x,
    y: from.y + bend * direction,
  }
  const control2 = {
    x: routeX ?? to.x,
    y: to.y - bend * direction,
  }
  return {
    from,
    to,
    control1,
    control2,
    path: `M ${from.x} ${from.y} C ${control1.x} ${control1.y}, ${control2.x} ${control2.y}, ${to.x} ${to.y}`,
  }
}
