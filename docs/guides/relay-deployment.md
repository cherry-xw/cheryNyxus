# 独立后端与中转部署

## 进程

公网主机运行 relay 和 rathole server；用户本地运行 CheryNyxus 后端、本地管理器和 rathole client。Electron 安装包只包含前端，不包含后端、Node runtime 或 `.chery` 模板。

## Relay

设置至少 32 字节的 `RELAY_SESSION_SECRET`，再运行：

```bash
pnpm relay:build
RELAY_SESSION_SECRET='change-this-to-a-random-secret-of-32-bytes-or-more' pnpm relay:start
```

生产环境用 HTTPS/WSS 终止 TLS，并让 nginx 按 [`deploy/nginx/cherynyxus.conf.template`](../../deploy/nginx/cherynyxus.conf.template) 同时提供静态前端、`/api/` 和 `/backend/` WebSocket 路由。公共前缀必须与 relay 的 `RELAY_PUBLIC_BASE_PATH` 相同。管理器 `39980` 和 rathole 两个私有服务映射不得通过 nginx 暴露。

## 本地管理器

```bash
pnpm manager:type-check
pnpm exec vite build --config manager/vite.config.ts
CHERY_MANAGER_TOKEN='another-local-secret' node manager/dist/index.js
```

管理器默认只绑定 `127.0.0.1:39980`；设置 `CHERY_MANAGER_HOST`（如 `0.0.0.0`）可开放内网访问，访问需携带启动日志 URL 上的管理密钥（URL `?token=` 或 `X-Chery-Manager-Token` 请求头），未设置 `CHERY_MANAGER_TOKEN` 时密钥自动生成。启动、停止和重启接口始终要求管理密钥。Linux unit 模板见 [`deploy/systemd/cherynyxus-manager.service`](../../deploy/systemd/cherynyxus-manager.service)，构建后可用 `node manager/dist/index.js service install` 安装用户级 systemd 服务；卸载使用同一命令的 `service uninstall`。Windows 使用 `node manager/dist/index.js service install`，实际入口是 [`deploy/windows/service.ps1`](../../deploy/windows/service.ps1) 和 [`deploy/windows/tray-manager.ps1`](../../deploy/windows/tray-manager.ps1)。托盘和 systemd 的真实机器行为留到 H。

## Rathole

A 阶段和 B 阶段的配置生成器只生成 `chery_http` 与 `chery_ws` 两项服务。客户端 `local_addr` 指向后端 HTTP/WS 端口，服务器端 `bind_addr` 必须是中转机 `127.0.0.1` 地址，供 relay 访问；不要加入 `39980` 或其他本地端口。

真实二进制版本、下载校验和、Pocket ID client、Windows 托盘和 Linux systemd 的机器级操作仍需在最终验收环境按发布版本补齐，不能用开发机路径替代。
