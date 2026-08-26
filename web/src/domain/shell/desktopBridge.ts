export type WindowKind = 'settings' | 'workbench' | 'composer' | 'history' | 'login'

export interface OpenWindowRequest {
  kind: WindowKind
  presetId?: string
  chatId?: string
  presetName?: string
  source?: 'pet' | 'history' | 'nyxus'
  view?: 'composer' | 'attention' | 'tree'
  returnToComposer?: boolean
  focus?: { sourceChatId?: string; interactionId?: string; anchorNodeId?: string }
}

/** Pure IPC contract shared by the preload declaration and desktop feature adapter. */
export interface DesktopBridge {
  setMousePassthrough(ignore: boolean): void
  openWindow(request: OpenWindowRequest): void
  windowControl(action: 'minimize' | 'maximize' | 'restore' | 'close'): void
  onWindowMaximized(listener: (maximized: boolean) => void): () => void
  onWindowFocused(listener: (focused: boolean) => void): () => void
  onWorkbenchFocus(listener: (focus: OpenWindowRequest['focus']) => void): () => void
  onOpenChat(listener: (chatId: string) => void): () => void
  onSurfaceRetarget(
    listener: (target: {
      chatId: string
      source?: 'pet' | 'history' | 'nyxus'
      view?: 'composer' | 'attention' | 'tree'
    }) => void,
  ): () => void
  flashFrame(flag: boolean): void
  setBackgroundColor(color: string): void
  emitThemeChanged(theme: 'light' | 'dark'): void
  onThemeSet(listener: (theme: 'light' | 'dark') => void): () => void
  emitAuthChanged(data?: unknown): void
  onAuthChanged(listener: (data: unknown) => void): () => void
}
