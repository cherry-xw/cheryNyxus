export interface NyxusPointerPoint {
  x: number
  y: number
}

const MIN_DRIFT_RADIUS = 18
const MAX_DRIFT_RADIUS = 46
export const NYXUS_POINTER_MIN_SPEED = 0.8
export const NYXUS_POINTER_MAX_SPEED = 2
export const NYXUS_POINTER_ACCELERATION = 4
export const NYXUS_POINTER_DRIFT_MIN_MS = 8000
export const NYXUS_POINTER_DRIFT_MAX_MS = 16000

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
