# HTTP 服务模块

> 源码 [src/service/http/index.ts](../../src/service/http/index.ts) ｜ 上级 [service/README.md](./README.md) ｜ 相关 [../protocol.md](../protocol.md)「HTTP API」、[./websocket.md](./websocket.md)

## 职责

HTTP 静态服务 + 配置端点,与 WebSocket server 同进程启动(分端口):

- `GET /api/config` → 返回 `{wsPort, webPort, transport}`,供前端自动构建 WS 连接地址(无需硬编码端口)
- `POST /api/media/upload` / `GET /api/media/:filename` → 上传和读取 `.chery/media/` 下的受控媒体资产
- 其余路径 → 默认静态 serve 前端构建产物(`web/dist/`),SPA fallback 到 `index.html`
- `server.serve_frontend=false` 或 `web/dist/` 缺失时 → 仅 serve `/api/*`；其他路径返回 JSON 404 提示

服务端口 `config.server.web_port`(默认 8183),与 WS 端口 `config.server.port`(8182)分离,避免 WS upgrade 重构。

启用 `server.auth.enabled` 时，静态 SPA 仍可加载以显示登录遮罩，但 `GET /api/config` 及 WebSocket 控制面必须
有 OAuth2 登录后的 HttpOnly 会话。认证端点为 `GET /api/auth/me`、`GET /api/auth/login`、
`GET /api/auth/callback`、`POST /api/auth/logout`；仅服务端 OAuth2 callback 交换 token，浏览器不接触 client secret。

**密码认证（`server.auth.username`+`password`）** 走另一组端点，凭据不落明文：前端先 `POST /api/auth/challenge`
取一次性 `nonce`，用它作为 keyHex 经 SHA-256 CTR 流密码加密 `{username, password}` 信封后 `POST /api/auth/login`
提交 `{challengeId, cipher}`；后端解密后按 scrypt 校验。规范见 [docs/protocol.md](../protocol.md)「认证」段。

## 静态托管开关

`server.serve_frontend`（默认 `true`）+ 可选 `server.static_dir_override` 控制 HTTP 服务是否同时托管前端 SPA。典型场景：

- **开发产物已构建**（`pnpm web:build` 输出 `web/dist/`）：`serve_frontend: true`（默认）+ 不设 `static_dir_override` → HTTP 服务 serve `web/dist/`，SPA fallback 到 `index.html`
- **反向代理（nginx/caddy）已托管 SPA**：`serve_frontend: false` → HTTP 服务仅 serve `/api/*`；其他路径返回 JSON 404
- **独立部署把 `dist/` 拷到 `/opt/chery/dist`**：`serve_frontend: true` + `static_dir_override: /opt/chery/dist` → HTTP 服务 serve 该目录
- **容器/CI 一键脚本**：`serve_frontend: true` + 不设 `static_dir_override`，但设环境变量 `WEB_DIST_DIR=/path` → worker 读取 env，覆盖默认

**为什么需要同源托管**：浏览器场景下，登录 cookie（HttpOnly）由后端通过同 origin 颁发。如前端走 vite dev（`:5173`）而后端在 `:8183`，浏览器会因端口不同视为跨域，OAuth 登录与 HttpOnly cookie 无法落定（开发期也会触发 CORS preflight）。开启 `serve_frontend` 让浏览器访问 `:8183` 同时拿到 UI 与 API，绕过跨域。

`server.serve_frontend=true` 但目录缺失时，worker 与 HTTP 服务都会 logger.warn，但**不会阻塞启动**（仅 API 模式生效），便于先启后端再补构建的反模式。

## 文件清单

| 文件 | 一句话 |
|------|--------|
| [src/service/http/index.ts](../../src/service/http/index.ts) | `createHttpServer({webPort, staticDir})`:http.createServer + /api/config + 静态 serve + SPA fallback |

## 核心导出

```ts
export interface CreateHttpServerOptions {
  webPort: number;
  staticDir: string;
}
export function createHttpServer(options: CreateHttpServerOptions): Server;
```

返回 `http.Server`,供 [src/index.ts](../../src/index.ts) 优雅关闭(`httpServer.close()`)。

## 关键流程

```
createHttpServer({webPort, staticDir})
  ├─ root = resolve(staticDir); 若不存在 → logger.info 提示（serve 时 404）
  ├─ server = http.createServer((req,res) => handleRequest(req,res,root))
  ├─ server.listen(webPort)
  └─ logger.info 端口 + 静态目录

handleRequest:
  url === "/api/config"?
    ├─ 是 → 200 {wsPort: config.server.port, webPort: config.server.web_port, transport: config.server.transport}
    └─ 否 → 静态 serve:
         ├─ pathname = decodeURIComponent(url.split("?")[0])
         ├─ safe = normalize(pathname).replace(/^(\.\.[/\\])+/, "")  // 防越界
         ├─ filePath = join(root, safe); startsWith(root)? 否 → 403
         ├─ stat(filePath).isFile()? → 200 + MIME + readFile
         └─ 否 → SPA fallback: readFile(index.html) 成功 → 200 text/html;否则 404
```

