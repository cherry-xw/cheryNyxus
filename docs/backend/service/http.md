# HTTP 服务模块

> 源码 [src/service/http/index.ts](../../../src/service/http/index.ts) ｜ 上级 [service/README.md](README.md) ｜ 相关 [../protocol.md](../../shared/protocol/websocket.md)「HTTP API」、[./websocket.md](websocket.md)

## 职责

HTTP 静态服务 + 配置端点,与 WebSocket server 同进程启动(分端口):

- `GET /api/config` → 本地返回旧端口字段以及 `httpBaseUrl`、`wsUrl`、`httpPath`、`wsPath`；远程专用入口只返回 `remote`、路径和传输格式，不泄露 loopback 端口
- `GET /api/auth/capabilities` → 返回非敏感的 `{password, oidc}` 登录能力；密码失败冷却由 challenge 和 login 同时执行
- `POST /api/media/upload` / `GET /api/media/:filename` → 上传和读取 `.chery/media/` 下的受控媒体资产
- 其余路径 → 默认静态 serve 前端构建产物(`web/dist/`),SPA fallback 到 `index.html`
- `server.serve_frontend=false` 或 `web/dist/` 缺失时 → 仅 serve `/api/*`；其他路径返回 JSON 404 提示

本地服务端口由 `config.server.webPort`（默认 8183）和 `config.server.port`（默认 8182）配置；可选的
`config.server.remote` 会额外创建两个仅绑定 `127.0.0.1` 的远程专用入口，端口为 `0` 时由系统动态分配。
远程入口只供 rathole 连接，始终要求用户认证，不能继承本地 loopback 豁免。

启用 `server.auth.enabled` 时，静态 SPA 仍可加载以显示登录遮罩，但 `GET /api/config` 及 WebSocket 控制面必须
有 OAuth2 登录后的 HttpOnly 会话。认证端点为 `GET /api/auth/me`、`GET /api/auth/login`、
`GET /api/auth/callback`、`POST /api/auth/logout`；仅服务端 OAuth2 callback 交换 token，浏览器不接触 client secret。

**密码认证（`server.auth.username`+`password`）** 走另一组端点，凭据不落明文：前端先 `POST /api/auth/challenge`
取一次性 `nonce`，用它作为 keyHex 经 SHA-256 CTR 流密码加密 `{username, password}` 信封后 `POST /api/auth/login`
提交 `{challengeId, cipher}`；后端解密后按 scrypt 校验。规范见 [docs/shared/protocol/websocket.md](../../shared/protocol/websocket.md)「认证」段。

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
| [src/service/http/index.ts](../../../src/service/http/index.ts) | `createHttpServer({webPort, staticDir})`:http.createServer + /api/config + 静态 serve + SPA fallback |

## 核心导出

```ts
export interface CreateHttpServerOptions {
  webPort: number;
  staticDir: string;
}
export function createHttpServer(options: CreateHttpServerOptions): Server;
```

返回 `http.Server`,供 [src/index.ts](../../../src/index.ts) 优雅关闭(`httpServer.close()`)。

## 关键流程

```
createHttpServer({webPort, staticDir})
  ├─ root = resolve(staticDir); 若不存在 → logger.info 提示（serve 时 404）
  ├─ server = http.createServer((req,res) => handleRequest(req,res,root))
  ├─ server.listen(webPort)
  ├─ server.on("error"): EADDRINUSE → reportFatalStartupError({code, port})（端口占用，guardian 停止重试）
  └─ logger.info 端口 + 静态目录

handleRequest:
  url === "/api/config"?
     ├─ 是 → 本地返回端口和完整地址；远程入口只返回 remote、控制面路径和传输格式
    └─ 否 → 静态 serve:
         ├─ pathname = decodeURIComponent(url.split("?")[0])
         ├─ safe = normalize(pathname).replace(/^(\.\.[/\\])+/, "")  // 防越界
         ├─ filePath = join(root, safe); startsWith(root)? 否 → 403
         ├─ stat(filePath).isFile()? → 200 + MIME + readFile
         └─ 否 → SPA fallback: readFile(index.html) 成功 → 200 text/html;否则 404
```

MIME 映射:自写 `Record<string, string>`(html/js/css/json/svg/png/...),无新依赖。

## 媒体资产 API

媒体端点使用与控制面相同的认证：OAuth 开启时要求 HttpOnly 会话；本地 session-token 模式要求 `X-Chery-Session-Token`。`POST /api/media/upload` 接受原始二进制 body，`Content-Type` 是媒体 MIME、`X-Filename` 是原始文件名；成功返回资产元数据与 `/api/media/<filename>`。只允许图片、视频、音频白名单 MIME，大小由全局上传上限限制（默认 100 MiB）。`GET /api/media/:filename` 校验 UUID 文件名并返回 `private` 缓存响应。媒体资产链路见 [../model-capabilities.md](../agent/model-capabilities.md)。

## 前端调用路径与 httpUrl helper

`/api/*`（`/api/config`、`/api/media/upload`、`/api/media/:filename`、`/api/auth/me` 等）在浏览器本地模式走同源相对路径；已选远端目标则经认证状态中的服务地址构造请求 URL。

前端统一用 [platform.ts](../../../web/src/services/platform.ts) 的 `httpUrl(path)` 与 `getServerConfig()`；浏览器和后端通过同源部署避免跨域配置请求。

HTTP 请求使用 `httpUrl()`；WebSocket 配置由 [ws.ts](../../../web/src/services/ws.ts) 调用 `getServerConfig()` 并构造地址。详情见[浏览器连接](../../frontend/env.md)。

## 依赖与关联 ⭐

- **依赖**:`config`(`config.server` 读端口 + transport,见 [utils/config.ts](../../../src/utils/config.ts))、`logger`(启动 + 错误日志,见 [utils/logger.md](../utils/logger.md))。无第三方 dep(纯 `node:http` + `node:fs`)。
- **被依赖**:仅 [src/service/index.ts](../../../src/service/index.ts) `startService` 调用,与 `createWebSocketServer` 同进程启动。
- **协议规范**:[../protocol.md](../../shared/protocol/websocket.md)「HTTP API」段定义 `/api/config` 响应结构。
- **关联模式**:[部署说明](../../frontend/deployment.md)解释浏览器、独立后端与 relay 的边界。

## 扩展点

- **CORS**:当前浏览器同源请求不带跨域头；如需跨域访问 `/api/config`，须先明确认证与跨域边界。
- **mime 扩展**:`MIME` map 加新扩展名。
- **SPA fallback**:`createWebHashHistory` 下所有未知路径回 `index.html`;若改 `createWebHistory` 需保证 fallback 覆盖所有路由。
- **静态目录来源**:`startService` 调用方决定 `staticDir`([src/index.ts](../../../src/index.ts) 默认 `../web/dist`,或 `WEB_DIST_DIR` env 覆盖,打包时由 Electron main 注入)。
