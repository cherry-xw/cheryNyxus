# 浏览器连接与地址构造

> 实现入口：[platform.ts](../../apps/web/src/services/platform.ts)；部署边界见[部署说明](deployment.md)。

浏览器通过当前站点或已保存的远端服务地址获取 `/api/config`。`httpUrl()` 为本地同源请求保留相对路径，远端请求使用已选目标地址；`wsUrl()` 优先使用服务提供的公开 WebSocket 地址或路径，并在开发环境使用同源 `/ws`。远端认证头来自登录状态，本地 WebSocket 使用 `/api/config` 提供的短期 `sessionToken`。

`getServerConfig({ refresh: true })` 在重连时重新读取配置；请求超时后由 [ws.ts](../../apps/web/src/services/ws.ts) 的重连流程重试。本地管理器是独立的服务管理入口，其控制接口与浏览器业务连接互不混用。连接目标的选择见[登录、发现与转发](../shared/architecture/authentication-flows.md)。

验证：`pnpm web:type-check`、`pnpm web:build`；HTTP/WS 路径和重连由相应前端测试验证，真实连接由用户人工复核。

业务配置的 `fetchServerConfig()` 在同一认证身份、目标和上下文内共享进行中的读取，成功后缓存；清缓存、身份或目标改变后不复用。失败允许后续显式重试，旧读取失败不能清掉新缓存；底层拒绝过期响应的规则仍然有效。定向检查见 `apps/web/test/services/serverConfigConcurrency.test.ts` 和 `apps/web/test/auth/httpTargetIsolation.test.ts`。

局域网 HTTP 浏览器可能没有 `crypto.randomUUID()`；请求、草稿及界面资源标识使用 `utils/uuid.ts` 的兼容方法，不用于生成认证凭据。缺少该接口的检查见 `apps/web/test/services/uuidCompatibility.test.ts` 及 `interactionSafety.test.ts` 的工作台初始化用例；不启动浏览器，真实界面仍交用户验收。
