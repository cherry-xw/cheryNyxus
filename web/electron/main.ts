import { join, dirname } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { app, BrowserWindow, ipcMain, dialog, Menu, Tray, nativeImage, screen } from 'electron'

/**
 * desktop renderer → main 请求打开控制台的导航目标。
 * main 确保 console 窗可见（惰性创建 + ready 队列）后经 `console:navigate` 转发给 console renderer。
 */
export type ConsoleTarget =
  | { target: 'show' }
  | { target: 'settings' }
  | { target: 'workbench'; presetId: string; chatId?: string }
  | { target: 'history'; chatId: string }

/** IPC 载荷防御校验：desktop:open-console 的 target 结构不合法时静默丢弃。 */
function isValidConsoleTarget(value: unknown): value is ConsoleTarget {
  if (!value || typeof value !== 'object') return false
  const target = value as Partial<ConsoleTarget>
  if (target.target === 'show' || target.target === 'settings') return true
  if (target.target === 'workbench') {
    return typeof target.presetId === 'string' && (target.chatId === undefined || typeof target.chatId === 'string')
  }
  if (target.target === 'history') {
    return typeof (target as { chatId?: unknown }).chatId === 'string'
  }
  return false
}

const WS_PORT = Number(process.env.WS_PORT ?? 8182)
const WEB_PORT = Number(process.env.WEB_PORT ?? 8183)

let backend: ChildProcess | null = null
let desktopWindow: BrowserWindow | null = null
let consoleWindow: BrowserWindow | null = null
let tray: Tray | null = null
/** console 窗 did-finish-load 后置位；未就绪期间的 navigate 请求入队，就绪后补发。 */
let consoleReady = false
let pendingConsoleTargets: ConsoleTarget[] = []
let isQuitting = false
let serverConfig: { wsPort: number; webPort: number; transport: string } | null = null
/** `getRuntimeRoot()` 解析结果缓存（启动后固定）。 */
let runtimeRoot: string | null = null

/**
 * 后端 bundle 路径：
 * - 开发期（electron .）：app.getAppPath() = web/，../dist = <root>/dist
 * - 打包后：extraResources dist/ → resources/dist，app.getAppPath() = resources/app，../dist = resources/dist
 */
function getBackendBundle(): string {
  return join(app.getAppPath(), '..', 'dist', 'index.js')
}

/**
 * node 可执行文件：打包后优先 extraResources 内的 node；否则系统 PATH 的 node。
 *
 * 路径模式：
 * - 打包后：resources/node/node[.exe]（electron-builder.yml extraResources 把 build/node/ 整目录打入）
 * - 开发期：系统 PATH 的 node
 *
 * 用系统 node 跑后端 bundle（node + index.js），better-sqlite3 用系统 Node ABI，
 * 与后端 build 时一致 —— 避免 ELECTRON_RUN_AS_NODE（Electron 内嵌 node ABI）的跨 ABI 问题。
 * 发行版通过 scripts/electron-pack.mjs 下载匹配的 Node 22 LTS 二进制到 build/node/。
 */
function getNodeExecutable(): string {
  const ext = process.platform === 'win32' ? '.exe' : ''
  const bundled = join(app.getAppPath(), '..', 'node', 'node' + ext)
  if (existsSync(bundled)) return bundled
  return 'node'
}

/**
 * 解析用户运行时配置根目录（`CHERY_DIR` 的父目录，即 `.env` 与 `.chery/` 所在目录）：
 *
 * - 打包后：afterPack 钩子（[scripts/post-pack.mjs](../../scripts/post-pack.mjs)）已经把 `.env`
 *   和 `.chery/` 复制到 `CheryNyxus.exe` 同级。默认 `dirname(process.execPath)`；
 *   `.env` 中 `CHERY_DIR` 非空时改用其值（便于跨平台部署）。
 * - 开发期：默认项目根 `<repo>/`（含 `.chery/`），`CHERY_DIR` env 优先。
 *
 * 返回值缓存：启动后固定，后端子进程与启动日志共用。
 */
function getRuntimeRoot(): string {
  if (runtimeRoot) return runtimeRoot
  if (!app.isPackaged) {
    runtimeRoot = process.env.CHERY_DIR ?? join(app.getAppPath(), '..')
  } else {
    runtimeRoot = process.env.CHERY_DIR || dirname(process.execPath)
  }
  return runtimeRoot
}

