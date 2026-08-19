import { join, dirname } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { app, BrowserWindow, ipcMain, dialog, Menu, Tray, nativeImage, screen } from 'electron'

// 【诊断·临时】深色白边定位：覆盖层实验证实白线在最高 z-index 内容之上（非内容层、非合成背景），
// 候选为 GPU 合成边缘伪影。disableHardwareAcceleration 强制软件合成验证；星系/粒子动画会走
// 软件渲染（性能下降）。白线消失 → GPU 伪影实锤（再评估性能取舍）；白线仍在 → 转 DWM 边框假设。测完移除。
app.disableHardwareAcceleration()

/**
 * desktop renderer → main 请求打开独立原生窗的目标。
 * 仅 desktop 窗可发起；main 惰性创建 / show+focus 复用（工作台窗 hide 保活）。
 */
export type WindowKind = 'settings' | 'workbench'
export interface OpenWindowRequest {
  kind: WindowKind
  presetId?: string
  chatId?: string
  /** 待处理抽屉「打开节点树」定位参数（新建工作台窗 did-finish-load 后下发）。 */
  focus?: { sourceChatId?: string; interactionId?: string; anchorNodeId?: string }
}

/** IPC 载荷防御校验：window:open 的请求结构不合法时静默丢弃。 */
function isValidOpenRequest(value: unknown): value is OpenWindowRequest {
  if (!value || typeof value !== 'object') return false
  const req = value as Partial<OpenWindowRequest>
  if (req.kind === 'settings') return true
  if (req.kind === 'workbench') {
    return (
      typeof req.presetId === 'string' &&
      (req.chatId === undefined || typeof req.chatId === 'string') &&
      (req.focus === undefined || typeof req.focus === 'object')
    )
  }
  return false
}

/** 受管原生窗注册表项。key：'settings' | `wb:${presetId}` */
interface ManagedWindow {
  kind: WindowKind
  presetId?: string
  win: BrowserWindow
  /** 工作台窗 keepAlive（close=hide 保 WS/run）；设置窗 close 即 destroy。 */
  keepAlive: boolean
}

const WS_PORT = Number(process.env.WS_PORT ?? 8182)
const WEB_PORT = Number(process.env.WEB_PORT ?? 8183)

let backend: ChildProcess | null = null
let desktopWindow: BrowserWindow | null = null
/** 全部受管原生窗（settings + 每 preset 一工作台窗）。 */
const managedWindows = new Map<string, ManagedWindow>()
let tray: Tray | null = null
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

/** 加载渲染入口。params 拼接为 query（dev 用 searchParams，prod 用 loadFile search）。 */
function loadRenderer(win: BrowserWindow, params: Record<string, string> = {}): void {
  if (process.env.VITE_DEV_SERVER_URL) {
    const url = new URL(process.env.VITE_DEV_SERVER_URL)
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
    void win.loadURL(url.toString())
  } else {
    const search = new URLSearchParams(params).toString()
    void win.loadFile(join(import.meta.dirname, '..', 'dist', 'index.html'), { search })
  }
}

// ── 受管原生窗 bounds 持久化 ──────────────────────────────────────────────
// 原生窗几何由 main 拥有（renderer 无感知）。按 key 持久化常规 bounds（不存最大化态，
// 重开默认常规窗），创建时经 screen 校验贴屏，防显示器变更后落在屏外。

interface WindowStateFile {
  [key: string]: { x: number; y: number; width: number; height: number }
}

function windowStatePath(): string {
  return join(app.getPath('userData'), 'window-state.json')
}

function loadWindowState(): WindowStateFile {
  try {
    const parsed = JSON.parse(readFileSync(windowStatePath(), 'utf8')) as WindowStateFile
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function saveWindowState(state: WindowStateFile): void {
  try {
    writeFileSync(windowStatePath(), JSON.stringify(state))
  } catch (e) {
    console.warn('[window-state] save failed:', e)
  }
}

/** bounds 校验：须与任一显示器 workArea 有 ≥40px 交叠（至少可见一角），否则回退默认。 */
function clampBoundsToDisplays(bounds: Electron.Rectangle): Electron.Rectangle {
  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea
    const overlapW = Math.min(bounds.x + bounds.width, a.x + a.width) - Math.max(bounds.x, a.x)
    const overlapH = Math.min(bounds.y + bounds.height, a.y + a.height) - Math.max(bounds.y, a.y)
    return overlapW > 40 && overlapH > 40
  })
  return visible ? bounds : { x: 0, y: 0, width: 1200, height: 800 }
}

function restoreBounds(key: string): Partial<Electron.Rectangle> {
  const bounds = loadWindowState()[key]
  if (!bounds) return {}
  const clamped = clampBoundsToDisplays(bounds)
  return { x: clamped.x, y: clamped.y, width: clamped.width, height: clamped.height }
}

