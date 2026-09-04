export type WorkspaceWindowKind =
  | 'session'
  | 'graph'
  | 'attention'
  | 'history'
  | 'settings'
  | 'diagnostic'

export type WorkspaceWindowLifecycle =
  | 'opening'
  | 'open'
  | 'minimizing'
  | 'minimized'
  | 'closing'

export type DiagnosticSeverity = 'error' | 'warning' | 'diagnostic'

export type WorkspaceWindowContext =
  | { kind: 'session'; chatId: string; presetId?: string }
  | { kind: 'graph'; presetId: string; chatId?: string }
  | { kind: 'attention'; presetId?: string }
  | { kind: 'history'; rootChatId: string }
  | { kind: 'settings'; section?: string }
  | {
      kind: 'diagnostic'
      severity: DiagnosticSeverity
      source: string
      message: string
      code?: string
      chatId?: string
      transient?: boolean
    }

export interface WorkspaceWindowGeometry {
  x: number
  y: number
  width: number
  height: number
}

export interface WorkspaceWindowState {
  id: string
  resourceKey: string
  kind: WorkspaceWindowKind
  lifecycle: WorkspaceWindowLifecycle
  title: string
  geometry: WorkspaceWindowGeometry
  restoreGeometry?: WorkspaceWindowGeometry
  zOrder: number
  /** 创建序（任务栏展示序）：单调递增、创建后不变，与 z 序（zOrder）分离——聚焦窗口只改 z 序，不改任务栏排列。 */
  sequence: number
  focused: boolean
  maximized: boolean
  attention: boolean
  persistent: boolean
  context: WorkspaceWindowContext
}

export interface OpenWorkspaceWindowInput {
  resourceKey: string
  title: string
  context: WorkspaceWindowContext
  geometry?: Partial<WorkspaceWindowGeometry>
  persistent?: boolean
  attention?: boolean
}

export interface WorkspaceLayoutSnapshot {
  version: 1
  order: string[]
  windows: WorkspaceWindowState[]
}

export interface WorkspaceStageSize {
  width: number
  height: number
}

const DEFAULT_WIDTH = 760
const DEFAULT_HEIGHT = 620
const CASCADE_STEP = 28
const SAFE_MARGIN = 12
const TITLEBAR_VISIBLE_HEIGHT = 36

export function workspaceWindowId(resourceKey: string): string {
  return `window:${resourceKey}`
}

export function clampWorkspaceGeometry(
  geometry: WorkspaceWindowGeometry,
  viewport: WorkspaceStageSize = { width: 1920, height: 1080 },
): WorkspaceWindowGeometry {
  const width = Math.max(360, Math.min(geometry.width, Math.max(360, viewport.width - SAFE_MARGIN * 2)))
  const height = Math.max(260, Math.min(geometry.height, Math.max(260, viewport.height - SAFE_MARGIN * 2)))
  return {
    width,
    height,
    x: Math.max(SAFE_MARGIN - width + TITLEBAR_VISIBLE_HEIGHT, Math.min(geometry.x, viewport.width - TITLEBAR_VISIBLE_HEIGHT)),
    y: Math.max(SAFE_MARGIN, Math.min(geometry.y, viewport.height - TITLEBAR_VISIBLE_HEIGHT)),
  }
}

export function maximizedWorkspaceGeometry(stage: WorkspaceStageSize): WorkspaceWindowGeometry {
  return {
    x: 0,
    y: 0,
    width: Math.max(360, stage.width),
    height: Math.max(260, stage.height),
  }
}

export function createWorkspaceWindow(
  input: OpenWorkspaceWindowInput,
  index: number,
  viewport: WorkspaceStageSize = { width: 1920, height: 1080 },
  sequence: number = index,
): WorkspaceWindowState {
  const offset = (index % 9) * CASCADE_STEP
  const geometry = clampWorkspaceGeometry(
    {
      x: 96 + offset,
      y: 72 + offset,
      width: input.geometry?.width ?? DEFAULT_WIDTH,
      height: input.geometry?.height ?? DEFAULT_HEIGHT,
      ...input.geometry,
    },
    viewport,
  )
  return {
    id: workspaceWindowId(input.resourceKey),
    resourceKey: input.resourceKey,
    kind: input.context.kind,
    lifecycle: 'opening',
    title: input.title,
    geometry,
    zOrder: index,
    sequence,
    focused: true,
    maximized: false,
    attention: input.attention ?? false,
    persistent: input.persistent ?? input.context.kind !== 'diagnostic',
    context: input.context,
  }
}

export function serializeWorkspaceLayout(
  windows: Readonly<Record<string, WorkspaceWindowState>>,
  order: readonly string[],
): WorkspaceLayoutSnapshot {
  const persistentWindows: WorkspaceWindowState[] = order
    .map((id) => windows[id])
    .filter((window): window is WorkspaceWindowState => !!window?.persistent)
    .map((window, index): WorkspaceWindowState => ({
      ...window,
      lifecycle: window.lifecycle === 'minimized' ? 'minimized' : 'open',
      focused: false,
      attention: false,
      zOrder: index,
    }))
  return { version: 1, order: persistentWindows.map((window) => window.id), windows: persistentWindows }
}

export function parseWorkspaceLayout(value: unknown): WorkspaceLayoutSnapshot | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Partial<WorkspaceLayoutSnapshot>
  if (candidate.version !== 1 || !Array.isArray(candidate.windows) || !Array.isArray(candidate.order)) {
    return undefined
  }
  const windows = candidate.windows.filter(isWorkspaceWindowState)
  const ids = new Set(windows.map((window) => window.id))
  return {
    version: 1,
    windows,
    order: candidate.order.filter((id): id is string => typeof id === 'string' && ids.has(id)),
  }
}

function isWorkspaceWindowState(value: unknown): value is WorkspaceWindowState {
  if (!value || typeof value !== 'object') return false
  const window = value as Partial<WorkspaceWindowState>
  const context = window.context as Partial<WorkspaceWindowContext> | undefined
  return (
    typeof window.id === 'string' &&
    typeof window.resourceKey === 'string' &&
    typeof window.title === 'string' &&
    typeof context?.kind === 'string' &&
    !!window.geometry &&
    Number.isFinite(window.geometry.x) &&
    Number.isFinite(window.geometry.y) &&
    Number.isFinite(window.geometry.width) &&
    Number.isFinite(window.geometry.height) &&
    window.persistent === true &&
    (window.maximized === undefined || typeof window.maximized === 'boolean') &&
    isOptionalGeometry(window.restoreGeometry)
  )
}

function isOptionalGeometry(value: unknown): boolean {
  if (value === undefined) return true
  if (!value || typeof value !== 'object') return false
  const geometry = value as Partial<WorkspaceWindowGeometry>
  return (
    Number.isFinite(geometry.x) &&
    Number.isFinite(geometry.y) &&
    Number.isFinite(geometry.width) &&
    Number.isFinite(geometry.height)
  )
}
