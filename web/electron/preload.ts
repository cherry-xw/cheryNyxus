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
 * desktop renderer → main 的控制台导航目标（与 main.ts 的 ConsoleTarget 保持一致）。
 * console surface 消费同一结构（经 `console:navigate` 下发）。
 */
export type ConsoleTarget =
  | { target: 'show' }
  | { target: 'settings' }
  | { target: 'workbench'; presetId: string; chatId?: string }
  | { target: 'history'; chatId: string }

const config = ipcRenderer.sendSync('get-backend-config') as BackendConfig | null

if (config) {
  contextBridge.exposeInMainWorld('__BACKEND_CONFIG__', config)
  contextBridge.exposeInMainWorld('__BACKEND_HTTP_URL__', `http://localhost:${config.webPort}`)
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
 * 桌面 shell bridge：desktop surface 消费（穿透控制 + 打开控制台），console surface
 * 消费 onConsoleNavigate / onConsoleMaximizeChanged / consoleWindowControl。业务数据不经 IPC——两个 surface 各自直连后端 WebSocket。
 */
const desktopBridge = {
  setMousePassthrough: (ignore: boolean) =>
    ipcRenderer.send('desktop:mouse-passthrough', ignore),
  openConsole: (target: ConsoleTarget) => ipcRenderer.send('desktop:open-console', target),
  onConsoleNavigate: (listener: (target: ConsoleTarget) => void) =>
    subscribe('console:navigate', listener),
  /** console 自绘标题栏 → 原生窗口控制（minimize/close = hide）。 */
  consoleWindowControl: (action: 'minimize' | 'maximize' | 'restore' | 'close') =>
    ipcRenderer.send('console:window-control', action),
  onConsoleMaximizeChanged: (listener: (maximized: boolean) => void) =>
    subscribe('console:maximize-changed', listener),
}

contextBridge.exposeInMainWorld('__DESKTOP_BRIDGE__', desktopBridge)
