import {
  parseWorkspaceLayout,
  serializeWorkspaceLayout,
  type WorkspaceLayoutSnapshot,
  type WorkspaceWindowState,
} from './windowModel'

const STORAGE_KEY = 'chery.workspace.cyber-layout.v1'

export function loadWorkspaceLayout(): WorkspaceLayoutSnapshot | undefined {
  if (typeof localStorage === 'undefined') return undefined
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return value ? parseWorkspaceLayout(JSON.parse(value)) : undefined
  } catch {
    return undefined
  }
}
export function saveWorkspaceLayout(
  windows: Readonly<Record<string, WorkspaceWindowState>>,
  order: readonly string[],
): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeWorkspaceLayout(windows, order)))
  } catch {
    // UI layout persistence is best-effort and must never block a user action.
  }
}
