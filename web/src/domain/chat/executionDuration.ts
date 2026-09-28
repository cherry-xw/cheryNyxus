/** Shared duration presentation; animations are applied only while still running. */
export function durationSeverity(elapsedMs: number, yellowAtMs: number, redAtMs: number): 'green' | 'yellow' | 'red' {
  if (elapsedMs < yellowAtMs) return 'green'
  if (elapsedMs < redAtMs) return 'yellow'
  return 'red'
}

export function durationColor(elapsedMs: number, yellowAtMs: number, redAtMs: number): string {
  const tone = durationSeverity(elapsedMs, yellowAtMs, redAtMs)
  if (tone === 'green') return '#22c55e'
  if (tone === 'yellow') return '#eab308'
  const progress = Math.min(1, Math.max(0, (elapsedMs - redAtMs) / (90 * 60_000)))
  // Keep the darkest state legible against the workbench's dark backgrounds.
  return `rgb(${Math.round(239 - 52 * progress)}, ${Math.round(68 - 29 * progress)}, ${Math.round(68 - 29 * progress)})`
}

export function readableDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  return hours ? `${hours}h${minutes}m${rest}s` : minutes ? `${minutes}m${rest}s` : `${rest}s`
}
