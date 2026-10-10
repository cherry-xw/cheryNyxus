# 中转服务

中转服务是独立于 cheryNyxus 后端和前端的 Node 进程，负责设备握手、在线状态、Backend ID 发现、单后端会话绑定和受限 HTTP/WS 路由。它不保存后端用户密码，不实现 Pocket ID，也不提供通用代理。

## 任务定位

| 修改意图 | 权威说明 | 代码入口 | 验证入口 |
| --- | --- | --- | --- |
| 修改设备握手、发现或路由 | [中转协议](../shared/protocol/relay.md) | [`apps/relay/src/server.ts`](../../apps/relay/src/server.ts) `createRelayService()` | `pnpm relay:test` |
| 修改中转配置和限制 | [中转协议](../shared/protocol/relay.md) | [`apps/relay/src/config.ts`](../../apps/relay/src/config.ts) `loadRelayConfig()` | `pnpm relay:type-check` |
| 修改设备绑定存储 | [中转协议](../shared/protocol/relay.md) | [`apps/relay/src/identityStore.ts`](../../apps/relay/src/identityStore.ts) `IdentityStore` | `apps/relay/test/relay.test.ts` |
| 修改后端控制连接或动态隧道配置 | [中转协议](../shared/protocol/relay.md) | [`apps/relay/src/client.ts`](../../apps/relay/src/client.ts) `RelayBackendClient`、[`apps/relay/src/rathole.ts`](../../apps/relay/src/rathole.ts) `servicesFromAccepted()` | `apps/relay/test/rathole.test.ts`、`pnpm relay:type-check` |

## 运行方式

- 开发：`pnpm relay:dev`
- 构建：`pnpm relay:build`
- 运行构建产物：`pnpm relay:start`

生产环境必须设置至少 32 字节的 `RELAY_SESSION_SECRET`，并通过 HTTPS/WSS 与加密的 rathole 私有映射提供公网传输。默认目标适配器通过已接受的私有隧道映射访问后端，测试可注入专用适配器。

## 代码边界

- `apps/relay/src/server.ts`：HTTP、WS、握手和受限路由。
- `apps/relay/src/registry.ts`：在线租约、容量和浏览器 WS 计数。
- `apps/relay/src/identityStore.ts`：Backend ID 到设备公钥指纹的首次信任绑定。
- `apps/relay/src/adapter.ts`：后端 HTTP/WS 目标适配器；测试可以注入假适配器。
- `apps/relay/src/client.ts`：后端控制 WebSocket 客户端、设备密钥、租约心跳、重连和动态 client 配置。
- `apps/relay/src/rathole.ts`：HTTP/WS 两服务校验、client/server TOML、私有配置和 rathole 子进程适配。
- `packages/protocol/src/relay.ts`：跨进程共享类型和签名原文。

普通日志只允许 request id、Backend ID、路径类别、状态码、耗时和错误类别；不得添加凭据、Cookie、token、密钥或请求体。

后端控制客户端可以把不含 token、密钥和 Cookie 的状态摘要写入本机受保护状态文件；本地管理器通过配置的 `CHERY_RELAY_STATUS_FILE` 读取该摘要，不经中转返回。
