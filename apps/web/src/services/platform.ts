/**
 * Browser HTTP/WS address construction and backend config discovery.
 *
 * 详细：[docs/frontend/env.md](../../../docs/frontend/env.md)
 */

import { serviceAuth } from './authContext'

/** Backend connection fields returned by `/api/config`. */
export interface ServerConfig {
  wsPort: number
  webPort: number
  transport: 'binary' | 'json'
  /** Ephemeral local capability required by the backend WebSocket control plane. */
  sessionToken?: string
  backendId?: string
  httpBasePath?: string
  wsPath?: string
  httpBaseUrl?: string
  wsUrl?: string
}

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
      credentials: 'include',
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
 * - 浏览器本地模式：返回同源相对路径（Vite dev proxy / 后端静态服务）。
 * - 远端模式（auth store 配置非 loopback 服务地址）：前缀该地址。
 */
export function httpUrl(path: string): string {
  const auth = serviceAuth()
  if (auth.isRemote()) return `${auth.baseUrl().replace(/\/$/, '')}${path}`
  return path
}

/**
 * 拼 WebSocket URL。分支：
 * - 远端模式：`ws(s)://<serverAddress host><wsPath>`（wsPath 缺省时回退 `<wsPort>`）。
 *   注意不能消费 `/api/config` 返回的 `cfg.wsUrl`：那是后端按它收到的本机请求 Host 生成的
 *   （如 `ws://localhost:8182`），对远端浏览器指向的是浏览器自己那台机器，必然连不上。
 * - 浏览器 / dev（vite）：同源 `/ws` 走 vite proxy
 * - 浏览器 / prod（后端静态 serve）：`<ws/wss>://<host>:<wsPort>`
 */
export function wsUrl(cfg: ServerConfig): string {
  const auth = serviceAuth()
  if (auth.isRemote()) {
    // 远端访问：WS 必须跟随用户填写的地址主机——/api 能通、同源 /ws 就能通
    // （Vite 代理与后端 Web 源都提供 /ws）。
    if (cfg.wsPath) {
      const base = new URL(auth.baseUrl())
      const scheme = base.protocol === 'https:' ? 'wss:' : 'ws:'
      const prefix = base.pathname.replace(/\/$/, '')
      return `${scheme}//${base.host}${prefix}${cfg.wsPath.startsWith('/') ? cfg.wsPath : `/${cfg.wsPath}`}`
    }
    const base = new URL(auth.baseUrl())
    const scheme = base.protocol === 'https:' ? 'wss:' : 'ws:'
    // 用 hostname：地址可能带端口（如 http://192.168.68.164:8183），直接拼 host 会得到
    // "ws://192.168.68.164:8183:8182" 这种双端口 URL。
    return `${scheme}//${base.hostname}:${cfg.wsPort}`
  }
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
  // dev:web（vite）：走同源 /ws（vite proxy 转 wsPort；跨机器访问只需暴露单端口 5173）
  if (import.meta.env.DEV) {
    return `${scheme}://${window.location.host}/ws`
  }
  // 生产（后端静态 serve）优先使用后端按当前请求生成的完整地址。
  // 开发模式必须在上面优先走 Vite 代理，否则 /api 代理的 Host 会让后端返回
  // ws://localhost:<port>，局域网浏览器会错误地连接到浏览器所在机器。
  if (cfg.wsUrl) return cfg.wsUrl
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
  const auth = serviceAuth()
  if (auth.isRemote()) return auth.headers()
  return server.sessionToken ? { 'X-Chery-Session-Token': server.sessionToken } : {}
}

/**
 * 解析后端端口 + transport + 会话 token。
 *
 * Browser config is read from the selected remote target or the same-origin backend.
 */
export async function getServerConfig(_options: { refresh?: boolean } = {}): Promise<ServerConfig> {
  const auth = serviceAuth()
  // 远端：必须向目标后端拉取配置。
  // 远端需鉴权，附 Bearer token（本地分支 sessionHeaders 返回空 {}，靠后端 loopback 豁免）。
  if (auth.isRemote()) {
    const res = await fetchConfig(httpUrl('/api/config'))
    if (!res.ok) throw new Error(`获取 /api/config 失败: ${res.status}`)
    return (await res.json()) as ServerConfig
  }
  const res = await fetchConfig(httpUrl('/api/config'))
  if (!res.ok) throw new Error(`获取 /api/config 失败: ${res.status}`)
  return (await res.json()) as ServerConfig
}
