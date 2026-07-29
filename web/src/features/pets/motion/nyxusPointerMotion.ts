export interface NyxusPointerPoint {
  x: number
  y: number
}

export interface NyxusAvoidanceObstacle {
  x: number
  y: number
  width: number
  height: number
}

const MIN_DRIFT_RADIUS = 18
const MAX_DRIFT_RADIUS = 46
export const NYXUS_POINTER_MIN_SPEED = 6
export const NYXUS_POINTER_MAX_SPEED = 11
export const NYXUS_POINTER_ACCELERATION = 4
export const NYXUS_POINTER_DRIFT_MIN_MS = 8000
export const NYXUS_POINTER_DRIFT_MAX_MS = 16000
export const NYXUS_POINTER_TRAVEL_MIN_MS = 8000
export const NYXUS_POINTER_TRAVEL_MAX_MS = 14000
export const NYXUS_AVOIDANCE_DISTANCE = 190

export function createNyxusPointerDrift(random: () => number = Math.random): NyxusPointerPoint {
  const angle = random() * Math.PI * 2
  const radius = MIN_DRIFT_RADIUS + random() * (MAX_DRIFT_RADIUS - MIN_DRIFT_RADIUS)
  return {
    x: Math.cos(angle) * radius,
    y: Math.sin(angle) * radius,
  }
}

export function nyxusPointerTarget(
  pointer: NyxusPointerPoint,
  drift: NyxusPointerPoint,
): NyxusPointerPoint {
  return {
    x: pointer.x + drift.x,
    y: pointer.y + drift.y,
  }
}

/**
 * 让 Nyxus 的中心保持在普通 Pet 可见范围之外。返回值是避让航段的目标点；
 * 未侵入安全半径时返回 undefined，调用方可以保持静止。
 */
export function nyxusAvoidanceTarget(
  point: NyxusPointerPoint,
  obstacles: readonly NyxusAvoidanceObstacle[],
  safeDistance = NYXUS_AVOIDANCE_DISTANCE,
): NyxusPointerPoint | undefined {
  let nearest: { x: number; y: number; distance: number } | undefined
  for (const obstacle of obstacles) {
    const x = obstacle.x + obstacle.width / 2
    const y = obstacle.y + obstacle.height / 2
    const distance = Math.hypot(point.x - x, point.y - y)
    if (!nearest || distance < nearest.distance) nearest = { x, y, distance }
  }
  if (!nearest || nearest.distance >= safeDistance) return undefined

  const fallbackAngle = ((nearest.x * 0.173 + nearest.y * 0.117) % 1) * Math.PI * 2
  const ux = nearest.distance > 0.001 ? (point.x - nearest.x) / nearest.distance : Math.cos(fallbackAngle)
  const uy = nearest.distance > 0.001 ? (point.y - nearest.y) / nearest.distance : Math.sin(fallbackAngle)
  return {
    x: nearest.x + ux * safeDistance,
    y: nearest.y + uy * safeDistance,
  }
}
