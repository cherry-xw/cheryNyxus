# cheryNyxus 运行环境迁移

本指南负责部署命令、持久化、健康检查和迁移回滚。组件边界见[QQ 架构](../shared/architecture/qqbot-platform.md)，安装与迁移格式见[接入插件](../shared/architecture/ingress-plugins.md)，管理认证见[Manager 认证](../shared/protocol/manager-auth.md)。不修改 NapCat 部署、登录数据或任何 token。

## 部署入口

[Compose](../../deployment/compose.yaml) 的 Backend 镜像包含 Manager 与 Backend，先启动 Manager，再由它管理唯一 Backend。可选 Web 用 `--profile management` 启动并使用 host 网络。Backend 配套容器使用普通 bridge 网络允许模型出站，Manager 在容器内通过回环访问 Backend，不挂 Docker socket。所有容器显式清空 Docker daemon 注入的代理变量；需要代理时由部署者明确设置可访问的代理地址。

1. 构建 `pnpm build:prod`、`pnpm qq-ingress:build`、`pnpm settings-ingress:build`、`pnpm web:build`、`pnpm manager:build`。后者同时构建 Manager 页面与服务器。构建不启动运行服务；本地环境文件和 `.chery/` 不进入镜像，默认模板来自 `apps/backend/.chery.template/`。
2. `sh apps/backend/deploy/docker/prepare-runtime.sh` 复制当前 Node 和 CA，必须与构建原生模块的 Node/CPU ABI 一致。镜像基于 Debian trixie；不同宿主 libc 的构建需在匹配环境进行。
3. 参考 [环境样例](../../deployment/qqbot.env.example)，本地创建 `/home/chery/docker/cherynyxus/qqbot.env` 与三个 secrets 文件，权限 0600，不复制开发密钥。持久目录 `/home/chery/docker/cherynyxus/qqbot-data/.chery` 权限 0700，保留核心配置、数据库、记忆、插件 registry/config/data/backups 和 Manager 账号/凭据；Manager Session 仅存进程内存。
4. 核心配置必须 `server.host: 0.0.0.0`、`port: 8282`、`webPort: 8283`、`serve_frontend: false`，开启后端认证。独立 Web 默认回环 8080，Manager 默认回环 39980。需要 LAN 时在 Compose 环境设置 `NYXUS_WEB_BIND`、`NYXUS_MANAGER_BIND`，并在配置 `manager.auth.trustedOrigins` 登记实际 Manager URL；防火墙限可信来源，非可信网络使用 HTTPS。RPC 若供现有 NapCat 连接，显式设置宿主可访问的 `QQBOT_RPC_BIND`，不猜地址、不改 NapCat 网络。
5. `docker compose -f deployment/compose.yaml config --quiet`；`docker compose -f deployment/compose.yaml --profile management up -d --build --wait`。Web 使用本项目 Node 静态/反代服务，不需要外部 nginx 镜像。Manager 账号初始化用 `docker compose -f deployment/compose.yaml run --rm --no-deps -it backend node /app/apps/manager/server-dist/index.js auth setup`；密码不作为命令参数。不要启动单独 Manager 容器。

图片适配使用后端生产依赖 `sharp`，构建保留为外部包，不内嵌原生二进制。部署必须携带该包及其与目标系统、CPU 和 libc 匹配的可选二进制依赖；当前 Docker 入口从根生产依赖一起复制，不能只拷贝 `dist` 后省略它们。

运行服务入口不自动启用扩展。维护时使用同一受限挂载运行 `docker compose -f deployment/compose.yaml run --rm --no-deps backend node /app/apps/backend/dist/index.js ingress install /app/opt/qq-plugin`，设置包源为 `/app/opt/settings-plugin`；明确授予能力及 QQ 渠道后，再运行 `... ingress enable cherynyxus-qq-module`，最后经批准重启运行服务；升级使用 upgrade，不能覆盖版本目录。无 registry 时也不擅自启用业务。

两端包安装源由 `CHERY_INGRESS_INSTALL_ROOT=/app/opt` 限定。QQ 渠道须明确授予 `channel: qq` 与 `credentialKind: qq`，迁移不自动授予权限。入口脚本将已配置凭据转换为通用 `CHERY_CHANNEL_AUTH`（header、credentialKind、readyNotification），将暂停及个人文件路径转换为 `CHERY_PLUGIN_RUNTIME_OPTIONS`；核心 worker 不读取 QQ 专用认证变量。缺少凭据不等于通过握手。

Manager 与 Backend 共用容器内 `/app/apps/backend/.chery/config.yaml` 和受限数据目录，环境文件挂到 `/app/apps/backend/.env`；实际宿主持久数据位置保持原配置，不因源码迁移改名。Manager 控制自己的 Backend 子进程，Backend 停止时仍可管理；关闭整个容器会清理两者。关闭管理网页或可选 Web 不停止 Backend。仅对明确外管的特殊部署使用 `CHERY_MANAGER_BACKEND_MODE=external`，默认 Compose 不使用该模式。

## 容器基础工具与定时执行

