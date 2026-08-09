export const EXECUTION_EDGE_PULSE_SPEED = 100
export const EXECUTION_EDGE_PULSE_INTERVAL = 2.4
export const EXECUTION_EDGE_PULSE_HEAD_LENGTH = 72
export const EXECUTION_EDGE_PULSE_TAIL_LENGTH = 48
export const EXECUTION_EDGE_PULSE_LENGTH =
  EXECUTION_EDGE_PULSE_HEAD_LENGTH + EXECUTION_EDGE_PULSE_TAIL_LENGTH
export const EXECUTION_EDGE_PULSE_PERIOD =
  EXECUTION_EDGE_PULSE_SPEED * EXECUTION_EDGE_PULSE_INTERVAL

/** Nested equal-width layers: bright for the first 72px, then fade across the final 48px. */
export const EXECUTION_EDGE_PULSE_SEGMENTS = [
  { name: 'tail-far', length: EXECUTION_EDGE_PULSE_LENGTH },
  { name: 'tail-mid', length: 108 },
  { name: 'tail-near', length: 96 },
  { name: 'tail-base', length: 84 },
  { name: 'head', length: EXECUTION_EDGE_PULSE_HEAD_LENGTH },
  { name: 'head-core', length: 40 },
  { name: 'head-tip', length: 8 },
] as const

export interface EdgePulseDashPattern {
  dash: number
  gap: number
  from: number
  to: number
}

export interface EdgePulseVisibleInterval {
  start: number
  end: number
}

/**
 * Clip one moving pulse layer to the edge without stopping its travel at the
 * destination. Once the head passes the end, the start keeps advancing so the
 * remaining tail is progressively consumed by the destination node.
 */
export function edgePulseVisibleInterval(
  edgeLength: number,
  head: number,
  segmentLength: number,
): EdgePulseVisibleInterval | undefined {
  const end = Math.min(edgeLength, head)
  const start = Math.max(0, head - segmentLength)
  return end > 0 && start < end ? { start, end } : undefined
}

/**
 * Every layer shares the same fixed 240px pattern and 2.4s cycle. The pattern
 * repeats independently of path length, so long edges can contain several pulses.
 */
export function edgePulseDashPattern(segmentLength: number): EdgePulseDashPattern {
  const dash = Math.max(0, Math.min(EXECUTION_EDGE_PULSE_LENGTH, segmentLength))
  return {
    dash,
    gap: EXECUTION_EDGE_PULSE_PERIOD - dash,
    from: dash,
    to: dash - EXECUTION_EDGE_PULSE_PERIOD,
  }
}
