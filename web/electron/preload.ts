import { contextBridge, ipcRenderer } from 'electron'

/**
 * preload 只暴露桌面容器能力；后端由独立管理器或用户连接目标提供，Electron 不启动或注入后端配置。
 */
/**
 * desktop renderer → main 的独立原生窗打开请求（与 main.ts 的 OpenWindowRequest 保持一致）。
 */
export type WindowKind = 'settings' | 'workbench' | 'terminal' | 'composer' | 'history' | 'login' | 'task-center'
export type SettingsSection = 'provider' | 'runtime' | 'limits'
export interface OpenWindowRequest {
  kind: WindowKind
  settingsSection?: SettingsSection
  presetId?: string
  chatId?: string
  /** 入口携带的预设名（workbench 窗空白态角色编制解析；经 main extraParams 拼 URL 供 App.vue 读）。 */
  presetName?: string
  source?: 'pet' | 'history' | 'nyxus'
  view?: 'composer' | 'attention' | 'tree'
  /** Hide the Pet composer until the workbench it opened is closed. */
  returnToComposer?: boolean
  focus?: { sourceChatId?: string; interactionId?: string; anchorNodeId?: string }
}

// 目录选择对话框（预设 workspace 字段用）。main 进程 dialog.showOpenDialog；canceled → null。
// 不依赖 backend config，独立注入（仅 Electron 模式有此 preload）。
contextBridge.exposeInMainWorld('__PICK_DIRECTORY__', () =>
  ipcRenderer.invoke('dialog:pickDirectory'),
)

function subscribe<T>(channel: string, listener: (data: T) => void): () => void {
  const wrapped = (_event: Electron.IpcRendererEvent, data: T) => listener(data)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

/**
 * 桌面 shell bridge：desktop surface 消费（穿透控制 + 打开独立原生窗），settings/workbench
 * surface 消费窗口控制 / 最大化回推 / focus / flashFrame / 主题同步。业务数据不经 IPC——
 * 每个 surface 各自直连后端 WebSocket。
 */
const desktopBridge = {
  setMousePassthrough: (ignore: boolean) => ipcRenderer.send('desktop:mouse-passthrough', ignore),
  openWindow: (req: OpenWindowRequest) => ipcRenderer.send('window:open', req),
  windowControl: (action: 'minimize' | 'maximize' | 'restore' | 'close') =>
    ipcRenderer.send('window:control', action),
  onWindowMaximized: (listener: (maximized: boolean) => void) =>
    subscribe('window:maximized', listener),
  onWindowFocused: (listener: (focused: boolean) => void) => subscribe('window:focused', listener),
  onWorkbenchFocus: (listener: (focus: OpenWindowRequest['focus']) => void) =>
    subscribe('workbench:focus', listener),
  onSettingsSection: (listener: (section: SettingsSection) => void) =>
    subscribe('settings:focus-section', listener),
  onOpenChat: (listener: (chatId: string) => void) => subscribe('workbench:open-chat', listener),
  onSurfaceRetarget: (
    listener: (target: {
      chatId: string
      source?: 'pet' | 'history' | 'nyxus'
      view?: 'composer' | 'attention' | 'tree'
    }) => void,
  ) => subscribe('surface:retarget', listener),
  flashFrame: (flag: boolean) => ipcRenderer.send('window:flash', flag),
  setBackgroundColor: (color: string) => ipcRenderer.send('window:set-background', color),
  emitThemeChanged: (theme: 'light' | 'dark') => ipcRenderer.send('theme:changed', theme),
  onThemeSet: (listener: (theme: 'light' | 'dark') => void) => subscribe('theme:set', listener),
  emitAuthChanged: (data?: unknown) => ipcRenderer.send('auth:changed', data),
  onAuthChanged: (listener: (data: unknown) => void) => subscribe('auth:changed', listener),
}

contextBridge.exposeInMainWorld('__DESKTOP_BRIDGE__', desktopBridge)
