# 受管小应用

## 职责与入口

本模块管理可信 QQ 用户自己的工作容器、应用文件、发布、租期、通知和统一访问路径，不管理 Backend 或 NapCat 的生命周期，也不授予应用平台管理权限。

| 修改意图 | 代码入口与关键符号 | 验证入口 |
| --- | --- | --- |
| 身份和模型工具 | [`managedApp.ts`](../../../apps/backend/src/agent/sense/managedApp.ts) 的 `managedAppPrincipal`、`createManagedAppSense` | `test/agent/sense/managedApp.test.ts` |
| 创建、发布、停止、续期与删除 | [`controller.ts`](../../../apps/backend/src/service/managedApp/controller.ts) 的 `ManagedAppController` | `test/service/managedAppController.test.ts`、`managedAppDelete.test.ts`、`managedAppLifecycle.test.ts` |
| 应用读取权限和一次性激活 | [`template/server/`](../../../apps/backend/src/service/managedApp/runtime-image/template/server/) 的 `index.mjs`、`activation.mjs` | `test/service/managedAppActivation.test.ts`、`test/helpers/managedAppTemplateProbe.mjs` |
| HTTP、SSE、WebSocket 与平台凭据隔离 | [`gateway.ts`](../../../apps/backend/src/service/managedApp/gateway.ts) 的 `createManagedAppGateway` | `test/service/managedAppGateway.test.ts` |
| 本机控制器通信 | [`socketRpc.ts`](../../../apps/backend/src/service/managedApp/socketRpc.ts) 的 `ControllerSocketClient` | `test/service/managedAppController.test.ts` |

上述测试路径相对于 `apps/backend/`。QQ 通知由 [QQ 模块](../../../plugins/qq/README.md#应用到期通知)负责实际投递。

## 请求与数据路径

1. 模型调用 `managed_app`；用户身份只取已认证 QQ 请求，不能从工具参数指定。
2. Backend 通过受限 Unix Socket 请求控制器，模型不能访问 Docker Socket。
3. 控制器建立独立项目和数据目录，在固定镜像、硬配额及隔离网络中运行。
4. `publish` 离线构建并检查健康后，网关才允许访问 `/qq/{userId}/apps/{appId}/`。
5. 模板使用应用自己的账号和 Cookie；管理登录、认证头和其他应用 Cookie 不传入应用。
6. 停止保留代码和数据；彻底删除只针对本人明确指定的应用，活动任务必须先结束。

## 模板读取权限

以下为已确认约定；实际部署和人工验收状态见[活动任务](../../plan/managed-app-runtime/README.md)。

- `visibility=private` 为默认值：业务记录、统计、CSV 导出、附件下载及实时进度要求应用登录。
- `visibility=public_read`：上述读取可匿名访问。新增记录、导入、上传、触发后台任务及删除仍检查已有角色和 CSRF；WebSocket 仍要求登录，不提供匿名命令通道。
- 页面、脚本、样式、登录与激活入口不因私密设置而被关闭；未登录页面不请求私密业务数据，退出后清空页面已有数据并关闭实时连接。
- 控制器在发布时注入可信 `APP_VISIBILITY`，包括复用已有容器时的服务重启；调用方的请求头不能覆盖它。
- 未知或缺失的可见性按私密处理。模板及网关不公开内部健康检查、源码和数据库。
- 模板响应禁止缓存；网关保留应用的 `no-store`，不能在转发时放宽私密响应的缓存限制。
- 路径模式只适用于本人和互信内容，不提供恶意同域应用之间的浏览器隔离。

## 管理员激活

激活令牌有效期为 30 分钟，用后删除；重启不延长仍有效令牌的期限。激活请求检查期限及令牌摘要，失败不能建立账号或会话。只有控制器使用的内部健康入口可取得或补发未激活应用的令牌；普通页面访问和激活失败不自动补发。

链接过期后，由本人在获准私聊中请求重新发布以取得新链接。群聊不交付激活链接。密码只在应用页面输入，不在聊天交付。数据库中的账号、记录和附件不因补发链接而删除。

## 依赖、维护与验证

固定模板随运行镜像发布；修改仓库模板不等于修改已存在应用。发布修正必须分别核对运行镜像、宿主机模板副本及已有应用源码，保留用户代码和数据，不能自动覆盖已有应用。

控制器 Socket 的父目录由 systemd 管理，Backend 挂载整个目录。若服务停止时删除并重建该目录，容器可能仍挂在旧目录而无法找到新 Socket。维护前核对 `RuntimeDirectoryPreserve` 与目录 inode；当前连接成功不能证明重启后仍可用，不能通过自动重建 Backend 绕过维护授权。

扩展模型动作时同时修改工具 schema、控制器 RPC schema、分发和调用方；增加读取入口时按上面的可见性规则接入，不只在页面隐藏按钮。

本地回归使用根命令 `pnpm test:backend -- <测试路径> --no-file-parallelism`；完整模板 HTTP、Cookie、CSRF、CSV、附件、SSE 和重启数据验证由 `test/helpers/managedAppTemplateProbe.mjs` 在固定镜像的断网临时容器中执行。执行方式、当前证据和必要 QQ/页面操作见[验收要求](../../plan/managed-app-runtime/acceptance.md)。离线验证不能替代部署或用户验收。
