# 受管小应用

## 职责与入口

本模块管理可信 QQ 用户自己的工作容器、应用文件、发布、租期、通知和统一访问路径，不管理 Backend 或 NapCat 的生命周期，也不授予应用平台管理权限。

开发命令在与 Backend 平级的工作容器内运行，不把任意生成代码放进 Backend，也不向模型开放 Docker Socket。既有静态分享 `/qq/{userId}/share/` 与动态应用 `/qq/{userId}/apps/{appId}/` 分开处理，源码和数据库不是静态分享文件。

| 修改意图 | 代码入口与关键符号 | 验证入口 |
| --- | --- | --- |
| 身份和模型工具 | [`managedApp.ts`](../../../apps/backend/src/agent/sense/managedApp.ts) 的 `managedAppPrincipal`、`createManagedAppSense` | `test/agent/sense/managedApp.test.ts` |
| 创建、发布、停止、续期与删除 | [`controller.ts`](../../../apps/backend/src/service/managedApp/controller.ts) 的 `ManagedAppController` | `test/service/managedAppController.test.ts`、`managedAppDelete.test.ts`、`managedAppLifecycle.test.ts` |
| 应用读取权限和一次性激活 | [`template/server/`](../../../apps/backend/src/service/managedApp/runtime-image/template/server/) 的 `index.mjs`、`activation.mjs` | `test/service/managedAppActivation.test.ts`、`test/helpers/managedAppTemplateProbe.mjs` |
| HTTP、SSE、WebSocket 与平台凭据隔离 | [`gateway.ts`](../../../apps/backend/src/service/managedApp/gateway.ts) 的 `createManagedAppGateway` | `test/service/managedAppGateway.test.ts` |
| 本机控制器通信 | [`socketRpc.ts`](../../../apps/backend/src/service/managedApp/socketRpc.ts) 的 `ControllerSocketClient` | `test/service/managedAppController.test.ts` |
| 配额、资源限制与命令清理 | [`types.ts`](../../../apps/backend/src/service/managedApp/types.ts) 的 `DEFAULT_RUNTIME_LIMITS`、[`resourceLedger.ts`](../../../apps/backend/src/service/managedApp/resourceLedger.ts) 的 `ResourceLedger`、[`quotaManager.ts`](../../../apps/backend/src/service/managedApp/quotaManager.ts) 的 `XfsQuotaManager` | `test/service/managedAppController.test.ts`、`managedAppNetwork.test.ts` |
| 自动停止及通知记录 | [`lifecycle.ts`](../../../apps/backend/src/service/managedApp/lifecycle.ts)、[`notifications.ts`](../../../apps/backend/src/service/managedApp/notifications.ts) | `test/service/managedAppLifecycle.test.ts` |

