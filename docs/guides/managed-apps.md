# 受管小应用部署与维护

本指南面向维护者。身份、工具、权限和生命周期的正式约定见[受管小应用](../backend/service/managed-apps.md)，已验证及未验证范围见[验证说明](../quality/verification/managed-apps.md)。维护操作需要对应范围的授权，任务结束不自动授权重启、删除应用或恢复数据。

## 部署对象与记录

2026-10-28 已核对的部署为 `managed-app-access-20261028`，发布目录在 `/home/chery/docker/cherynyxus/releases/managed-app-access-20261028/`。目录中的清单、日志和受限备份是该版本的运行记录，不以当前共享工作区替代发布来源。下次维护前须重新核对实际版本，不把此表当作永久在线状态。

| 对象 | 已核对的发布标识或位置 |
| --- | --- |
| Backend 镜像 | `cherynyxus-runtime:managed-app-access-20261028`；ID `sha256:6ba6a5549b3fe1d5e77c91edeafbad51825958f576258d67f536324e713507f3` |
| 应用运行镜像 | `cherynyxus-app-runtime:managed-app-access-20261028`；ID `sha256:421e83d62a7a8feb3544dd7ad731271a447dc85bdb40fec21ccd58c9e2769c1a` |
| 控制器启动文件 | `/var/lib/cherynyxus-apps/releases/managed-app-access-20261028/controller/controller-daemon.mjs` |
| 宿主模板 | `/var/lib/cherynyxus-apps/releases/managed-app-access-20261028/template/` |
| 控制器覆盖配置 | `cherynyxus-app-controller.service.d/zz-managed-app-access.conf`，在原 `runtime.conf` 之后加载 |
| 通信目录 | `/run/cherynyxus-app-controller/`，整个目录挂入 Backend，`RuntimeDirectoryPreserve=yes` |
| 运行记录 | 发布目录的 `manifest.json`、`source-inputs.json`、`source-changes.json`、`validation.json`、`deployment-result.json`、`logs/` |
| 发布来源与验证材料 | 发布目录的 `source/`、`verification/`；不含生产数据库或用户凭据，来源快照不作为当前模块说明 |
| 维护脚本与备份 | 发布目录的 `deploy.py`、`deploy_test.py`、`maintenance-private/`；备份仅 root 可读 |

应用文件位于 `/home/chery/docker/cherynyxus/user-files/{userId}/apps/{appId}/`。控制器登记 `/var/lib/cherynyxus-apps/controller-state.json` 是受限文件，不通过 Docker 挂载等方法绕过读取权限。发布、旧镜像和管理员备份保留供恢复，不因文档归档而清理。

## 维护前检查

1. 明确目标：Backend、控制器、固定镜像、宿主模板或指定已有应用各是独立对象。修改仓库模板不会更新运行镜像或已有应用；不能自动覆盖用户代码。
2. 保存实际镜像、完整 Compose 文件顺序、控制器配置、挂载和通信目录信息。实际部署有多份 Compose 叠加文件，必须复用当前完整顺序，不能改用仓库默认配置。
3. 采用独立发布源码和固定依赖，核对输入清单与产物摘要。共享工作区含其他任务修改时，不整仓构建上线；不能靠锁文件相同推断构建环境相同。依赖的实际只读挂载须完整，不读取依赖源码或逆向打包代码。
4. 确认活动命令、排队构建、待投递消息及未知投递。进入受控维护并等待有关写入者停止后再做一致备份，不取消用户工作或重放消息换取空闲状态。
5. 获得限定管理员操作授权。管理员认证由用户在自己的终端完成，不在聊天提供 sudo 密码，不借 Docker 权限绕过限制。

## 更新与恢复边界

- 控制器重启前先确认 `RuntimeDirectoryPreserve=yes` 已加载，并记录通信目录 inode。必须保留父目录，不能先停止控制器再补设置；已有 Backend 可能仍挂在旧目录上。
- 控制器和模板安装到新的版本目录，以后加载的配置指定启动文件、固定镜像 ID 和模板路径。核对实际生效的启动命令、环境和主进程参数，不能只看文件存在。
- 只更新已授权服务；不运行全栈重建、卷清理，不更新 QQ 包、Manager、NapCat 或其他应用。原配置、账号、队列、用户文件和应用登记必须保留。
- SQLite 备份须一致保留数据库与 WAL/SHM。恢复旧镜像不等于恢复持久数据；若确需恢复数据，必须单独确认范围及部署后新增内容，不能用旧整库覆盖新消息和新操作。
- 更新完成后检查服务状态、控制器通信、LAN、公网及原静态分享路径，再交接实际入口。只检查健康接口不能证明公网可达，也不能证明示例业务全部正确。
- 通信目录保留不代表整机重启次序已经验证；`/run` 仍会随整机重启清空。

已完成的上述发布不再运行 `deploy.py --deploy` 或 `--resume`。也不盲目执行 `--rollback`；该脚本固定针对原发布，不能当作后续任意版本的通用升级器。需要恢复时先查明原因、活动工作和新数据，再取得明确授权。脚本原件和保护测试保存在发布目录，无需从已结束任务计划恢复。

## 不改变状态的排查

优先检查 Docker 元数据、systemd 实际配置、普通页面/API 和允许读取的数据库摘要，不记录密码、Cookie、激活令牌或完整业务正文。

`inspectAppStatus` 发现状态不一致时可能写登记；`reconcileAll` 会修改登记、网络限制并可能处理孤立容器；内部健康入口可能补发激活令牌。不能把这些调用当作严格只读检查。对应实现入口为 `ManagedAppController` 的同名方法及 `waitForHealthcheck`。

LAN 入口为 `http://10.2.3.6` 的 Nginx，公网为 `https://mini.xcherry.top`。Backend 的 8283 端口不直接提供原静态分享入口；不能用其返回的页面代替分享文件验证。应用无尾斜杠路径应跳转到带斜杠路径；停止页与 `APP_STOPPED` 的 503 是正常停止结果，不是必须重启的故障。

已知续期回复和实时缓存问题见[独立维护计划](../plan/managed-app-maintenance/README.md)。修正涉及应用、镜像或控制器时，需要重新明确对象和生效方式，不能为复验而覆盖已有应用。
