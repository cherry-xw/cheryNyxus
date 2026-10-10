# 独立后端与中转部署

## 进程

公网主机运行 relay 和 rathole server；用户本地运行 CheryNyxus 后端、本地管理器和 rathole client。Electron 安装包只包含前端，不包含后端、Node runtime 或 `.chery` 模板。

## Relay

设置至少 32 字节的 `RELAY_SESSION_SECRET`，再运行：

```bash
pnpm relay:build
RELAY_SESSION_SECRET='change-this-to-a-random-secret-of-32-bytes-or-more' pnpm relay:start
```

生产环境用 HTTPS/WSS 终止 TLS，并让 nginx 按 [`deployment/nginx/cherynyxus.conf.template`](../../deployment/nginx/cherynyxus.conf.template) 同时提供静态前端、`/api/` 和 `/backend/` WebSocket 路由。公共前缀必须与 relay 的 `RELAY_PUBLIC_BASE_PATH` 相同。管理器 `39980` 和 rathole 两个私有服务映射不得通过 nginx 暴露。

## 本地管理器

```bash
pnpm manager:type-check
pnpm exec vite build --config apps/manager/vite.config.ts
node apps/manager/server-dist/index.js auth setup
node apps/manager/server-dist/index.js
```

管理器默认只绑定 `127.0.0.1:39980`；`manager.host` 或优先级更高的 `CHERY_MANAGER_HOST` 可改变监听地址。首次设置及恢复账号必须使用本机交互终端：`auth setup` / `auth reset`，隐藏输入密码，不传密码参数。浏览器使用 Manager 自身账号或显式配置的 OIDC，不使用启动 URL 密钥。开放局域网或 HTTPS 反代前，必须配置 `manager.auth.trustedOrigins`；反代另需 `trustedProxies` 并覆盖转发头。配置、会话、CSRF、OIDC 和机器接口规则见唯一权威说明 [Manager 认证](../shared/protocol/manager-auth.md)。OIDC 的真实 issuer/clientId/clientSecret/redirectUri/adminSubjects 由部署者提供，空名单禁用，不能猜值。

原 `.chery/manager-token.json` 和 `CHERY_MANAGER_TOKEN` 只用于本机机器 CLI，不删除密钥文件、不再用于页面。`node apps/manager/server-dist/index.js status`、`info`、`start/stop/restart [backend|rathole]` 自动读取机器密钥，不能管理浏览器会话或后端凭据。Manager 重启使浏览器会话失效；变更认证配置后必须重启。

Linux unit 模板见 [`apps/manager/deploy/systemd/cherynyxus-manager.service`](../../apps/manager/deploy/systemd/cherynyxus-manager.service)，构建后可用 `node apps/manager/server-dist/index.js service install` 安装用户级 systemd 服务；卸载为 `service uninstall`。Windows 使用同一入口，实际脚本是 [`apps/manager/deploy/windows/service.ps1`](../../apps/manager/deploy/windows/service.ps1) 和 [`apps/manager/deploy/windows/tray-manager.ps1`](../../apps/manager/deploy/windows/tray-manager.ps1)。托盘只打开普通登录页，不保存机器密钥。Windows 部署者需限制 `.chery` 的 ACL。真实 OIDC、托盘、systemd 与 HTTPS 部署仍需最终环境验证，构建或 mock 测试不等于已部署。

## Rathole

A 阶段和 B 阶段的配置生成器只生成 `chery_http` 与 `chery_ws` 两项服务。客户端 `local_addr` 指向后端 HTTP/WS 端口，服务器端 `bind_addr` 必须是中转机 `127.0.0.1` 地址，供 relay 访问；不要加入 `39980` 或其他本地端口。

真实二进制版本、下载校验和、Pocket ID client、Windows 托盘和 Linux systemd 的机器级操作仍需在最终验收环境按发布版本补齐，不能用开发机路径替代。