/**
 * 从 `getRuntimeRoot()/.env` 加载环境变量到 `process.env`。
 *
 * 加载规则：
 * - 跳过空行和 `#` 注释
 * - 空值（如 `CHERY_DIR=`）**不灌进 `process.env`**——保留默认推断行为
 * - 已存在的 `process.env` 变量**不覆盖**——OS env 优先级最高
 *
 * 注意：模板 `.env` 与运行时 `.env` 都在 `getRuntimeRoot()` 下，打包后由 afterPack
 * 钩子在打包阶段复制；不存在则静默跳过（用户可能手动删了 `.env`）。
 */
function loadEnvFile(): void {
  const envPath = join(getRuntimeRoot(), '.env')
  if (!existsSync(envPath)) {
    console.log(`[setup] no .env at ${envPath}, skipping env load`)
    return
  }

  const content = readFileSync(envPath, 'utf8')
  let loadedCount = 0
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx <= 0) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const value = trimmed
      .slice(eqIdx + 1)
      .trim()
      .replace(/^["']|["']$/g, '')
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    if (!value) continue // 空值：保留默认推断（不灌进 process.env）
    if (key in process.env) continue // 不覆盖已有（OS env 优先）
    process.env[key] = value
    loadedCount++
  }
  console.log(`[setup] loaded ${loadedCount} env var(s) from ${envPath}`)
}

/**
 * 启动后端子进程：系统 node + 后端 SSR bundle（node + index.js）。
 *
 * - `CHERY_DIR`：来自 `process.env.CHERY_DIR`（`.env` 灌入）或 `getRuntimeRoot()`
 * - `DB_DIR`：打包后落 `app.getPath('userData')/.chery/db`（可写，NSIS 默认 Program Files
 *   也能写）；开发期沿用 `CHERY_DIR/.chery/db`
 */
