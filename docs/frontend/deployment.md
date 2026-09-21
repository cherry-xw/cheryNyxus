# 前后端连接与部署模式

## 职责

本文档说明前端静态资源、独立后端、本地管理器、relay 和 Electron 壳之间的连接边界。后端永远独立编译和运行；Electron 只承载前端。

## 模式 1：独立后端与浏览器

```text
node dist/index.js
  ├─ HTTP：实际 web_port，提供 /api/config 和静态资源
  └─ WS：实际 port，提供控制连接
浏览器 → 后端 HTTP / 管理器发现结果 → 后端 WS
```

端口不是协议固定值。前端从同源 `/api/config` 或连接目标获得实际地址；本地管理器的固定入口只有 `127.0.0.1:39980`，不能通过 nginx、relay 或浏览器公网访问。

## 模式 2：纯前端 Electron

```text
Electron main/preload → 只提供窗口和桌面能力
渲染进程 → 127.0.0.1:39980/api/connection → 后端实际 HTTP /api/config
渲染进程 → 后端实际 HTTP 与 WS
```

Electron 不 spawn 后端、不等待后端、不打包后端 bundle、Node runtime 或 `.chery` 模板。后端应由用户单独启动，通常使用 manager CLI、Windows 托盘或 Linux systemd。

## 模式 3：relay 与远程后端

```text
本地后端 → rathole client → relay/rathole server
浏览器/Electron → relay 列表或已知连接目标 → 专用 HTTP/WS 入口
```

relay 只映射 CheryNyxus HTTP/WS 服务，不映射 `39980` 或任意本地端口。浏览器不获得本地真实业务端口；连接发现结果只提供专用入口和路径。

## 子路径

nginx 和 relay 必须保持同一公共前缀。HTTP API、WS Upgrade、Cookie Path、OIDC callback、静态资源 base 都由前端连接目标和后端转发头共同生成。模板见 [`deploy/nginx/cherynyxus.conf.template`](../../deploy/nginx/cherynyxus.conf.template)。真实 nginx、Pocket ID 和公网 relay 部署留到 H。

## 当前实现入口

| 能力 | 入口 |
| --- | --- |
| Electron 主进程 | [`web/electron/main.ts`](../../web/electron/main.ts) |
| Electron preload | [`web/electron/preload.ts`](../../web/electron/preload.ts) |
| HTTP/WS 地址发现 | [`web/src/services/platform.ts`](../../web/src/services/platform.ts) |
| WS 动态重连 | [`web/src/services/ws.ts`](../../web/src/services/ws.ts) |
| 本地管理器 | [`manager/src/server.ts`](../../manager/src/server.ts) |
| 服务安装入口 | [`manager/src/cli.ts`](../../manager/src/cli.ts) |

## 验证边界

自动检查使用 `pnpm web:type-check`、`pnpm web:build`、`pnpm manager:type-check`、`pnpm manager:build` 和 Electron 资源静态扫描。Electron 实机、托盘、systemd、真实 nginx、Pocket ID、rathole 公网联调和跨设备连接属于 H。
