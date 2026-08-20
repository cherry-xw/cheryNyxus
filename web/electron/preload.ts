import { contextBridge, ipcRenderer } from 'electron'

/**
 * preload：同步从 main 进程取后端端口配置，注入渲染进程 window.__BACKEND_CONFIG__。
 * 渲染进程据此构建 ws:// 连接地址，无需 fetch /api/config（file:// 下无法 fetch 相对地址）。
 *
 * main 在 createWindow 前已 waitForBackend，配置就绪，sendSync 立即返回。
 *
 * P5c：同时注入 __BACKEND_HTTP_URL__（http://localhost:<webPort>），前端 fetch /api/* 用
 * （httpUrl helper，Electron 模式下 file:// origin==="null" 相对路径不可用）。
 *
 * 仅注入后端连接配置；业务能力统一通过 WebSocket RPC 调用后端。
 */
interface BackendConfig {
  wsPort: number
  webPort: number
  transport: 'binary' | 'json'
}

/**
 * desktop renderer → main 的独立原生窗打开请求（与 main.ts 的 OpenWindowRequest 保持一致）。
 */
export type WindowKind = 'settings' | 'workbench' | 'composer' | 'history' | 'login'
export interface OpenWindowRequest {
  kind: WindowKind
  presetId?: string
  chatId?: string
  source?: 'pet' | 'history' | 'nyxus'
  view?: 'composer' | 'attention' | 'tree'
  /** Hide the Pet composer until the workbench it opened is closed. */
  returnToComposer?: boolean
  focus?: { sourceChatId?: string; interactionId?: string; anchorNodeId?: string }
}

const config = ipcRenderer.sendSync('get-backend-config') as BackendConfig | null

if (config) {
  contextBridge.exposeInMainWorld('__BACKEND_CONFIG__', config)
  contextBridge.exposeInMainWorld('__BACKEND_HTTP_URL__', `http://localhost:${config.webPort}`)
}

// 刷新后端配置（invoke → main 进程 fetch /api/config，返回含最新 sessionToken 的完整配置）。
// 渲染进程不能直接 fetch /api/config：后端响应无 CORS 头，Chromium 拦截跨源请求；
// main 进程 Node 全局 fetch 无此限制。worker 重启轮换 sessionToken 后，重连必须先经此刷新。
contextBridge.exposeInMainWorld('__REFRESH_BACKEND_CONFIG__', () =>
  ipcRenderer.invoke('backend:refresh-config'),
)

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
  setMousePassthrough: (ignore: boolean) =>
    ipcRenderer.send('desktop:mouse-passthrough', ignore),
  openWindow: (req: OpenWindowRequest) => ipcRenderer.send('window:open', req),
  windowControl: (action: 'minimize' | 'maximize' | 'restore' | 'close') =>
    ipcRenderer.send('window:control', action),
  onWindowMaximized: (listener: (maximized: boolean) => void) =>
    subscribe('window:maximized', listener),
  onWindowFocused: (listener: (focused: boolean) => void) =>
    subscribe('window:focused', listener),
  onWorkbenchFocus: (listener: (focus: OpenWindowRequest['focus']) => void) =>
    subscribe('workbench:focus', listener),
  onOpenChat: (listener: (chatId: string) => void) => subscribe('workbench:open-chat', listener),
  onSurfaceRetarget: (listener: (target: { chatId: string; source?: 'pet' | 'history' | 'nyxus'; view?: 'composer' | 'attention' | 'tree' }) => void) =>
    subscribe('surface:retarget', listener),
  flashFrame: (flag: boolean) => ipcRenderer.send('window:flash', flag),
  setBackgroundColor: (color: string) => ipcRenderer.send('window:set-background', color),
  emitThemeChanged: (theme: 'light' | 'dark') => ipcRenderer.send('theme:changed', theme),
  onThemeSet: (listener: (theme: 'light' | 'dark') => void) => subscribe('theme:set', listener),
  emitAuthChanged: (data?: unknown) => ipcRenderer.send('auth:changed', data),
  onAuthChanged: (listener: (data: unknown) => void) => subscribe('auth:changed', listener),
}

contextBridge.exposeInMainWorld('__DESKTOP_BRIDGE__', desktopBridge)