上述测试路径相对于 `apps/backend/`。QQ 通知由 [QQ 模块](../../../plugins/qq/README.md#应用到期通知)负责实际投递。

部署及故障恢复见[维护指南](../../guides/managed-apps.md)，验证范围及当前结论见[验证说明](../../quality/verification/managed-apps.md)。

## 请求与数据路径

1. 模型调用 `managed_app`；用户身份只取已认证 QQ 请求，不能从工具参数指定。
2. Backend 通过受限 Unix Socket 请求控制器，模型不能访问 Docker Socket。
3. 控制器建立独立项目和数据目录，在固定镜像、硬配额及隔离网络中运行。
4. `publish` 离线构建并检查健康后，网关才允许访问 `/qq/{userId}/apps/{appId}/`。
5. 模板使用应用自己的账号和 Cookie；管理登录、认证头和其他应用 Cookie 不传入应用。
6. 停止保留代码和数据；彻底删除只针对本人明确指定的应用，活动任务必须先结束。

## 工具与保存边界

模型入口为 `managed_app`，支持 `create`、`exec`、`task_status`、`task_cancel`、`publish`、`stop`、`delete`、`renew`、`status`、`backup`。完整参数以 `managedAppSchema` 为准，控制器请求以 `types.ts` 的请求定义为准；扩展动作必须同时检查两端及调用方。

- `create` 必须提供 `appId` 与 `title`，后续操作复用相同 ID；只有 `status` 可以省略 ID 列出本人应用。ID 校验由 `appIdSchema` 维护，不能由模型指定用户归属或宿主路径。
- `exec` 在 `/workspace` 中执行，`cwd` 只接受安全相对路径。普通命令默认 60 秒、上限 180 秒，构建上限 300 秒；工具结果包含任务 ID、状态、退出码和有界输出，不能把“请求已接受”当成执行成功。
- `publish` 默认先离线构建，再启动服务并检查健康；`buildFirst=false` 用于启动已有产物。内部健康通过和公网可访问是两个检查，不能互相替代。
- `stop` 可移除临时容器，但保留应用目录；访问停止页不自动创建或唤醒容器。接口返回 `503 APP_STOPPED`，页面说明停止及数据保留。
- `delete` 清除本人指定应用的容器、代码、数据、备份、登记和相关未发通知；它不同于停止，不能作为失败后的自动清理。

用户文件根下的 `{userId}/apps/{appId}/project`、`data` 分别映射为工作容器的 `/workspace`、`/data`。`backups` 由控制器管理，不挂给工作容器。挂载前检查路径链，禁止通过软链或相对路径访问其他项目。模板和依赖来自固定镜像，开发与构建不联网安装新包；依赖不能满足时返回明确错误，不绕回 Backend 安装。

## 资源与运行隔离

默认值统一由 `DEFAULT_RUNTIME_LIMITS` 维护：应用组常态内存 2 GiB、构建期间最高 4 GiB，单应用常态 200 MiB、构建 1.5 GiB；单应用 PID 上限 128，磁盘 512 MiB、文件数 20,000。CPU、文件句柄、队列和输出限制也由该定义与控制器共同实施，不在文档另建可独立修改的配置表。

`ResourceLedger` 按实际占用、启动预留和安全余量决定是否接纳新容器，不固定容器数量。正常预算不足时只拒绝或排队，不停止其他应用；多个已运行应用同时增长仍可能触及应用组内存上限，不能承诺绝无内存不足退出。构建结束后先清理残留进程并检查内存，必要时恢复干净运行态后再降低限制；不能直接压低仍被占用的内存上限。

工作容器使用只读根目录、固定非 root 用户、受限临时目录和独立网络，不挂载平台配置、Docker Socket 或控制器 Socket。宿主配额、网络隔离或资源限制未就绪时拒绝开放运行能力。受管请求的文件、命令、MCP 和子角色权限不能绕过项目归属和受限执行环境。

## 租期与通知

- 默认初始租期 7 天；`renew` 接受 1–7 天，基于当前到期时间与当前时间的较大值延长租期，不启动已停止服务，也不豁免周清理。
- 空闲停止默认 24 小时。健康检查、静态文件、实时连接保活和标记为轮询的请求不作为真实操作续期；具体活跃请求判定由 `lifecycle.ts` 维护。
- 周清理按 `Asia/Shanghai` 每周一 04:00 计算；恢复时只补处理清理时刻之前的实例，不误停之后新启动的实例。停止保留持久目录。
- 到期前 24 小时、前 1 小时和自动停止产生通知，按应用、租期版本和通知阶段去重。续期作废旧租期的待发通知；未知投递不自动重复发送，通知失败不阻止按时停止。
- 私聊和群聊通知目标取已验证来源，群内不得出现激活令牌。租期实际结果与模型解释是否一致分别检查，不能仅依据聊天回复判断已续期。

## 模板读取权限

以下为已确认约定；实际部署和人工验收状态见[验证说明](../../quality/verification/managed-apps.md)。

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

本地回归使用根命令 `pnpm test:backend -- <测试路径> --no-file-parallelism`；完整模板 HTTP、Cookie、CSRF、CSV、附件、SSE 和重启数据验证由 `test/helpers/managedAppTemplateProbe.mjs` 在固定镜像的断网临时容器中执行。运行前提、验证命令和未验证范围见[验证说明](../../quality/verification/managed-apps.md)。离线验证不能替代部署或用户验收。已知回复与实时缓存问题由[独立维护计划](../../plan/managed-app-maintenance/README.md)接手，未完成不等于基本开发交付未通过。
