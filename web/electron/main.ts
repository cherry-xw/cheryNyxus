import { join, dirname } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { app, BrowserWindow, ipcMain, dialog, Menu, Tray, nativeImage, screen } from 'electron'
// 桌面单窗：pet / nyxus 两独立浮窗体系（FloatingWindow / 漂移 / teleport / surface:* IPC）已废弃，见 docs/web/electron.md「2026-08 单窗合并」。
// 全屏覆盖检测：外部全屏视频 / 游戏出现时隐藏 desktop 窗（koffi + user32，失败降级不阻塞）。
import { startFullscreenGuard } from './fullscreenGuard'

/**
 * Electron graphics policy.
 *
 * Workbench animation is intentionally hardware accelerated by default. The previous unconditional
 * `disableHardwareAcceleration()` made Pixi, scrolling and transparent-layer composition compete on
 * Chromium's software raster thread and produced a large desktop-vs-browser frame-rate gap.
 *
 * A GPU child-process crash records a persistent safe-mode marker. The following launch then falls
 * back to software rendering before any BrowserWindow is created. Operators can override either way:
 * `CHERY_GRAPHICS_MODE=hardware|software`, `--chery-force-gpu`, or `--chery-software-rendering`.
 */
type GraphicsMode = 'hardware' | 'software'

const GPU_SAFE_MODE_PATH = join(app.getPath('userData'), 'gpu-safe-mode.json')
const graphicsModeEnv = process.env.CHERY_GRAPHICS_MODE?.trim().toLowerCase()
const forceHardware =
  process.argv.includes('--chery-force-gpu') || graphicsModeEnv === 'hardware'
const forceSoftware =
  process.argv.includes('--chery-software-rendering') ||
  process.argv.includes('--disable-gpu') ||
  graphicsModeEnv === 'software'
const gpuSafeModeActive = !forceHardware && existsSync(GPU_SAFE_MODE_PATH)
const graphicsMode: GraphicsMode = forceSoftware || gpuSafeModeActive ? 'software' : 'hardware'

if (graphicsMode === 'software') app.disableHardwareAcceleration()

function recordGpuSafeMode(reason: string): void {
  if (graphicsMode !== 'hardware') return
  try {
    writeFileSync(
      GPU_SAFE_MODE_PATH,
      JSON.stringify({ reason, recordedAt: new Date().toISOString() }),
    )
    console.error(`[graphics] GPU 异常，已记录软件渲染安全模式: ${GPU_SAFE_MODE_PATH}`)
  } catch (error) {
    console.error('[graphics] 无法写入 GPU 安全模式标记:', error)
  }
}

/**
 * desktop renderer → main 请求打开独立原生窗的目标。
 * 仅 desktop 窗可发起；main 惰性创建 / show+focus 复用（工作台窗 hide 保活）。
 */
export type WindowKind = 'settings' | 'workbench' | 'composer' | 'history' | 'login'
export interface OpenWindowRequest {
  kind: WindowKind
  presetId?: string
  chatId?: string
  source?: 'pet' | 'history' | 'nyxus'
  view?: 'composer' | 'attention' | 'tree'
  /** 待处理抽屉「打开节点树」定位参数（新建工作台窗 did-finish-load 后下发）。 */
  focus?: { sourceChatId?: string; interactionId?: string; anchorNodeId?: string }
}

/** IPC 载荷防御校验：window:open 的请求结构不合法时静默丢弃。 */
function isValidOpenRequest(value: unknown): value is OpenWindowRequest {
  if (!value || typeof value !== 'object') return false
  const req = value as Partial<OpenWindowRequest>
  if (req.kind === 'settings') return true
  if (req.kind === 'login') return true
  if (req.kind === 'history') return typeof req.chatId === 'string'
  if (req.kind === 'composer') {
    return (
      typeof req.chatId === 'string' &&
      (req.source === 'pet' || req.source === 'history' || req.source === 'nyxus') &&
      (req.view === 'composer' || req.view === 'attention' || req.view === 'tree')
    )
  }
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

/** 后端 /api/config 拉取超时（ms）：worker 重启瞬间端口可能短暂不可用，超时让调用方快速重试而非挂死。 */
const CONFIG_FETCH_TIMEOUT_MS = 5000

/** 后端配置契约：与 /api/config 返回对齐。sessionToken 随 worker 重启轮换，IPC 刷新用。 */
interface BackendConfig {
  wsPort: number
  webPort: number
  transport: 'binary' | 'json'
  sessionToken?: string
}

let backend: ChildProcess | null = null
/** 桌面单窗（全工作区透明覆盖，pet/Nyxus 同窗渲染）。 */
let desktopWin: BrowserWindow | null = null
/** 全部受管原生窗（settings + 每 preset 一工作台窗）。 */
const managedWindows = new Map<string, ManagedWindow>()
let tray: Tray | null = null
let isQuitting = false
let serverConfig: BackendConfig | null = null
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
    // Windows: main 是 GUI 进程无控制台，缺省 spawn 控制台子进程会闪 cmd 窗
    windowsHide: true,
  })
  child.stdout?.on('data', (d) => process.stdout.write(`[backend] ${d}`))
  child.stderr?.on('data', (d) => process.stderr.write(`[backend] ${d}`))
  child.on('exit', (code) => {
    console.log(`[backend] exited with ${code}`)
  })
  return child
}

