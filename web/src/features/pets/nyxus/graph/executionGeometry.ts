import type { CanvasPoint } from '../composables/useTreeCanvas'

export interface ExecutionEdgeGeometry {
  from: CanvasPoint
  to: CanvasPoint
  control1: CanvasPoint
  control2: CanvasPoint
  path: string
  /** Optional renderer-ready polyline samples for rounded orthogonal Signal routes. */
  samples?: CanvasPoint[]
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

function quadraticPoint(
  from: CanvasPoint,
  control: CanvasPoint,
  to: CanvasPoint,
  t: number,
): CanvasPoint {
  const inverse = 1 - t
  return {
    x: inverse * inverse * from.x + 2 * inverse * t * control.x + t * t * to.x,
    y: inverse * inverse * from.y + 2 * inverse * t * control.y + t * t * to.y,
  }
}

function appendQuadraticSamples(
  samples: CanvasPoint[],
  from: CanvasPoint,
  control: CanvasPoint,
  to: CanvasPoint,
): void {
  for (let step = 1; step <= 4; step += 1) {
    samples.push(quadraticPoint(from, control, to, step / 4))
  }
}

/** Rounded, orthogonal left-to-right edge used by Signal Grid. */
export function horizontalExecutionEdgeGeometry(
  source: CanvasPoint,
  target: CanvasPoint,
  sourceHalfWidth: number,
  routeX?: number,
  targetHalfWidth = sourceHalfWidth,
): ExecutionEdgeGeometry {
  const direction = target.x >= source.x ? 1 : -1
  const from = { x: source.x + sourceHalfWidth * direction, y: source.y }
  const to = { x: target.x - targetHalfWidth * direction, y: target.y }
  const horizontalSpan = Math.abs(to.x - from.x)
  const controlX = Math.max(
    Math.min(routeX ?? (from.x + to.x) / 2, Math.max(from.x, to.x) - 1),
    Math.min(from.x, to.x) + 1,
  )
  const control1 = { x: controlX, y: from.y }
  const control2 = { x: controlX, y: to.y }

  if (Math.abs(to.y - from.y) < 0.001 || horizontalSpan < 4) {
    return {
      from,
      to,
      control1,
      control2,
      path: `M ${from.x} ${from.y} L ${to.x} ${to.y}`,
      samples: [from, to],
    }
  }

  const verticalDirection = Math.sign(to.y - from.y)
  const radius = Math.min(
    8,
    Math.abs(to.y - from.y) / 2,
    Math.abs(controlX - from.x),
    Math.abs(to.x - controlX),
  )
  const firstLineEnd = { x: controlX - radius * direction, y: from.y }
  const firstCurveEnd = { x: controlX, y: from.y + radius * verticalDirection }
  const secondLineEnd = { x: controlX, y: to.y - radius * verticalDirection }
  const secondCurveEnd = { x: controlX + radius * direction, y: to.y }
  const samples: CanvasPoint[] = [from, firstLineEnd]
  appendQuadraticSamples(samples, firstLineEnd, control1, firstCurveEnd)
  samples.push(secondLineEnd)
  appendQuadraticSamples(samples, secondLineEnd, control2, secondCurveEnd)
  samples.push(to)
  return {
    from,
    to,
    control1,
    control2,
    path: `M ${from.x} ${from.y} H ${firstLineEnd.x} Q ${control1.x} ${control1.y} ${firstCurveEnd.x} ${firstCurveEnd.y} V ${secondLineEnd.y} Q ${control2.x} ${control2.y} ${secondCurveEnd.x} ${secondCurveEnd.y} H ${to.x}`,
    samples,
  }
}
