# 浏览器前端与独立后端部署

## 连接边界

浏览器由后端静态服务或开发期 Vite 提供页面，同源 `/api/config` 给出实际服务连接信息；后端独立编译、运行，管理器及其 Windows 托盘/Linux systemd 负责本地后端生命周期。浏览器多窗口由工作区组件管理，不启动本机进程。

远端部署中，后端经 rathole 接入 relay，浏览器从已知连接目标访问专用 HTTP/WS 入口。relay 只转发业务服务，不映射管理器端口 `39980`。反向代理部署时，HTTP API、WS 升级、Cookie Path、OIDC callback 和静态资源需使用同一公共前缀；模板见 [`deployment/nginx/cherynyxus.conf.template`](../../deployment/nginx/cherynyxus.conf.template)。服务选择与跨端登录方案见[登录、发现与转发](../shared/architecture/authentication-flows.md)。

## 同源交付代理

`createWebServer`只连接固定上游。公开basePath由部署显式给出；HTTP保留路径和query，WS映射固定上游路径并保留ticket及Lite参数。拒绝错前缀、重复参数和未知WS参数，不记录票据。静态壳不依赖Backend就绪。业务验收必须经过真实HTTP/WS转发而不是只检查101。

## 实现与验证

- 浏览器入口：[main.ts](../../apps/web/src/main.ts)、[App.vue](../../apps/web/src/App.vue)。
- HTTP/WS 地址与重连：[platform.ts](../../apps/web/src/services/platform.ts)、[ws.ts](../../apps/web/src/services/ws.ts)。
- 本地管理器：[server.ts](../../apps/manager/src/server.ts)、[cli.ts](../../apps/manager/src/cli.ts)。
- 自动检查：`pnpm web:type-check`、`pnpm web:build`、`pnpm manager:type-check`、`pnpm manager:build`。真实 nginx、relay、跨设备及本地托盘交互由用户人工复核。
