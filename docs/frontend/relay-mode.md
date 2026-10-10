# 中转连接模式

## 当前入口

浏览器预加载登录由 [PreloadRoot.vue](../../apps/web/src/PreloadRoot.vue) 和 [PreloadLoginShell.vue](../../apps/web/src/features/auth/PreloadLoginShell.vue) 处理。认证状态由 [auth.ts](../../apps/web/src/stores/auth.ts) 维护，中转服务代码位于 `apps/relay/src/`。

当前前端直接在登录组件中请求中转接口，不存在独立的 `relay.ts` 或 `listRelayBackends`、`bindRelayBackend` 等函数。这些名称不能作为代码定位入口。

## 实际调用关系

- 组件挂载时，已选择 `relay-oidc`、有服务地址且没有 Backend ID，才请求 `GET /api/backends`；请求携带 `credentials: include`，失败不填充列表。
- `relay-password` 提交调用 `auth.loginRelayPassword`；该方法保存所选 Backend ID 后调用通用 `login`。密码登录先向中转建立目标会话，再经受限路由登录后端；Backend ID 的保存本身不等同于已完成中转会话绑定。
- 组件的 OIDC 分支在没有 Backend ID 时包含跳转 `/api/auth/oidc/start` 的代码；有 Backend ID 时向 `POST /api/session/backend` 提交绑定，请求携带 Cookie，成功后使用 `/backend/<backendId>` 作为服务地址。
- 后续必须等待 `connection.reconnect({ waitUntilConnected: true })` 成功才发出 `ready`；仅保存目标或绑定响应成功不等于 WebSocket 已连接。

## 接线限制与待确认项

提交按钮的 `canSubmit` 对非本地模式要求 Backend ID；因此组件中“无 Backend ID 时启动 OIDC”的分支不能仅凭存在代码认定可从当前表单触发。该入口与条件是否符合已确认登录需求，需要单独核实，不把偏差写成新的业务规则。

认证 store 提供 `configureRelayOidc` 与 `loginRelayOidc`，后者要求注入适配器。当前 Web 源码未发现适配器注册调用；组件的直接绑定路径与该适配器路径不能混称为同一个已经完成的流程。

中转列表、认证、Backend 绑定和实际连接是不同步骤。服务端路由与 Cookie 安全以中转模块实现和认证契约为准；本说明只记录已核对的前端调用，不能据此宣称真实 OIDC 登录、远端绑定或部署验证通过。