容器使用普通用户及只读根目录，不运行 systemd，不提供宿主服务管理权限。Supercronic v0.2.49 与 Manager 一起受入口监督；任一退出会关闭整组，交给容器重启策略处理。Backend 由 Manager 管理，单独停止不关闭管理入口。定时配置持久化在 `$HOME/scheduler/crontab`，通过 `crontab -l`、`crontab FILE`、`crontab -`、`crontab -r` 管理，保存先校验语法并原子替换。任务以同一普通用户执行，输出进入容器日志；不保证停机期间漏执行任务的补跑，不自动把结果送回 QQ。

镜像基础工具覆盖 SSH/SCP/rsync、DNS查询与端口诊断、7z、中文OCR、图片处理，以及原有Python/Node、FFmpeg、PDF提取、SQLite和浏览器依赖。安装工具不等于授予远程主机凭据或额外网络权限。Node Playwright 安装在持久 `$HOME/browser-tools`，Chromium 位于 `$PLAYWRIGHT_BROWSERS_PATH`（默认 `$HOME/browsers`）。保留通用 Python venv，不安装 Python Playwright。启动监督与 crontab 使用 Node `.mjs`；监督进程向子进程组转发信号，宽限期后强制退出。未提供 at/systemctl、Office完整转换、个人浏览器登录态；不得声称这些能力存在。

## 健康与持久化

配套容器健康检查从受限文件读取机器密钥，在回环地址访问 Manager `/api/machine/status`，不依赖浏览器可信 Host 配置、不输出密钥。Backend 健康须单独确认 HTTP `/api/config` 返回 200/401 且 RPC 可连接，仍不证明插件活动、QQ 在线或模型可用。Web 检查 `/healthz`。启动后还需认证读取 QQ status，核对 installed/enabled/activeVersion、保存/应用版本和 `QQ_INGRESS_PAUSED=1`。未知或损坏 registry 不自动重置。

持久化路径由 [Compose](../../deployment/compose.yaml) 的 volumes 唯一维护。`WEB_PORT` 只改宿主 HTTP 发布端口，容器固定 8283；Manager 容器端口固定 39980，映射端口与可信 origin 必须一致。日志设置 json-file 大小/数量限制。重建不得 `down -v`，不得删除旧卷。先停止配套服务，再完整备份数据目录（包括 SQLite WAL/SHM、包版本和秘密），校验备份可恢复后才做迁移。

## 迁移与旧服务退出

迁移采用已批准的直接替换，无双消费期。实际操作前保存旧服务的 enabled/active 状态、服务文件位置、启动版本和数据备份，不将秘密写入报告。

1. 只检查已确认的旧 `qqbot-dev-backend.service`、`qqbot-dev-relay.service` 及旧 QQ 容器；不使用名称模糊匹配、不停通用公网 relay、更不操作 NapCat。存在不同旧单位名先要求操作者确认。
2. 获准后停止并禁用这两个旧 QQ 服务，核实 inactive/disabled 或 not-found，并核对旧端口已释放。旧数据只保留供离线迁移，不删除。
3. 停止新 Backend 后运行 `node plugins/qq/dist/migrate.mjs <显式旧data目录> <新CHERY_DIR/.chery/ingress目录> <可信selfId>`。必须由操作者提供经可信来源核对的 selfId，不采信客户端自报；不读取 NapCat token 或登录文件。已有未知发送任务按迁移报告保留暂停，不重发。
   若配置和队列已在同一个 ingress 目录，使用 `node plugins/qq/dist/migrate.mjs --in-place <ingress目录> <同一ingress目录> <可信selfId> [旧记忆根目录] [个人文件根目录]`。先在合成副本验证。此选项只升级 QQ 数据、不改 registry；原配置及状态字节用于失败回滚，外部个人文件只备份不搬走。不同目录迁移仍拒绝覆盖目标。成功标记存在时重跑不覆盖新写入；失败事务遇到后来写入时拒绝回滚并保留现场。API1 registry 的存储转换另走 `pnpm ingress:cli -- migrate-api1`，再安装 API2 包并明确授予能力，不能直接启动旧代码。
4. 安装/启用 Runtime 包，在 `QQ_INGRESS_PAUSED=1` 下启动唯一 Backend；认证读取核心和插件状态，核对版本、备份及持久数据。重新创建容器后再次核对同一数据；暂停不意味着业务已验收。
5. 本卡不安装或更改真实 NapCat 插件。由用户另行主动触发真实握手、QQ/模型测试以及解除暂停。

回滚先暂停并停止新 Backend 和 Manager，确认新 NapCat 客户端已断开且不会自动重连，再恢复迁移前整个数据/版本快照，最后才恢复旧 QQ 消费者的原 enabled/active 状态。不能让两个消费者同时运行；不能将新秘密复制给旧服务；不能删除或重装 NapCat。

## 验证入口与交付边界

部署源在 `deployment/`、`apps/backend/deploy/docker/Dockerfile` 与 `apps/backend/deploy/docker/backend-entrypoint.sh`。`pnpm manager:test` 验证外部进程保护及认证；`pnpm type-check`、`pnpm qq-ingress:type-check` 检查源码。真实 Docker 构建/重建仅用独立合成目录、暂停插件和无真实模型。自动检查不证明真实 QQ/模型、OIDC、跨主机 LAN 或视觉体验。

交付时分别列出命令和退出码、重建与持久恢复证据、需要重启和实际已重启服务、当前地址、旧服务状态以及未验证项。未执行真实环境迁移时不能声称生产部署完成。