/**
 * 从后端拉取最新配置（含轮换后的 sessionToken）。带 5s 超时 + Cache-Control: no-store，
 * worker 重启瞬间端口不可用时快速 reject，调用方（waitForBackend / IPC 刷新）各自重试。
 */
async function fetchBackendConfig(): Promise<BackendConfig> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CONFIG_FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(`http://localhost:${WEB_PORT}/api/config`, {
      cache: 'no-store',
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`/api/config ${res.status}`)
    return (await res.json()) as BackendConfig
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 轮询 /api/config 等后端就绪，顺带取端口配置。
 */
async function waitForBackend(timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      serverConfig = await fetchBackendConfig()
      return
    } catch {
      // 后端尚未就绪
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`后端启动超时（${timeoutMs}ms）`)
}

/** 加载渲染入口。params 拼接为 query（dev 用 searchParams，prod 用 loadFile search）。 */
function loadRenderer(win: BrowserWindow, params: Record<string, string> = {}): void {
  const rendererParams = { ...params, graphicsMode }
  if (process.env.VITE_DEV_SERVER_URL) {
    const url = new URL(process.env.VITE_DEV_SERVER_URL)
    for (const [k, v] of Object.entries(rendererParams)) url.searchParams.set(k, v)
    void win.loadURL(url.toString())
  } else {
    const search = new URLSearchParams(rendererParams).toString()
    void win.loadFile(join(import.meta.dirname, '..', 'dist', 'index.html'), { search })
  }
}

/**
 * 渲染进程诊断日志（全部窗口注册）：黑屏类问题先看这里（详见 docs/web/electron.md「渲染进程崩溃观测」）。
 * - render-process-gone：渲染进程崩溃/被杀——GPU 崩溃时窗口只剩 backgroundColor 兜底色、DevTools 打不开。
 * - did-fail-load：主帧加载失败——dev server 未起 / 产物路径缺失。
 */
