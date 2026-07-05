# HTTP 服务模块

> 源码 [src/service/http/index.ts](../../src/service/http/index.ts) ｜ 上级 [service/README.md](./README.md) ｜ 相关 [../protocol.md](../protocol.md)「HTTP API」、[./websocket.md](./websocket.md)

## 职责

HTTP 静态服务 + 配置端点,与 WebSocket server 同进程启动(分端口):

- `GET /api/config` → 返回 `{wsPort, webPort, transport}`,供前端自动构建 WS 连接地址(无需硬编码端口)
- 其余路径 → 静态 serve 前端构建产物(`web/dist/`),SPA fallback 到 `index.html`

服务端口 `config.server.web_port`(默认 8183),与 WS 端口 `config.server.port`(8182)分离,避免 WS upgrade 重构。

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

## 依赖与关联 ⭐

- **依赖**:`config`(`config.server` 读端口 + transport,见 [utils/config.ts](../../src/utils/config.ts))、`logger`(启动 + 错误日志,见 [utils/logger.md](../utils/logger.md))。无第三方 dep(纯 `node:http` + `node:fs`)。
- **被依赖**:仅 [src/service/index.ts](../../src/service/index.ts) `startService` 调用,与 `createWebSocketServer` 同进程启动。
- **协议规范**:[../protocol.md](../protocol.md)「HTTP API」段定义 `/api/config` 响应结构。
- **关联模式**:[docs/web/deployment.md](../web/deployment.md) 模式 3(Web 浏览器)由此模块 serve 前端;模式 2(Electron)前端 `loadFile` 不依赖此模块,但 main `waitForBackend` 轮询 `/api/config` 确认后端就绪。

## 扩展点

- **CORS**:当前不带跨域头(浏览器模式同源,Electron 模式 preload 注入不走 fetch)。若前端跨域访问 `/api/config`,在 `handleRequest` 加 `Access-Control-Allow-Origin`。
- **mime 扩展**:`MIME` map 加新扩展名。
- **SPA fallback**:`createWebHashHistory` 下所有未知路径回 `index.html`;若改 `createWebHistory` 需保证 fallback 覆盖所有路由。
- **静态目录来源**:`startService` 调用方决定 `staticDir`([src/index.ts](../../src/index.ts) 默认 `../web/dist`,或 `WEB_DIST_DIR` env 覆盖,打包时由 Electron main 注入)。
