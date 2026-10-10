# 独立后端运行

后端以独立 Node 进程运行。正式 Backend 的唯一常驻入口是 `apps/backend/src/index.ts` 构建出的 `node dist/index.js`：入口负责 guardian/worker 生命周期，worker 在启动服务前创建核心运行时并由 `startService()` 装配 WebSocket、HTTP 和 Ingress Plugin Host。Runtime QQPlugin 只能由该 Host 注入和启动，不单独运行 QQ 后端服务。开发环境可使用 `pnpm build` 后运行 `node dist/index.js`；正式环境由本地管理器、Docker 或 Linux systemd 启动。已删除的 Electron 壳不参与启动。

## Manager 登录与机器控制

本地管理器默认监听 `127.0.0.1:39980`，后端停止时仍可登录和管理。启动入口为 [`apps/manager/src/index.ts`](../../apps/manager/src/index.ts)，普通 API 分发为 `createManager`。独立 Manager 账号、Session、OIDC、可信访问地址和机器隔离规则只由 [Manager 认证协议](../shared/protocol/manager-auth.md) 定义；具体部署步骤见 [部署指南](relay-deployment.md)。

首次设置运行 `pnpm manager:dev auth setup`，恢复运行 `pnpm manager:dev auth reset`，均须本机交互终端隐藏输入密码。浏览器不再使用 URL token、header token、可读 token Cookie 或 localStorage，回环普通 API 也必须登录。机器密钥文件继续保留，仅给本机 CLI 使用，不打印秘密。

构建后运行 `node apps/manager/server-dist/index.js <命令>` 或 `pnpm manager:cli <命令>`：

```text
auth setup / auth reset       设置或恢复独立 Manager 账号
info / status                 从隔离的机器接口读取状态
start/stop/restart [backend|rathole]  控制 Manager 子进程（external 模式下 Backend 由部署工具管理）
service install / uninstall   安装或卸载本地服务入口
```

监听地址由 `manager.host` 配置，`CHERY_MANAGER_HOST` 优先。开放内网必须显式登记可信 origin；远程部署使用 HTTPS，反代信任也必须显式设置。不得用 rathole 映射 Manager 端口。

## 后端凭据与状态

登录后通过 `/api/credentials` 查看后端凭据、通过 `/api/credentials/rotate` 更新。这是后端账号，不是 Manager 账号；后端凭据仍在 `.chery/manager-credentials.json`（Unix 0600），后端配置只保存 scrypt 哈希。轮换后仅重启 Manager 自己的子进程；外部启动的后端不拉起副本。随后执行 challenge/login 自检，明确区分 verified、unreachable 和 stale，不把保存成功等同于后端已生效。

`/api/status` 与 `/api/connection` 展示 Manager、后端和 rathole 状态。后端检测读取状态文件并探测实际配置端口；文件和端口只提供运行摘要，不包含认证秘密。Manager 本身的登录、进程控制和凭据保存不依赖后端在线。

自动回归运行 `pnpm manager:test`，HTTP/OIDC 与入口测试在 [`apps/manager/test/`](../../apps/manager/test)，辅助函数回归在 [`apps/manager/test/server.test.ts`](../../apps/manager/test/server.test.ts)。真实 OIDC、跨设备访问、Linux systemd 和 Windows 托盘行为留给最终环境验证；不以构建通过代替部署证据。
