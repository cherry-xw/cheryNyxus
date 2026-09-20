# 中转与后端发现协议

## 1. 适用范围

本文是 CheryNyxus 公网中转、后端设备连接、浏览器后端选择和代理路径的唯一协议来源。中转不是通用代理：只接受本文定义的控制连接、HTTP `/api/*` 和 WebSocket `/ws`。

协议版本当前为 `1`。实现遇到不支持的版本必须拒绝，不能猜测兼容。

## 2. 身份与加密边界

- `backendId` 是用户设置的稳定、易读路由标识，格式为 3 至 63 个小写字母、数字或连字符；首尾必须是字母或数字。它不是密码。
- 每个后端首次启动生成 Ed25519 密钥对。私钥只保存在后端本机受保护文件中，公钥用于中转验证挑战签名。
- 中转采用首次信任：某个 `backendId` 首次成功握手后持久绑定公钥指纹；后续不同公钥使用同一 ID 时返回 `BACKEND_ID_CONFLICT`。解除绑定必须走部署方的本机管理操作，不通过公开协议完成。
- 后端用户名密码只认证最终用户，不参与设备握手，中转不得保存或校验。
- 设备签名只证明身份，不自行加密业务载荷。公网机密性由 HTTPS/WSS 和 rathole 加密连接提供；生产部署禁止明文公网控制连接。

## 3. 后端控制 WebSocket

控制入口为 `<publicBasePath>/control/backend`。连接建立后按以下顺序交换 JSON 文本消息。

### 3.1 挑战

```json
{
  "type": "challenge",
  "protocolVersion": 1,
  "nonce": "base64url random bytes",
  "expiresAt": "2026-09-20T15:10:00.000Z"
}
```

### 3.2 握手

```json
{
  "type": "hello",
  "protocolVersion": 1,
  "backendId": "home-nyxus",
  "displayName": "Home Nyxus",
  "publicKey": "base64url DER SPKI",
  "signature": "base64url Ed25519 signature",
  "configVersion": 1,
  "capabilities": { "http": true, "websocket": true }
}
```

签名原文为 UTF-8：

```text
cherynyxus-relay-v1\n<nonce>\n<backendId>\n<protocolVersion>\n<configVersion>
```

字段之间只使用单个 LF，不带结尾换行。挑战只能使用一次，并在 `expiresAt` 后失效。

### 3.3 接受与租约

```json
{
  "type": "accepted",
  "protocolVersion": 1,
  "backendId": "home-nyxus",
  "leaseId": "opaque id",
  "heartbeatIntervalMs": 15000,
  "leaseExpiresAt": "2026-09-20T15:11:00.000Z",
  "configVersion": 1,
  "tunnel": {
    "httpService": "opaque service name",
    "websocketService": "opaque service name",
    "token": "short-lived secret"
  }
}
```

HTTP 与 WebSocket 使用两个只对中转机 loopback 可见的 rathole 私有映射。服务名和 token 是秘密，不得出现在列表、发现响应、URL或普通日志中。

后端按 `heartbeatIntervalMs` 发送 `{ "type": "heartbeat", "leaseId": "..." }`；中转返回带新 `leaseExpiresAt` 的 `heartbeat_ack`。租约过期或控制连接关闭后，后端立即从在线路由移除。旧租约不得在重连后继续使用。

## 4. 浏览器列表、发现与绑定

以下入口相对于公共前缀：

| 方法与路径 | 认证 | 作用 |
| --- | --- | --- |
| `GET /api/backends` | 公开、受来源限流 | 返回后端最小列表 |
| `GET /api/backends/<backendId>` | 公开、受来源限流 | 查询单个后端及公开连接地址 |
| `POST /api/session/backend` | 公开、JSON body、受来源限流 | 将当前浏览器会话绑定到一个在线后端 |
| `DELETE /api/session/backend` | 同源会话 | 清除绑定 |

列表项只含 `backendId`、`displayName`、`status`、公开能力和 `lastSeenAt`。不得包含公钥、指纹、租约、rathole 配置、token 或本地真实端口。

绑定请求为 `{ "backendId": "home-nyxus" }`。成功后中转设置 HttpOnly、SameSite=Lax、Secure（HTTPS 时）的签名会话 Cookie，并返回：

```json
{
  "backendId": "home-nyxus",
  "transport": "binary",
  "httpBasePath": "/nyxus/backend/home-nyxus",
  "wsPath": "/nyxus/backend/home-nyxus/ws"
}
```

同一中转会话只能绑定一个后端；重新绑定会替换旧绑定。中转只负责路由绑定，进入控制面仍须完成目标后端的 OIDC 或用户名密码登录。

## 5. 代理路径

- HTTP：`<publicBasePath>/backend/<backendId>/api/*`
- WebSocket：`<publicBasePath>/backend/<backendId>/ws`

代理前必须同时满足：Backend ID 格式有效、后端在线、浏览器会话绑定同一 ID、路径严格命中上述白名单、资源限制未超出。编码斜杠、反斜杠、NUL、路径穿越和其他路径一律拒绝。

relay 去掉 `/backend/<backendId>` 路由段后向后端专用远程入口转发标准 `/api/*` 或 `/ws`。公共前缀通过仅远程入口信任的内部元数据传递，用于 Cookie Path、OIDC 回调和发现地址；客户端传入的同名普通请求头必须先移除。

## 6. 稳定错误

错误响应使用 `{ "error": { "code": "...", "message": "...", "requestId": "...", "retryAfterSeconds"?: 1 } }`。

| HTTP | code | 含义 |
| --- | --- | --- |
| 400 | `INVALID_REQUEST` | 字段、JSON 或 Backend ID 无效 |
| 401 | `BACKEND_AUTH_FAILED` | 设备挑战或签名无效 |
| 403 | `SESSION_BACKEND_MISMATCH` | 浏览器会话未绑定或绑定了其他后端 |
| 404 | `BACKEND_NOT_FOUND` | Backend ID 从未登记 |
| 409 | `BACKEND_ID_CONFLICT` | ID 已绑定其他公钥或已有有效连接 |
| 410 | `BACKEND_OFFLINE` | 已知后端当前离线 |
| 413 | `REQUEST_TOO_LARGE` | 请求体超过配置上限 |
| 426 | `PROTOCOL_VERSION_UNSUPPORTED` | 控制协议版本不支持 |
| 429 | `RATE_LIMITED` / `CAPACITY_EXCEEDED` | 来源速率或连接容量超限 |
| 502 | `BACKEND_UNAVAILABLE` | 私有目标暂时不可访问 |
| 504 | `BACKEND_TIMEOUT` | 目标响应超时 |

错误消息不得回显秘密、内部端口或原始异常堆栈。

## 7. 日志与资源边界

普通请求日志只允许：`requestId`、`backendId`、路径类别、状态码、耗时和失败类别。禁止记录 Authorization、Cookie、Set-Cookie、OIDC code、密码、access/refresh token、设备签名、私钥、公钥全文、rathole token 和请求/响应 body。

实现必须提供请求体大小、每来源请求速率、总控制连接、总在线后端、每后端浏览器 WebSocket、全局浏览器 WebSocket、上游连接/响应超时和空闲租约上限；达到限制时使用本协议错误，不静默排队到资源耗尽。
