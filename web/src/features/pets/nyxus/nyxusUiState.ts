import { ref, shallowRef } from 'vue'

export type NyxusMenuTool = 'create' | 'chat' | 'history' | 'settings'

export interface NyxusMenuTarget {
  id: NyxusMenuTool
  x: number
  y: number
}

export const nyxusMenuOpen = ref(false)
export const nyxusMenuTargets = shallowRef<NyxusMenuTarget[]>([])
export const nyxusHighlightedTool = ref<NyxusMenuTool | null>(null)

export function setNyxusMenuTargets(targets: NyxusMenuTarget[]): void {
  nyxusMenuTargets.value = targets
}

export function highlightNyxusTool(tool: NyxusMenuTool | null): void {
  nyxusHighlightedTool.value = tool
}

export function toggleNyxusMenu(): void {
  nyxusMenuOpen.value = !nyxusMenuOpen.value
}

export function closeNyxusMenu(): void {
  nyxusMenuOpen.value = false
  nyxusMenuTargets.value = []
  nyxusHighlightedTool.value = null
}