function startBackend(): ChildProcess {
  // 加载 .env（必须在 CHERY_DIR 计算之前，因为 .env 可能覆盖 CHERY_DIR）
  loadEnvFile()

  // 重新解析 runtimeRoot（CHERY_DIR 可能被 .env 改了）
  runtimeRoot = null
  const cheryDir = getRuntimeRoot()

  const env: NodeJS.ProcessEnv = { ...process.env, CHERY_DIR: cheryDir }
  // 清理 shell 可能注入的 ELECTRON_RUN_AS_NODE（系统 node 不认，但避免污染）
  delete env.ELECTRON_RUN_AS_NODE
  if (app.isPackaged) {
    env.DB_DIR = join(app.getPath('userData'), '.chery', 'db')
  }

  const child = spawn(getNodeExecutable(), [getBackendBundle()], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', (d) => process.stdout.write(`[backend] ${d}`))
  child.stderr?.on('data', (d) => process.stderr.write(`[backend] ${d}`))
  child.on('exit', (code) => {
    console.log(`[backend] exited with ${code}`)
  })
  return child
}

/**
 * 轮询 /api/config 等后端就绪，顺带取端口配置。
 */
async function waitForBackend(timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${WEB_PORT}/api/config`)
      if (res.ok) {
        serverConfig = (await res.json()) as { wsPort: number; webPort: number; transport: string }
        return
      }
    } catch {
      // 后端尚未就绪
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`后端启动超时（${timeoutMs}ms）`)
}

function loadRenderer(win: BrowserWindow, surface?: 'desktop' | 'console'): void {
  const query = surface ? `?surface=${surface}` : ''
  if (process.env.VITE_DEV_SERVER_URL) {
    const url = new URL(process.env.VITE_DEV_SERVER_URL)
    if (surface) url.searchParams.set('surface', surface)
    void win.loadURL(url.toString())
  } else {
    void win.loadFile(join(import.meta.dirname, '..', 'dist', 'index.html'), {
      search: query,
    })
  }
}

function showConsoleWindow(): void {
  if (!consoleWindow || consoleWindow.isDestroyed()) return
  consoleWindow.show()
  consoleWindow.focus()
}

/**
 * 打开（或显示）控制台并导航到指定目标。
 *
 * console 窗惰性创建：首次调用才建窗 + 加载 `?surface=console`。did-finish-load 前
 * 的 navigate 请求入队，就绪后按序补发——避免 renderer 尚未挂监听时消息丢失。
 */
function openConsole(target: ConsoleTarget = { target: 'show' }): void {
  if (!consoleWindow || consoleWindow.isDestroyed()) {
    createConsoleWindow()
    pendingConsoleTargets.push(target)
    return
  }
  showConsoleWindow()
  if (consoleReady) {
    consoleWindow.webContents.send('console:navigate', target)
  } else {
    pendingConsoleTargets.push(target)
  }
}

function quitApplication(): void {
  isQuitting = true
  app.quit()
}

/**
 * 程序化托盘图标：16x16 RGBA 位图（暖橙圆点 + 透明底）。
 * 仓库无磁盘图标资源，embedded data URL 在 Windows 缩放下几乎不可见；
 * 逐像素绘制保证任何环境托盘区都有可见锚点（打包后可替换为品牌图标资源）。
 */
function createTrayIcon(): Electron.NativeImage {
  const SIZE = 16
  const R = SIZE / 2
  const data = Buffer.alloc(SIZE * SIZE * 4)
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      // 圆内实心（边缘 0.5px 抗锯齿过渡），圆外透明
      const dist = Math.hypot(x + 0.5 - R, y + 0.5 - R)
      const alpha = Math.max(0, Math.min(1, R - 0.5 - (dist - 0.5)))
      const idx = (y * SIZE + x) * 4
      if (alpha > 0) {
        data[idx] = 246 // r
        data[idx + 1] = 183 // g
        data[idx + 2] = 60 // b（品牌暖橙 #f6b73c）
        data[idx + 3] = Math.round(alpha * 255)
      }
    }
  }
  return nativeImage.createFromBuffer(data, { width: SIZE, height: SIZE })
}

function rebuildTrayMenu(): void {
  if (!tray) return
  // 直接读注册表现值，避免自建持久化的状态漂移；开发期禁用，防止把 electron.exe dev 路径写进自启项。
  const autoLaunchEnabled = app.isPackaged && app.getLoginItemSettings().openAtLogin
  const petVisible = desktopWindow ? desktopWindow.isVisible() : true
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示控制台', click: () => openConsole() },
      { type: 'separator' },
      {
        label: '显示桌面宠物',
        type: 'checkbox',
        checked: petVisible,
        click: () => {
          if (!desktopWindow || desktopWindow.isDestroyed()) return
          if (desktopWindow.isVisible()) desktopWindow.hide()
          else desktopWindow.show()
          rebuildTrayMenu()
        },
      },
      {
        label: '开机自启',
        type: 'checkbox',
        checked: autoLaunchEnabled,
        enabled: app.isPackaged,
        click: () => {
          app.setLoginItemSettings({ openAtLogin: !autoLaunchEnabled })
          rebuildTrayMenu()
        },
      },
      { type: 'separator' },
      { label: '退出', click: quitApplication },
    ]),
  )
}

function createTray(): void {
  tray = new Tray(createTrayIcon())
  tray.setToolTip('CheryNyxus')
  tray.on('double-click', () => openConsole())
  // 单击也显示控制台：托盘是唯一常驻入口，降低唤起门槛（双击保留既有语义）。
  tray.on('click', () => openConsole())
  rebuildTrayMenu()
}

/**
 * 全工作区透明覆盖窗（desktop surface）：宠物 + 星系 + 发消息浮动窗直接渲染在桌面上。
 * 空区域鼠标穿透由 renderer 驱动（`desktop:mouse-passthrough`）；分辨率变化经
 * `display-*` 事件 setBounds 重贴 workArea。
 */
function createDesktopWindow(): void {
  const workArea = screen.getPrimaryDisplay().workArea
  const win = new BrowserWindow({
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    height: workArea.height,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(import.meta.dirname, 'preload.mjs'),
    },
  })
  desktopWindow = win
  win.setAlwaysOnTop(true, 'floating')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    win.hide()
  })
  win.on('closed', () => (desktopWindow = null))
  loadRenderer(win, 'desktop')
}

/** desktop 窗随主显示器 workArea 变化重贴（分辨率切换 / 任务栏调整）。 */
function realignDesktopWindow(): void {
  if (!desktopWindow || desktopWindow.isDestroyed()) return
  desktopWindow.setBounds(screen.getPrimaryDisplay().workArea)
}

/**
 * 惰性控制台窗（console surface）：承载设置 / 工作台等大界面。
 * 无边框（frame:false）——标题栏由渲染层 ConsoleShell 自绘（拖拽/最大化/最小化/关闭），
 * 经 `console:window-control` IPC 驱动原生窗口。关闭仅 hide 不 destroy——disconnectGrace
 * 按发起连接跟踪 run，console 发起 run 后关窗若断 WS 会触发 park；hide 保持连接存活。
 */
function createConsoleWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'CheryNyxus',
    frame: false,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(import.meta.dirname, 'preload.mjs'),
    },
  })
  consoleWindow = win
  consoleReady = false
  win.once('ready-to-show', () => win.show())
  // 原生最大化态变化（双击标题栏 / Win+↑ / 拖到屏幕边缘）→ 回推渲染层切标题栏图标
  const pushMaximized = () => {
    if (!win.isDestroyed()) win.webContents.send('console:maximize-changed', win.isMaximized())
  }
  win.on('maximize', pushMaximized)
  win.on('unmaximize', pushMaximized)
  win.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    win.hide()
  })
  win.on('closed', () => {
    consoleWindow = null
    consoleReady = false
  })
  win.webContents.on('did-finish-load', () => {
    consoleReady = true
    // 就绪前积压的 navigate 请求按序补发（含首开时的那一条）。
    const queued = pendingConsoleTargets.splice(0)
    for (const target of queued) {
      win.webContents.send('console:navigate', target)
    }
    pushMaximized()
  })
  loadRenderer(win, 'console')
}

app.whenReady().then(async () => {
  // 单实例锁
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  // IPC：preload 同步取后端端口配置（createWindow 在 waitForBackend 之后，配置已就绪）
  ipcMain.on('get-backend-config', (event) => {
    event.returnValue = serverConfig ?? { wsPort: WS_PORT, webPort: WEB_PORT, transport: 'binary' }
  })

  // IPC：渲染进程请求选择目录（预设 workspace 字段用）。canceled → null。
  ipcMain.handle('dialog:pickDirectory', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return result.canceled || !result.filePaths.length ? null : result.filePaths[0]!
  })

  ipcMain.on('desktop:mouse-passthrough', (event, ignore: unknown) => {
    if (event.sender !== desktopWindow?.webContents || typeof ignore !== 'boolean') return
    // Linux does not support forwarded mouse moves while ignored, so it would never become interactive again.
    if (process.platform === 'win32') desktopWindow?.setIgnoreMouseEvents(ignore, { forward: true })
  })

  ipcMain.on('desktop:open-console', (event, target: unknown) => {
    if (event.sender !== desktopWindow?.webContents) return
    if (!isValidConsoleTarget(target)) return
    openConsole(target)
  })

  // console 自绘标题栏 → 原生窗口控制（sender 校验 console 窗）。
  ipcMain.on('console:window-control', (event, action: unknown) => {
    const win = consoleWindow
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return
    if (action === 'minimize' || action === 'close') {
      // 最小化与关闭都走 hide：断 WS 会触发 disconnectGrace park 运行中任务
      win.hide()
      return
    }
    if (action === 'maximize') {
      if (!win.isMaximized()) win.maximize()
      return
    }
    if (action === 'restore') {
      if (win.isMaximized()) win.unmaximize()
      return
    }
  })

  // 启动日志：让用户在 console / 日志文件里能找到 .env 和 .chery 的真实路径
  console.log(`[setup] runtime root: ${getRuntimeRoot()}`)
  console.log(`[setup] .chery path: ${join(getRuntimeRoot(), '.chery')}`)
  console.log(`[setup] .env path: ${join(getRuntimeRoot(), '.env')}`)

  try {
    backend = startBackend()
    await waitForBackend()
    createDesktopWindow()
    createTray()
    // 分辨率切换 / 任务栏调整 → desktop 窗重贴 workArea（渲染层 resize 后自行 clamp 宠物/星系位置）
    screen.on('display-metrics-changed', realignDesktopWindow)
    screen.on('display-added', realignDesktopWindow)
    screen.on('display-removed', realignDesktopWindow)
  } catch (e) {
    console.error('启动后端失败:', e)
    app.quit()
  }

  app.on('activate', () => {
    openConsole()
  })

  app.on('second-instance', () => openConsole())
})

app.on('window-all-closed', () => {
  // The tray owns application lifetime; closing windows only hides them.
})

app.on('before-quit', async (e) => {
  // 阻止默认退出，等待清理完成
  e.preventDefault()
  isQuitting = true
  tray?.destroy()
  tray = null

  // 1. 清理 IPC 监听器
  ipcMain.removeAllListeners()

  // 2. 等待 backend 子进程退出（最长 5 秒超时）
  if (backend && !backend.killed) {
    const BACKEND_EXIT_TIMEOUT_MS = 5000

    backend.kill('SIGTERM')

    // 监听 backend exit 事件
    const exitPromise = new Promise<void>((resolve) => {
      backend!.once('exit', () => {
        console.log('[backend] 已退出')
        resolve()
      })
    })

    // 超时强制 kill
    const timeoutPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        if (backend && !backend.killed) {
          console.warn(`[backend] ${BACKEND_EXIT_TIMEOUT_MS}ms 超时，强制 SIGKILL`)
          backend.kill('SIGKILL')
        }
        resolve()
      }, BACKEND_EXIT_TIMEOUT_MS)
    })

    await Promise.race([exitPromise, timeoutPromise])
    backend = null
  }

  // 3. 允许退出
  app.exit(0)
})
