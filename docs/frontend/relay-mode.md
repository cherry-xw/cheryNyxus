# 中转连接模式

中转连接使用 `web/src/services/relay.ts`。前端先读取公开 Backend ID 列表，再绑定一个在线后端；绑定响应提供公共 HTTP/WS 路径，后续请求不能自行拼接本地端口。

- `listRelayBackends()`：读取最小公开列表。
- `discoverRelayBackend()`：读取指定后端的公共连接描述。
- `bindRelayBackend()` / `unbindRelayBackend()`：维护 HttpOnly 会话绑定。
- `relayHttpUrl()` / `relayWsUrl()`：根据发现响应构造路径。

每个浏览器会话只允许绑定一个 Backend ID。中转列表不代表已登录；目标后端仍需完成 OIDC 或用户名密码认证。浏览器使用 `credentials: include`，不能读取或保存中转会话 Cookie。
