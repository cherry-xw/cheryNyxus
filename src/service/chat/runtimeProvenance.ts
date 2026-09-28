import type { RuntimeSelection } from '@/agent/runtimeResolver.js'

/** Attribute assistant output to its preceding user selection without losing each projection's legacy reset rule. */
export function projectMessageRuntime(
  role: string,
  runtime: RuntimeSelection | undefined,
  previous: RuntimeSelection | undefined,
  clearOnMissingUserRuntime = false,
): { current: RuntimeSelection | undefined; next: RuntimeSelection | undefined } {
  if (role === 'user') {
    return {
      current: runtime,
      next: runtime !== undefined || clearOnMissingUserRuntime ? runtime : previous,
    }
  }
  return { current: role === 'assistant' ? previous : undefined, next: previous }
}
