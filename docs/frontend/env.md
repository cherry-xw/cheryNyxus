# 浏览器连接与地址构造

> 实现入口：[platform.ts](../../web/src/services/platform.ts)；部署边界见[部署说明](deployment.md)。

浏览器通过当前站点或已保存的远端服务地址获取 `/api/config`。`httpUrl()` 为本地同源请求保留相对路径，远端请求使用已选目标地址；`wsUrl()` 优先使用服务提供的公开 WebSocket 地址或路径，并在开发环境使用同源 `/ws`。远端认证头来自登录状态，本地 WebSocket 使用 `/api/config` 提供的短期 `sessionToken`。

`getServerConfig({ refresh: true })` 在重连时重新读取配置；请求超时后由 [ws.ts](../../web/src/services/ws.ts) 的重连流程重试。本地管理器是独立的服务管理入口，其控制接口与浏览器业务连接互不混用。连接目标的选择和登录优先改造见[进行中的计划](../plan/login-first-capabilities/README.md)。

验证：`pnpm web:type-check`、`pnpm web:build`；HTTP/WS 路径和重连由相应前端测试验证，真实连接由用户人工复核。