// ── 受管原生窗（settings / workbench） ────────────────────────────────────
// 框架 frame:false，自绘标题栏由渲染层 WindowFrame / WorkbenchDialog 提供。
// 原生最大化/焦点态回推；bounds 变更去抖持久化；工作台窗 close=hide 保 WS/run。

/**
 * settings 窗尺寸：默认按内容所需（约设置面板 1040x760 的理想尺寸 + 余量），
 * 最小可缩到内容可用下限；屏幕 workArea 不足时两者都收敛到 workArea（屏幕最大可用）。
 * workbench 沿用宽屏默认。无持久化 bounds 时应用默认尺寸（系统居中）。
 */
const SETTINGS_DEFAULT_SIZE = { width: 1080, height: 760 }
const SETTINGS_MIN_SIZE = { width: 900, height: 640 }
const WORKBENCH_DEFAULT_SIZE = { width: 1200, height: 800 }
const COMMON_MIN_SIZE = { width: 640, height: 480 }

/** 依 kind 计算窗口默认/最小尺寸：屏幕够则取标称值，不够则收敛到主屏 workArea。 */
function managedWindowSizes(isSettings: boolean): {
  defaultSize: { width: number; height: number }
  minSize: { width: number; height: number }
} {
  const workArea = screen.getPrimaryDisplay().workArea
  const nominal = isSettings ? SETTINGS_DEFAULT_SIZE : WORKBENCH_DEFAULT_SIZE
  const minNominal = isSettings ? SETTINGS_MIN_SIZE : COMMON_MIN_SIZE
  return {
    defaultSize: {
      width: Math.min(nominal.width, workArea.width),
      height: Math.min(nominal.height, workArea.height),
    },
    minSize: {
      width: Math.min(minNominal.width, workArea.width),
      height: Math.min(minNominal.height, workArea.height),
    },
  }
}

function createManagedWindow(
  key: string,
  opts: {
    kind: WindowKind
    presetId?: string
    title: string
    surface: 'settings' | 'workbench'
    extraParams?: Record<string, string>
    keepAlive: boolean
  },
): ManagedWindow {
  const persisted = restoreBounds(key)
  // 无持久化记录（含首次打开）→ 不指定 x/y（系统居中），用内容所需默认尺寸
  const sizes = managedWindowSizes(key === 'settings')
  const win = new BrowserWindow({
    ...persisted,
    ...(persisted.width !== undefined ? {} : sizes.defaultSize),
    minWidth: sizes.minSize.width,
    minHeight: sizes.minSize.height,
    title: opts.title,
    frame: false,
    show: false,
    // 首帧兜底：深色主题 bg（渲染层 theme apply 后按主题回写 window:set-background）
    backgroundColor: '#16181d',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(import.meta.dirname, 'preload.mjs'),
    },
  })
  const entry: ManagedWindow = {
    kind: opts.kind,
    presetId: opts.presetId,
    win,
    keepAlive: opts.keepAlive,
  }
  managedWindows.set(key, entry)

  win.once('ready-to-show', () => win.show())

  // 原生最大化态变化（双击标题栏 / Win+↑ / 拖到屏幕边缘）→ 回推渲染层切标题栏图标
  const pushMaximized = () => {
    if (!win.isDestroyed()) win.webContents.send('window:maximized', win.isMaximized())
  }
  win.on('maximize', pushMaximized)
  win.on('unmaximize', pushMaximized)
  win.on('focus', () => {
    if (!win.isDestroyed()) win.webContents.send('window:focused', true)
  })
  win.on('blur', () => {
    if (!win.isDestroyed()) win.webContents.send('window:focused', false)
  })

  // bounds 去抖持久化（move/resize 期间不频繁写盘）
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  const persistBounds = () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      if (win.isDestroyed()) return
      const state = loadWindowState()
      state[key] = win.getBounds()
      saveWindowState(state)
    }, 400)
  }
  win.on('move', persistBounds)
  win.on('resize', persistBounds)

  win.on('close', (event) => {
    if (isQuitting) return
    if (entry.keepAlive) {
      // 工作台窗：hide 不销毁——断 WS 会触发 disconnectGrace park 运行中任务，
      // hide 保持连接、run 继续；重开同 preset → show+focus 还原。
      event.preventDefault()
      win.hide()
      return
    }
    // 设置窗：默认销毁（无运行状态，重开重载 config）
  })
  win.on('closed', () => {
    if (managedWindows.get(key) === entry) managedWindows.delete(key)
  })

  loadRenderer(win, { surface: opts.surface, ...opts.extraParams })
  return entry
}

