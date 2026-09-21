# Web 端环境抽象层（platform.ts）

> 源码 [web/src/services/platform.ts](../../web/src/services/platform.ts) ｜ 上级 [README.md](README.md) ｜ 相关 [./electron.md](electron.md)、[./deployment.md](deployment.md)

## 职责

封装渲染进程运行在哪种容器、后端连接目标是什么、HTTP/WS 地址如何生成。纯前端 Electron 不注入后端端口；连接目标由本地管理器、直连地址或 relay 发现提供。

## 导出 API

```ts
export const isElectron: boolean
export interface ServerConfig {
  wsPort: number
  webPort: number
  transport: 'binary' | 'json'
  sessionToken?: string
  backendId?: string
  httpBasePath?: string
  wsPath?: string
  httpBaseUrl?: string
  wsUrl?: string
}
export function httpUrl(path: string): string
export function wsUrl(config: ServerConfig): string
export async function getServerConfig(options?: { refresh?: boolean }): Promise<ServerConfig>
export function clearManagedBackendDiscovery(): void
```

## 本地管理器发现

纯前端 Electron 在没有旧版 `__BACKEND_CONFIG__` 和 `__BACKEND_HTTP_URL__` 时，先访问固定的本机管理器：

```text
GET http://127.0.0.1:39980/api/connection
  → backendListener.addresses.local.httpPort
GET http://127.0.0.1:<实际端口>/api/config
```

管理器只绑定 loopback，不能通过 relay 或 nginx 访问。发现结果只用于连接本机后端，不提供 Backend ID 选择界面。

`getServerConfig({ refresh: true })` 会先调用 `clearManagedBackendDiscovery()`，再重新读取管理器状态和后端 `/api/config`。后端重启、session token 轮换或动态端口变化后的自动/手动重连必须使用 refresh。

## HTTP 与 WS 地址

- 远端登录模式使用认证服务保存的目标地址和访问 token。
- 纯前端 Electron 使用管理器发现的 HTTP 地址和 `/api/config` 返回的 WS 信息。
- 浏览器开发模式使用同源 `/ws` 代理。
- 浏览器生产模式使用后端发现的 WS 端口或公共路径。
- `httpBasePath`、`wsPath`、`httpBaseUrl` 和 `wsUrl` 优先于默认端口拼接，用于 relay 和子路径部署。

渲染业务不得直接读取 preload 全局；统一使用 `platform.ts` 的 `httpUrl()`、`wsUrl()` 和 `getServerConfig()`。

## 会话 token 与重连

本地 `sessionToken` 是后端 loopback WebSocket 的短期能力，worker 重启时会轮换。`ws.ts` 在重连前调用 `getServerConfig({ refresh: true })`，确保不会继续发送旧 token 或旧端口。配置请求带 5 秒超时，失败后由 WS 客户端按既有退避时间重试。

## 关联模块

- [`web/src/services/ws.ts`](../../web/src/services/ws.ts)：消费动态 WS 地址并处理 refresh/reconnect。
- [`web/src/services/http.ts`](../../web/src/services/http.ts)：保留 `httpUrl` 转发入口。
- [`manager/src/server.ts`](../../manager/src/server.ts)：提供本地连接发现。
- [`docs/frontend/electron.md`](electron.md)：说明 Electron 纯前端壳边界。
