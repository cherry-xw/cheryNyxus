/**
 * platform：渲染进程环境抽象层。
 *
 * 封装"我跑在哪种平台 / 后端怎么连 / 能调什么原生能力"。
 * 业务代码不再直接读 `window.__BACKEND_CONFIG__` / `window.__BACKEND_HTTP_URL__`
 * 两个 Electron preload 注入的全局，全部经本文件门面消费。
 *
 * 设计要点：
 * - 单一 `Window` 全局类型声明（其他文件禁止再 `declare global` 加这些字段）
 * - `isElectron` 用 `__BACKEND_CONFIG__` 存在性做单一事实源
 * - WS URL 三分支（Electron / vite-dev / static-prod）收敛到 `wsUrl()`
 * - `httpUrl` 行为兼容旧 API（[http.ts] 转发层保留 5 处旧 import 路径不变）
 * - `ServerConfig` 是后端配置契约的唯一类型源，ws.ts 通过 `import type` 消费
 *
 * 详细：[docs/web/env.md](../../../docs/web/env.md)
 */

import { useAuthStore, hostOf } from '@/stores/auth'

/** 后端端口 + transport + 会话 token。preload 注入 / `/api/config` 双源对齐。 */
export interface ServerConfig {
  wsPort: number
  webPort: number
  transport: 'binary' | 'json'
  /** Ephemeral local capability required by the backend WebSocket control plane. */
  sessionToken?: string
}

declare global {
  interface Window {
    /** Electron 模式由 preload 经 contextBridge 注入；浏览器模式无 */
    __BACKEND_CONFIG__?: ServerConfig
    /** Electron preload 注入（http://localhost:<webPort>）；浏览器模式无 */
    __BACKEND_HTTP_URL__?: string
    /** Electron preload 注入：invoke main 进程刷新后端配置（返回含最新 sessionToken）；浏览器模式无 */
    __REFRESH_BACKEND_CONFIG__?: () => Promise<ServerConfig>
    /** Electron preload 注入：目录选择对话框（预设 workspace 用）；浏览器模式无 */
    __PICK_DIRECTORY__?: () => Promise<string | null>
    /** Electron preload 注入：原生窗口与多 surface 协调桥。 */
    __DESKTOP_BRIDGE__?: import('@/features/desktop/desktopBridge').DesktopBridge
  }
}

// ---- 单一事实源 -------------------------------------------------------------

/** 当前是否运行在 Electron 模式（preload 注入了 `__BACKEND_CONFIG__`）。 */
export const isElectron: boolean = typeof window !== 'undefined' && !!window.__BACKEND_CONFIG__

/**
 * `/api/config` 拉取超时（ms）。worker 重启瞬间 Chromium 连接池可能把请求复用到
 * 已死的 socket 上——无超时会让重连的 fetch 永久挂起、`conn.status` 卡在 disconnected
 * 且无日志。超时 reject → ws.ts `reconnect()` catch → 2s 后重试直到 worker 就绪。
 */
const CONFIG_FETCH_TIMEOUT_MS = 5000