/** 显示既有受管窗（hide 保活后还原）。不存在 / 已销毁 → false。 */
function showManagedWindow(key: string): boolean {
  const entry = managedWindows.get(key)
  if (!entry || entry.win.isDestroyed()) return false
  entry.win.show()
  entry.win.focus()
  return true
}

function openSettingsWindow(): void {
  if (showManagedWindow('settings')) return
  createManagedWindow('settings', {
    kind: 'settings',
    title: 'CheryNyxus 设置',
    surface: 'settings',
    keepAlive: false,
  })
}

function openWorkbenchWindow(req: OpenWindowRequest & { kind: 'workbench' }): void {
  const key = `wb:${req.presetId}`
  if (showManagedWindow(key)) {
    // 已存在：带新 chatId → 切换会话；带 focus → 定位树节点
    const wc = managedWindows.get(key)!.win.webContents
    if (req.chatId) wc.send('workbench:open-chat', req.chatId)
    if (req.focus) wc.send('workbench:focus', req.focus)
    return
  }
  const entry = createManagedWindow(key, {
    kind: 'workbench',
    presetId: req.presetId,
    title: 'CheryNyxus 工作台',
    surface: 'workbench',
    keepAlive: true,
    extraParams: {
      presetId: req.presetId!,
      ...(req.chatId ? { chatId: req.chatId } : {}),
    },
  })
  // did-finish-load 后补发 focus（renderer 尚未挂监听时消息会丢失）
  if (req.focus) {
    entry.win.webContents.once('did-finish-load', () => {
      if (!entry.win.isDestroyed()) entry.win.webContents.send('workbench:focus', req.focus)
    })
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
      { label: '打开设置', click: () => openSettingsWindow() },
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
  // 单击/双击都打开设置窗（应用主界面锚点；desktop 宠物窗本就常驻）
  tray.on('double-click', () => openSettingsWindow())
  tray.on('click', () => openSettingsWindow())
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
    // win32：frameless 透明窗默认带 DWM 粗边框，全屏覆盖时桌面四周会露 1px 描边 → 关闭
    thickFrame: false,
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(import.meta.dirname, 'preload.mjs'),
    },
  })
  desktopWindow = win
  // transparent 窗的 backgroundColor 选项在部分 Electron/Windows 组合下不生效，
  // 窗口背景回退为默认白色 → 内容未铺满的边缘 1px 露白边（浅色模式与浅内容融合不明显，
  // 深色模式深内容旁显眼）。创建后运行时强制全透明（thickFrame/setShape 均管不到背景色填充）。
  win.setBackgroundColor('#00000000')
  win.setAlwaysOnTop(true, 'floating')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    win.hide()
  })
  win.on('closed', () => (desktopWindow = null))
  loadRenderer(win, { surface: 'desktop' })
}

/** desktop 窗随主显示器 workArea 变化重贴（分辨率切换 / 任务栏调整）。 */
function realignDesktopWindow(): void {
  if (!desktopWindow || desktopWindow.isDestroyed()) return
  desktopWindow.setBounds(screen.getPrimaryDisplay().workArea)
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

  // 打开独立原生窗（仅 desktop 窗可发起；结构校验后转发工厂）。
  ipcMain.on('window:open', (event, req: unknown) => {
    if (event.sender !== desktopWindow?.webContents) return
    if (!isValidOpenRequest(req)) return
    if (req.kind === 'settings') {
      openSettingsWindow()
    } else {
      openWorkbenchWindow(req as OpenWindowRequest & { kind: 'workbench' })
    }
  })

  // 任一原生窗自绘标题栏 → 原生窗口控制（按 sender 定位，免传 windowId、防伪造）。
  ipcMain.on('window:control', (event, action: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) return
    if (action === 'minimize') {
      win.minimize()
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
    if (action === 'close') {
      // 工作台窗 close 事件里 keepAlive 分支 → hide；设置窗 → destroy
      win.close()
    }
  })

  // 渲染层主题 apply → 原生窗口底色（首帧 / resize 边缘兜底，防灰边/白边）
  ipcMain.on('window:set-background', (event, color: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed() || typeof color !== 'string') return
    win.setBackgroundColor(color)
  })

  // workbench attentionBlink → 任务栏闪烁
  ipcMain.on('window:flash', (event, flag: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed() || typeof flag !== 'boolean') return
    win.flashFrame(flag)
  })

  // 跨窗主题同步：任一窗切换 → 广播全部受管窗（除本窗）
  ipcMain.on('theme:changed', (event, theme: unknown) => {
    if (theme !== 'light' && theme !== 'dark') return
    for (const entry of managedWindows.values()) {
      if (!entry.win.isDestroyed() && entry.win.webContents !== event.sender) {
        entry.win.webContents.send('theme:set', theme)
      }
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
    openSettingsWindow()
  })

  app.on('second-instance', () => openSettingsWindow())
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
