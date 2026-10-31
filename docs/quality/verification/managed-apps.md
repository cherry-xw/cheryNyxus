# 受管小应用能力验证

本说明维护当前验证范围、方法与限制；功能契约见[受管小应用](../../backend/service/managed-apps.md)，实际版本与操作边界见[维护指南](../../guides/managed-apps.md)。

## 已确认结束的范围

用户于 2026-10-29 确认基本开发与运行能力验收结束：Agent 能在本人所属的受限工作容器中执行开发命令、构建、启动服务并交付可访问地址，页面能取得应用后端正常响应。示例应用的记账、分类图表、CSV 和记录增删不作为本轮完成条件，不再要求用户补验。

该结论不是任意生成应用全部业务正确的保证，也不是下列未执行项目已通过的保证。用户接受本轮不做 QQ 删除应用和自然到期通知的真实验收，并同意两项已知问题由[独立维护计划](../../plan/managed-app-maintenance/README.md)接手，不阻止基本能力任务结束。

## 已有证据与适用对象

真实环境检查对象为 2026-10-28 发布的 `managed-app-access-20261028`，应用运行镜像及 Backend 标识由维护指南维护。运行原始材料保存在发布目录的 `verification/`；发布副本构建、类型与定向测试记录保存在 `validation.json` 和 `logs/`。这些是对应版本的结果，不保证任意后续工作区修改仍然成立。

| 对象 | 当前结论 | 证据与边界 |
| --- | --- | --- |
| 源码及独立发布副本 | Backend 定向 87 项、QQ 5 项、类型检查、Backend 与控制器构建通过；新运行镜像模板断网构建及 55 项检查通过 | 发布目录 `validation.json`、`image-verification.json`、`logs/`；不等于所有真实资源与故障场景通过 |
| 部署与原数据保留 | 管理员维护结果 deployed；新控制器实际命令与模板、镜像已核实，通信目录保留，原登记及用户文件保留 | `deployment-result.json`、`verification/post-deployment-summary.json`；不代表整机重启次序已验证 |
| QQ 创建、命令执行、构建与发布 | 用户真实 QQ 请求已完成，指定应用使用固定运行镜像，回复有原生发送确认；激活链接仅本人获准私聊交付 | `verification/m01-request.json`、`m01-private-delivery.json`；不以仅有聊天口头回复判断成功 |
| LAN／公网前后端访问 | 页面、静态文件和 API 可达，路径正确；用户已反馈运行及页面正常 | `verification/m01-http.json`、`m04-public-checks.json`；不证明所有示例业务正确 |
| 读取权限 | 私密应用匿名读取拒绝，公开只读允许匿名读，匿名写入拒绝；原私密应用保持不变 | `verification/m02-http.json`、`m04-public-checks.json`、`m04-user-confirmation.json`；空／无效写入探测不改变记录，未冒用用户会话 |
| 停止、续期、再次启动 | 停止移除临时容器且保留目录；续期仍停止；再次启动使用原镜像，账号、源码和记录摘要不变，用户确认数据正常 | `verification/m03-before-stop.json`、`m03-stopped.json`、`m03-renewed.json`、`m03-started.json`；续期回复日期错误另列，不混为续期动作失败 |
| 示例应用保存修正 | 指定应用已按授权修正保存参数，24 项断网检查及实际生效核对通过；账号及数据保留，用户反馈正常 | `verification/application-save/`、`m02-service-update.json`、`m02-user-confirmation.json`；不是其他应用的更新或整个平台业务保证 |

原始输出不进 Git，不包含用户密码、会话 Cookie 或激活令牌；涉及管理员备份时仍遵守原 root 权限。发布目录、备份与来源快照保留用于维护，维护者在对应版本不再用于运行、恢复或问题调查后另行确认清理。

## 自动检查入口

从仓库根按需运行相关测试；已有有效结果不要求为任务结束机械重跑。测试不能改线上配置、对共享服务制造压力或恢复生产数据。

```sh
pnpm exec vitest run --config apps/backend/vite.config.ts \
  apps/backend/test/agent/sense/managedApp.test.ts \
  apps/backend/test/service/managedAppController.test.ts \
  apps/backend/test/service/managedAppRequest.test.ts \
  apps/backend/test/service/managedAppGateway.test.ts \
  apps/backend/test/service/managedAppLifecycle.test.ts \
  apps/backend/test/service/managedAppNetwork.test.ts \
  apps/backend/test/service/managedAppDelete.test.ts \
  apps/backend/test/service/managedAppBackup.test.ts \
  apps/backend/test/service/managedAppActivation.test.ts \
  apps/backend/test/service/managedAppVisibility.test.ts \
  --no-file-parallelism
```

QQ 目录及通知的本地测试为 `plugins/qq/test/managedAppFiles.test.ts`、`plugins/qq/test/appNotifications.test.ts`，使用 `plugins/vitest.config.ts`，不实际发送消息。

完整模板探针为 [`managedAppTemplateProbe.mjs`](../../../apps/backend/test/helpers/managedAppTemplateProbe.mjs)。运行前提是固定 Node 24 运行镜像和内置依赖已存在：在无生产挂载的 `--network none` 临时容器中，把仓库模板只读挂入输入目录，再复制到容器临时目录；设置该容器内的 `APP_BASE`，离线执行 `npm run build` 和探针。不要在运行应用目录中执行，也不要缺镜像时自动拉取或联网安装。可复核的命令与运行环境记录为发布目录 `runtime-image-probe-command.json`；后续改变目录或镜像时重新确认实际挂载，不照搬已清理临时路径。

探针检查激活期限、Cookie、角色、防伪请求、读取权限、CSV、附件、SSE 和 WebSocket，但旧结果中 SSE 仅检查连接及类型，没有断言禁止缓存标记。不能用 55 项通过否定已经取得的缓存头失败证据。

## 当前限制与接手安排

- **已知问题仍未修复**：续期工具结果与 QQ 回复日期不同；SSE 可连接但响应缺少 `no-store`。事实、影响、处理责任和开始条件由独立维护计划唯一维护，不重复作为已完成任务的待办。
- **用户已接受本轮未实测**：真实 QQ 删除指定应用；自然到期、空闲及周清理触发的原生通知。这些能力已有相应自动测试，但自动测试不代替真实结果。本轮不等待自然触发，不缩短生产租期、不主动发消息；以后需要验证时，先明确对象与真实操作授权。
- **低频、压力与极端故障未完整实测**：真实限速吞吐、资源耗尽、构建额度异常回落、主机保护、长连接关闭排空、控制器备份恢复及整机恢复次序。基本交付结论不包含这些保证；需要扩大使用规模或修改对应机制时，由承担该变更的执行者在独立环境补证，不在共享服务制造故障。
- **既有应用不会自动更新**：新模板和镜像只证明新建应用的对应版本；保留原代码、账号及数据，不宣称旧应用获得模板修正。
- **信任范围不扩大**：同域路径面向本人及可信内容，不证明恶意同域应用互相隔离。不互信使用者的私密应用需另行设计独立应用域名。

后续问题修正只复验受影响的平台能力；不恢复示例应用的逐项业务验收，也不因原始任务计划删除而自动取得部署、删除应用或浏览器操作权限。