function attachWindowDiagnostics(win: BrowserWindow, label: string): void {
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[${label}] 渲染进程异常退出: reason=${details.reason} exitCode=${details.exitCode}`)
  })
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (isMain) console.error(`[${label}] 页面加载失败: ${code} ${desc} ${url}`)
  })
}

// ── 受管原生窗 bounds 持久化 ──────────────────────────────────────────────
// 原生窗几何由 main 拥有（renderer 无感知）。按 key 持久化常规 bounds（不存最大化态，
// 重开默认常规窗），创建时经 screen 校验贴屏，防显示器变更后落在屏外。

interface PersistedWindowState extends Electron.Rectangle {
  visible?: boolean
}
interface WindowStateFile {
  [key: string]: PersistedWindowState
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
const AUX_WINDOW_SIZES: Record<'composer' | 'history' | 'login', {
  defaultSize: { width: number; height: number }
  minSize: { width: number; height: number }
}> = {
  composer: { defaultSize: { width: 420, height: 640 }, minSize: { width: 380, height: 520 } },
  history: { defaultSize: { width: 620, height: 760 }, minSize: { width: 420, height: 520 } },
  login: { defaultSize: { width: 440, height: 620 }, minSize: { width: 420, height: 520 } },
}

/** 依 kind 计算窗口默认/最小尺寸：屏幕够则取标称值，不够则收敛到主屏 workArea。 */
function managedWindowSizes(kind: WindowKind): {
  defaultSize: { width: number; height: number }
  minSize: { width: number; height: number }
} {
  const workArea = screen.getPrimaryDisplay().workArea
  const aux = kind === 'composer' || kind === 'history' || kind === 'login' ? AUX_WINDOW_SIZES[kind] : undefined
  const nominal = aux?.defaultSize ?? (kind === 'settings' ? SETTINGS_DEFAULT_SIZE : WORKBENCH_DEFAULT_SIZE)
  const minNominal = aux?.minSize ?? (kind === 'settings' ? SETTINGS_MIN_SIZE : COMMON_MIN_SIZE)
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
    surface: 'settings' | 'workbench' | 'composer' | 'history' | 'login'
    extraParams?: Record<string, string>
    keepAlive: boolean
  },
): ManagedWindow {
  const sizes = managedWindowSizes(opts.kind)
  const storedBounds = restoreBounds(key)
  // Compact composer migration: replace only the previous 440x720 default.
  // Any user-resized geometry is still respected.
  const persisted =
    opts.kind === 'composer' && storedBounds.width === 440 && storedBounds.height === 720
      ? { ...storedBounds, ...sizes.defaultSize }
      : storedBounds
  // 无持久化记录（含首次打开）→ 不指定 x/y（系统居中），用内容所需默认尺寸
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

  attachWindowDiagnostics(win, key)
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
  const desktopVisible = desktopWin !== null && !desktopWin.isDestroyed() && desktopWin.isVisible()
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开设置', click: () => openSettingsWindow() },
      { type: 'separator' },
      {
        label: '显示桌面',
        type: 'checkbox',
        checked: desktopVisible,
        click: () => {
          if (!desktopWin || desktopWin.isDestroyed()) return
          if (desktopVisible) desktopWin.hide()
          else desktopWin.showInactive()
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

function openAuxWindow(req: OpenWindowRequest & { kind: 'composer' | 'history' | 'login' }): void {
  const key = req.kind
  const existing = managedWindows.get(key)
  if (existing && !existing.win.isDestroyed()) {
    existing.win.show()
    existing.win.focus()
    if (req.kind === 'composer') {
      existing.win.webContents.send('surface:retarget', {
        chatId: req.chatId,
        source: req.source,
        view: req.view,
      })
    } else if (req.kind === 'history') {
      existing.win.webContents.send('surface:retarget', { chatId: req.chatId })
    }
    return
  }

  const title = req.kind === 'composer' ? 'CheryNyxus 会话' : req.kind === 'history' ? 'CheryNyxus 历史' : '连接服务'
  createManagedWindow(key, {
    kind: req.kind,
    title,
    surface: req.kind,
    keepAlive: req.kind === 'composer',
    extraParams: {
      ...(req.chatId ? { chatId: req.chatId } : {}),
      ...(req.source ? { source: req.source } : {}),
      ...(req.view ? { view: req.view } : {}),
    },
  })
}

/** 桌面单窗/透明窗 setShape 内缩 2 DIP，裁 DWM 合成的 1px non-client 边缘（1px 边框防线）。 */
function applyFloatingShape(win: BrowserWindow): void {
  if (process.platform !== 'win32' || win.isDestroyed()) return
  const [width, height] = win.getSize()
  win.setShape([{ x: 2, y: 2, width: Math.max(1, width - 4), height: Math.max(1, height - 4) }])
}

/**
 * 桌面单窗：全工作区透明覆盖窗，pet / CheryNyxus 同窗渲染（?surface=desktop）。 * 透明参数全套是 1px 边框防线的原生侧基础，一个都不能少：
 * frame:false / transparent / resizable:false / alwaysOnTop / skipTaskbar /
 * hasShadow:false / thickFrame:false（win32 关 DWM WS_THICKFRAME 粗边框）/ backgroundColor:'#00000000'。
 */
function createDesktopSurfaceWindow(): BrowserWindow {
  const a = screen.getPrimaryDisplay().workArea
  const win = new BrowserWindow({
    x: a.x,
    y: a.y,
    width: a.width,
    height: a.height,
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
  desktopWin = win
  attachWindowDiagnostics(win, 'desktop')
  win.setBackgroundColor('#00000000')
  win.setAlwaysOnTop(true, 'floating')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.once('ready-to-show', () => {
    // setShape 内缩 2 DIP 裁 DWM non-client 边缘（1px 边框防线第二层，与透明参数配合）
    applyFloatingShape(win)
    win.showInactive()
  })
  win.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    win.hide()
  })
  win.on('closed', () => {
    if (desktopWin === win) desktopWin = null
  })
  loadRenderer(win, { surface: 'desktop' })
  return win
}

/** 桌面单窗跟随主屏 workArea 重设 bounds + 重裁形状（显示器变化）。 */
function realignDesktopSurface(): void {
  if (!desktopWin || desktopWin.isDestroyed()) return
  desktopWin.setBounds(screen.getPrimaryDisplay().workArea, false)
  applyFloatingShape(desktopWin)
}

function isTrustedRenderer(sender: Electron.WebContents): boolean {
  // desktop 单窗必须可发起 window:open（打开设置/工作台/会话辅助窗）
  if (desktopWin && !desktopWin.isDestroyed() && desktopWin.webContents === sender) return true
  return [...managedWindows.values()].some((entry) => entry.win.webContents === sender)
}

function broadcast(channel: string, data: unknown, except?: Electron.WebContents): void {
  const send = (win: BrowserWindow) => {
    if (!win.isDestroyed() && win.webContents !== except) win.webContents.send(channel, data)
  }
  if (desktopWin && !desktopWin.isDestroyed()) send(desktopWin)
  for (const entry of managedWindows.values()) send(entry.win)
}

app.whenReady().then(async () => {
  // 单实例锁
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  // GPU 进程等工具子进程异常退出观测（与 attachWindowDiagnostics 渲染进程日志互补）
  app.on('child-process-gone', (_e, details) => {
    console.warn(`[main] 子进程异常退出: type=${details.type} reason=${details.reason}`)
    if (
      !isQuitting &&
      details.type.toLowerCase() === 'gpu' &&
      details.reason !== 'clean-exit'
    ) {
      recordGpuSafeMode(`${details.type}:${details.reason}`)
    }
  })

  console.log(
    `[graphics] mode=${graphicsMode}${gpuSafeModeActive ? ' (persistent safe mode)' : ''}`,
  )
  console.log(`[graphics] Chromium features=${JSON.stringify(app.getGPUFeatureStatus())}`)

  // IPC：preload 同步取后端端口配置（createWindow 在 waitForBackend 之后，配置已就绪）
  ipcMain.on('get-backend-config', (event) => {
    event.returnValue = serverConfig ?? { wsPort: WS_PORT, webPort: WEB_PORT, transport: 'binary' }
  })

  // IPC：渲染进程请求刷新后端配置（worker 重启轮换 sessionToken 后，重连必须拿最新值）。
  // 渲染进程不能直接 fetch /api/config——后端响应无 Access-Control-Allow-Origin 头，
  // Chromium 会按 CORS 拦截跨源请求（渲染进程 origin 为 file:// 或 dev :5173，均与 :8183 跨源）。
  // 下沉到 main 进程用 Node 全局 fetch（无 CORS 限制），带 5s 超时，worker 切换瞬间可重试。
  ipcMain.handle('backend:refresh-config', async () => {
    try {
      return await fetchBackendConfig()
    } catch (e) {
      throw new Error(`获取后端配置失败: ${(e as Error).message}`)
    }
  })

  // IPC：渲染进程请求选择目录（预设 workspace 字段用）。canceled → null。
  ipcMain.handle('dialog:pickDirectory', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return result.canceled || !result.filePaths.length ? null : result.filePaths[0]!
  })

  ipcMain.on('desktop:mouse-passthrough', (event, ignore: unknown) => {
    if (!desktopWin || desktopWin.isDestroyed() || event.sender !== desktopWin.webContents) return
    if (typeof ignore !== 'boolean') return
    // Linux does not support forwarded mouse moves while ignored, so it would never become interactive again.
    if (process.platform === 'win32') desktopWin.setIgnoreMouseEvents(ignore, { forward: true })
  })

  // 打开独立原生窗（仅本应用已登记 renderer 可发起；结构校验后转发工厂）。
  ipcMain.on('window:open', (event, req: unknown) => {
    if (!isTrustedRenderer(event.sender)) return
    if (!isValidOpenRequest(req)) return
    if (req.kind === 'settings') {
      openSettingsWindow()
    } else if (req.kind === 'workbench') {
      openWorkbenchWindow(req as OpenWindowRequest & { kind: 'workbench' })
    } else {
      openAuxWindow(req as OpenWindowRequest & { kind: 'composer' | 'history' | 'login' })
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
    broadcast('theme:set', theme, event.sender)
  })

  ipcMain.on('auth:changed', (event, data: unknown) => {
    if (!isTrustedRenderer(event.sender)) return
    broadcast('auth:changed', data, event.sender)
  })

  // 启动日志：让用户在 console / 日志文件里能找到 .env 和 .chery 的真实路径
  console.log(`[setup] runtime root: ${getRuntimeRoot()}`)
  console.log(`[setup] .chery path: ${join(getRuntimeRoot(), '.chery')}`)
  console.log(`[setup] .env path: ${join(getRuntimeRoot(), '.env')}`)

  try {
    backend = startBackend()
    await waitForBackend()
    createDesktopSurfaceWindow()
    // 全屏视频 / 游戏出现时隐藏 desktop 窗，退出全屏恢复（koffi 加载失败自动降级不启用）
    startFullscreenGuard(() => desktopWin)
    createTray()
    screen.on('display-metrics-changed', realignDesktopSurface)
    screen.on('display-added', realignDesktopSurface)
    screen.on('display-removed', realignDesktopSurface)
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
