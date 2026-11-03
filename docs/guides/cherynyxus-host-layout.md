# cherynyxus 本机部署布局

2026-11-02 经用户授权清理历史发布与备份前，已将运行依赖迁出历史发布目录，避免删除后影响服务重启。本文说明本机部署，不改变通用产品部署契约。

## 当前唯一入口

宿主目录 `/home/chery/docker/cherynyxus/`：

- `compose.yaml`：原 27 份 Compose 配置合并为一份；规范化配置比较完全一致。
- `deploy.sh`：固定项目名 `cherynyxus` 与上述配置的维护入口。默认 `up -d --no-build --pull never`，不从当前混合工作区构建。
- `runtime/qq-worker/`：独立安装的 worker JS 与 skills，约 1.1 MB，不是可清理缓存。
- `runtime/qq-worker.sha256.json`：21 个运行文件的 SHA-256 清单。
- `runtime/layout-migration.json`：迁移验证与清理结果摘要，不含秘密。
- `README.md`：本机目录职责、完整维护命令和清理边界。

Backend 固定镜像为 `sha256:51aa9c06bd279eb3ad23716a8978f29ca9e7562106c7cea7053ede81bccac53b`。用户级 `cherynyxus-qq-worker.service` 的启动文件和 skills 路径已改到 `runtime/qq-worker/`；工具镜像保持原 `cherynyxus-qq-tools:workspace-complete-20261030`。

```bash
cd /home/chery/docker/cherynyxus
./deploy.sh config --quiet
./deploy.sh ps
systemctl --user status cherynyxus-qq-worker.service
curl --fail --unix-socket ./qq-worker/control.sock http://localhost/health
```

服务操作需先协调活动工作。明确授权重建容器时使用 `./deploy.sh up -d --no-build --pull never --force-recreate --wait --wait-timeout 150`，不再使用旧发布叠加命令。不要删除正在使用的通信父目录。

## 本轮保留与删除边界

保留源码 `/home/chery/dev/cheryClaw`、`qqbot-data/`、`user-files/`、`secrets/`、环境文件、当前 Docker 镜像和卷。受管应用控制器、模板及状态位于 `/var/lib/cherynyxus-apps`，未纳入清理；未操作 `/mnt`。

旧发布源码、构建上下文、验证材料和备份已获用户授权清理，不再承担恢复保证。历史验证说明中的原路径保留为历史定位信息，不能据此假定原文件仍可访问，也不能重新执行其中的一次性发布或回滚脚本。普通账号可访问的旧发布文件已删除，仅剩 `releases/managed-app-access-20261028/maintenance-private` 为 root:root、0700，需管理员从自己的终端完成删除；精确命令见本机部署 README。未通过 Docker 绕过访问限制。清理前临时迁移快照已删除，不再额外保留整套旧配置和容器环境副本。

## 验证范围与限制

新 Backend 已以原镜像重建并 healthy；新旧容器的镜像、环境、命令、端口、挂载、网络地址配置、健康检查和只读根设置逐项一致。新容器 Compose 标签只引用当前单文件配置。

Worker 已从新位置运行，宿主和 Backend 内的 socket 健康检查通过。一次隔离工具容器命令确认 skills 挂载和 Python 执行成功，临时测试目录已清理；未发送 QQ、调用模型或改写业务数据库。

容器健康检查只覆盖 Manager。重建后发现其保留停止意图，已使用现有本机 Manager CLI `start backend` 恢复迁移前运行的后端，复查 `running`、listener ready，Manager 与 Web 均 HTTP 200。后续维护须用 `docker exec cherynyxus-backend-1 node /app/apps/manager/server-dist/index.js status` 独立确认 Backend；仅在获授权且确需运行时显式启动，不直接改写停止意图或另起后端。

这些检查不代表 QQ 真实收发、模型、浏览器、公网入口或整机重启全部验收通过。后续发布仍需独立核对版本和数据保护，不能把本次布局整理当成业务功能发布。