/** 拉取后端配置（带超时 + 鉴权头，Cache-Control: no-store）。 */
async function fetchConfig(path: string): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CONFIG_FETCH_TIMEOUT_MS)
  try {
    return await fetch(path, {
      cache: 'no-store',
      headers: sessionHeaders({}),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

// ---- URL 构造器 -------------------------------------------------------------

/**
 * 拼绝对 URL 调后端 HTTP 端点（/api/*）。
 *
 * - Electron 模式：preload 经 contextBridge 注入 `window.__BACKEND_HTTP_URL__`
 *   （"http://localhost:<webPort>"）。渲染进程 file:// origin === "null"，相对路径
 *   fetch 直接挂；必须显式 base。
 * - 浏览器模式：无注入 → 空 base → 返回相对路径（与原 `fetch("/api/...")` 等价，
 *   Vite dev proxy / 生产同源 serve 直连）。
 * - 远端模式（auth store 配置非 loopback 服务地址）：前缀该地址。
 */
export function httpUrl(path: string): string {
  const auth = useAuthStore()
  if (auth.isRemote) return `${auth.getBaseUrl()}${path}`
  const base = typeof window !== 'undefined' ? (window.__BACKEND_HTTP_URL__ ?? '') : ''
  return `${base}${path}`
}

/**
 * 拼 WebSocket URL。分支：
 * - 远端模式：`ws(s)://<serverAddress host>:<wsPort>`
 * - Electron 模式（preload 注入 `__BACKEND_CONFIG__`）：`ws://localhost:<wsPort>`
 * - 浏览器 / dev（vite）：同源 `/ws` 走 vite proxy
 * - 浏览器 / prod（后端静态 serve）：`<ws/wss>://<host>:<wsPort>`
 */
export function wsUrl(cfg: ServerConfig): string {
  const auth = useAuthStore()
  if (auth.isRemote) {
    const base = auth.getBaseUrl()
    const scheme = base.startsWith('https:') ? 'wss' : 'ws'
    return `${scheme}://${hostOf(base)}:${cfg.wsPort}`
  }
  // Electron：直连 wsPort
  if (window.__BACKEND_CONFIG__) {
    return `ws://localhost:${cfg.wsPort}`
  }
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
  // dev:web（vite）：走同源 /ws（vite proxy 转 wsPort；跨机器访问只需暴露单端口 5173）
  if (import.meta.env.DEV) {
    return `${scheme}://${window.location.host}/ws`
  }
  // 生产（后端静态 serve）：直连 wsPort（8182 需对客户端开放）
  return `${scheme}://${window.location.hostname}:${cfg.wsPort}`
}

/**
 * 拼 HTTP 鉴权头：
 * - 远端已登录 → `Authorization: Bearer <accessToken>`
 * - 本地 → 沿用 `X-Chery-Session-Token`（本地 bootstrap 能力）
 *
 * 参数仅需 `sessionToken`（本地分支用）；传 `ServerConfig` 或
 * `ConfigDefault`（agentApi 的 /api/config 结果）均可。
 */
export function sessionHeaders(server: { sessionToken?: string }): Record<string, string> {
  const auth = useAuthStore()
  if (auth.isRemote) return auth.authHeader()
  return server.sessionToken ? { 'X-Chery-Session-Token': server.sessionToken } : {}
}

/**
 * 解析后端端口 + transport + 会话 token。
 *
 * - 远端模式：`fetch/httpUrl('/api/config')` 拉取目标后端配置（Electron short-circuit 不适用）
 * - Electron 模式：
 *   - 非 refresh：读 `window.__BACKEND_CONFIG__`（preload 注入快照，无需 fetch）
 *   - refresh：走 `window.__REFRESH_BACKEND_CONFIG__()`（main 进程 IPC fetch）——渲染进程
 *     直接 fetch /api/config 会被 CORS 拦截（后端响应无 Access-Control-Allow-Origin 头）
 * - 浏览器模式：`fetch('/api/config')` 获取 `wsPort + transport`（同源，vite proxy / 后端 serve 无 CORS）
 */
export async function getServerConfig(options: { refresh?: boolean } = {}): Promise<ServerConfig> {
  const auth = useAuthStore()
  // 远端：必须向目标后端拉取配置（Electron 本地 short-circuit 不适用）。
  // 远端需鉴权，附 Bearer token（本地分支 sessionHeaders 返回空 {}，靠后端 loopback 豁免）。
  if (auth.isRemote) {
    const res = await fetchConfig(httpUrl('/api/config'))
    if (!res.ok) throw new Error(`获取 /api/config 失败: ${res.status}`)
    return (await res.json()) as ServerConfig
  }
  // Electron：worker 重启会轮换本地 sessionToken，自动重连/手动重连必须经 main 进程 IPC
  // 刷新（渲染进程 fetch /api/config 被 CORS 拦截）；非 refresh 用 preload 注入快照。
  if (window.__BACKEND_CONFIG__) {
    if (options.refresh && window.__REFRESH_BACKEND_CONFIG__) {
      return await window.__REFRESH_BACKEND_CONFIG__()
    }
    return window.__BACKEND_CONFIG__
  }
  const res = await fetchConfig(httpUrl('/api/config'))
  if (!res.ok) throw new Error(`获取 /api/config 失败: ${res.status}`)
  return (await res.json()) as ServerConfig
}

/**
 * 选择目录（Electron 原生目录选择对话框，预设 workspace 字段用）。
 * - Electron 模式：调 preload 注入的 `window.__PICK_DIRECTORY__()`（main 进程 `dialog.showOpenDialog`）
 * - 浏览器模式：无原生能力 → 返回 null（调用方降级为纯文本框输入）
 */
export async function pickDirectory(): Promise<string | null> {
  if (!isElectron || !window.__PICK_DIRECTORY__) return null
  return window.__PICK_DIRECTORY__()
}