MIME 映射:自写 `Record<string, string>`(html/js/css/json/svg/png/...),无新依赖。

## 媒体资产 API

媒体端点使用与控制面相同的认证：OAuth 开启时要求 HttpOnly 会话；本地 session-token 模式要求 `X-Chery-Session-Token`。`POST /api/media/upload` 接受原始二进制 body，`Content-Type` 是媒体 MIME、`X-Filename` 是原始文件名；成功返回资产元数据与 `/api/media/<filename>`。只允许图片、视频、音频白名单 MIME，大小由 `media.maxUploadMb`（默认 100 MiB）限制。`GET /api/media/:filename` 校验 UUID 文件名并返回 `private` 缓存响应。完整网关处理见 [../model-capabilities.md](../model-capabilities.md)。

## 前端调用路径与 httpUrl helper（Electron 模式）

`/api/*`（`/api/config`、`/api/media/upload`、`/api/media/:filename`、`/api/auth/me` 等）在浏览器模式下走同源相对路径直连本服务端口（8183）；在 Electron `file://` 加载下，`window.location.origin === "null"`，相对路径失败，必须显式 base URL。

约定：Electron main 进程在 `waitForBackend` 就绪后经 [preload](../web/electron.md#preload-注入配置) `contextBridge.exposeInMainWorld("__BACKEND_HTTP_URL__", ...)` 同步注入 `http://localhost:<webPort>`。前端统一用 `httpUrl(path)` helper：

```ts
// web/src/services/http.ts
export function httpUrl(path: string): string {
  // window.__BACKEND_HTTP_URL__ 由 Electron preload 注入；浏览器模式不存在 → 走空串（相对路径）
  const base = (globalThis as { __BACKEND_HTTP_URL__?: string }).__BACKEND_HTTP_URL__ ?? "";
  return `${base}${path}`;
}
```

使用范围：所有 `/api/*` HTTP 调用（`fetch` 入口）；WS 连接仍走 [./websocket.md](./websocket.md) 自身逻辑（preload `__BACKEND_CONFIG__`）。具体替换：

| 文件 | 调用点 |
|------|------|
| [web/src/App.vue](../../web/src/App.vue) | `fetch(httpUrl("/api/auth/me"), ...)`、`window.location.assign(httpUrl("/api/auth/login?returnTo=..."))` |
| [web/src/services/agentApi.ts](../../web/src/services/agentApi.ts) | `fetch(httpUrl("/api/config"))`、`fetch(httpUrl("/api/media/upload"), ...)` |
| [web/src/services/ws.ts](../../web/src/services/ws.ts) | `fetch(httpUrl("/api/config"))`（Electron 模式仅 wsPort，无 base URL 需求；保留相对路径作 dev:web fallback） |

## 依赖与关联 ⭐

- **依赖**:`config`(`config.server` 读端口 + transport,见 [utils/config.ts](../../src/utils/config.ts))、`logger`(启动 + 错误日志,见 [utils/logger.md](../utils/logger.md))。无第三方 dep(纯 `node:http` + `node:fs`)。
- **被依赖**:仅 [src/service/index.ts](../../src/service/index.ts) `startService` 调用,与 `createWebSocketServer` 同进程启动。
- **协议规范**:[../protocol.md](../protocol.md)「HTTP API」段定义 `/api/config` 响应结构。
- **关联模式**:[docs/web/deployment.md](../web/deployment.md) 模式 3(Web 浏览器)由此模块 serve 前端;模式 2(Electron)前端 `loadFile` 不依赖此模块,但 main `waitForBackend` 轮询 `/api/config` 确认后端就绪。
- **关联文档**:[../web/electron.md#preload-注入配置](../web/electron.md#preload-注入配置) 描述 `__BACKEND_HTTP_URL__` 注入。

## 扩展点

- **CORS**:当前不带跨域头(浏览器模式同源,Electron 模式 preload 注入不走 fetch)。若前端跨域访问 `/api/config`,在 `handleRequest` 加 `Access-Control-Allow-Origin`。
- **mime 扩展**:`MIME` map 加新扩展名。
- **SPA fallback**:`createWebHashHistory` 下所有未知路径回 `index.html`;若改 `createWebHistory` 需保证 fallback 覆盖所有路由。
- **静态目录来源**:`startService` 调用方决定 `staticDir`([src/index.ts](../../src/index.ts) 默认 `../web/dist`,或 `WEB_DIST_DIR` env 覆盖,打包时由 Electron main 注入)。
