# 后端与 Manager 配套运行

Manager 与 Backend 属于同一产品的配套服务，始终遵循“同环境一体运行（同进同退）”边界——要么同在一个 Docker 容器内，要么同在宿主系统内。常规启动顺序固定为：**项目启动 → Manager 先启动 → 加载插件 → 由默认预装的 Backend 管理插件按持久化开关（`manager.backendPlugin.autoStart`，默认 `true`）以本地子进程拉起并监控 Backend**。Manager 管理登录与 AI Web 业务登录为两套完全独立的使用体系，不共享会话、不相互转授权限。Backend 未启动、构建失败或崩溃时 Manager 仍始终可用；整体关闭 Manager 进程会按进程组清理其拥有的 Backend 进程树；关闭管理网页不停止任何服务。

当 Backend 由 Manager 作为受管子进程拉起时（注入 `CHERY_MANAGED_BY_MANAGER=1`），崩溃恢复统一由 Manager 的 `BackendSupervisor` 单层执行：**最多自动重试 3 次，退避间隔依次为 5s、15s、30s**；仅当 Backend 监听就绪且**连续稳定运行满 5 分钟**后才清零连续失败计数；重试等待期间支持手动“取消重试”，达到 3 次上限后停留在 `failed` 状态保留日志与错误原因，等待管理员手动点击“启动 Backend”开启新一轮尝试（guardian 内部无限重试循环在受管模式下自动让出，防止多层重试绕过 3 次上限）。第一阶段仅开放启动、取消重试、状态/资源/日志监控与配置，不开放运行中 Backend 的停止操作（停止流程与 Agent 指令监控归入第二阶段专项计划）。

开发运行 `pnpm dev`：Manager 使用源码入口，Backend 由开发脚本构建并热重载。正式本机先运行 `pnpm build` 和 `pnpm manager:build`，再运行 `pnpm manager:cli`。systemd、Windows 启动与 Docker 都以 Manager 为配套服务入口，不再另起第二份 Backend。直接 Backend 入口保留给显式维护和诊断，不是常规整套启动方式。

Backend 内部入口为 `apps/backend/src/index.ts` 构建出的 `apps/backend/dist/index.js`，负责 guardian/worker；worker 创建核心运行时并由 `startService()` 装配 HTTP、WebSocket 和扩展宿主。QQ 模块仅由扩展宿主加载，不单独运行 QQ 后端服务。隧道仍由 Backend 设备客户端负责，Manager 不能另起副本。

## 当前 Docker 运行入口

部署 Compose 使用单个 `backend` 服务承载 Manager 与受管 Backend，镜像从 `apps/backend/deploy/docker/Dockerfile` 完整构建，命令为 `node /app/apps/manager/server-dist/index.js`，`CHERY_MANAGER_BACKEND_MODE=child`。保留 Backend 运行初始化入口以加载 secrets、渠道认证和插件运行选项；Manager 继承环境并启动 Backend。发布端口为 39980、8282、8283；健康检查只检查 Manager，使 Backend 故障时管理入口仍可用，不借容器重启绕过有限重试。PID 是容器内进程 ID。NapCat 维持独立运行。

## 配置与目录

开发环境默认运行根为 `apps/backend/`，不随当前工作目录变化。该目录内 `.env` 是 Backend 和 Manager 的环境文件，`.chery.template/` 是发行模板，`.chery/` 保存配置、数据库、文件、账号、凭据和备份。Manager 设置仍在同一 `.chery/config.yaml` 的 `manager` 段；账号与机器凭据继续是受限独立文件，不混同两类登录身份。

`CHERY_DIR` 可显式指定其他运行根，其下再放 `.chery/`；`CHERY_ENV_FILE` 指定环境文件，系统环境变量优先于文件；`CHERY_TEMPLATE_DIR` 可指定发行模板位置。初始化和两个服务都不自动读取或重新创建仓库根目录的旧环境/数据目录。生产数据的真实位置由部署配置决定，不能因源码移动而擅自迁移。

## Manager 登录与机器控制

本地管理器默认监听 `127.0.0.1:39980`，后端停止时仍可登录和管理。启动入口为 [`apps/manager/src/index.ts`](../../apps/manager/src/index.ts)，普通 API 分发为 `createManager`。独立 Manager 账号、Session、OIDC、可信访问地址和机器隔离规则只由 [Manager 认证协议](../shared/protocol/manager-auth.md) 定义；具体部署步骤见 [部署指南](relay-deployment.md)。

首次设置运行 `pnpm manager:dev auth setup`，恢复运行 `pnpm manager:dev auth reset`，均须本机交互终端隐藏输入密码。浏览器不再使用 URL token、header token、可读 token Cookie 或 localStorage，回环普通 API 也必须登录。机器密钥文件继续保留，仅给本机 CLI 使用，不打印秘密。

构建后运行 `node apps/manager/server-dist/index.js <命令>` 或 `pnpm manager:cli <命令>`：

```text
auth setup / auth reset       设置或恢复独立 Manager 账号
info / status                 从隔离的机器接口读取状态
start/stop/restart [backend|rathole]  控制 Manager 子进程（external 模式下 Backend 由部署工具管理）
service install / uninstall   安装或卸载本地服务入口
```

监听地址由 `manager.host` 配置，`CHERY_MANAGER_HOST` 优先。开放内网必须显式登记可信 origin；远程部署使用 HTTPS，反代信任也必须显式设置。不得用 rathole 映射 Manager 端口。

## 后端凭据与状态

登录后通过 `/api/credentials` 查看后端凭据、通过 `/api/credentials/rotate` 更新。这是后端账号，不是 Manager 账号；后端凭据仍在 `.chery/manager-credentials.json`（Unix 0600），后端配置只保存 scrypt 哈希。轮换后仅重启 Manager 自己的子进程；外部启动的后端不拉起副本。随后执行 challenge/login 自检，明确区分 verified、unreachable 和 stale，不把保存成功等同于后端已生效。

`/api/status` 与 `/api/connection` 展示 Manager、后端和 rathole 状态。后端检测读取状态文件并探测实际配置端口；文件和端口只提供运行摘要，不包含认证秘密。Manager 本身的登录、进程控制和凭据保存不依赖后端在线。

自动回归运行 `pnpm manager:test`，HTTP/OIDC 与入口测试在 [`apps/manager/test/`](../../apps/manager/test)，辅助函数回归在 [`apps/manager/test/server.test.ts`](../../apps/manager/test/server.test.ts)。真实 OIDC、跨设备访问、Linux systemd 和 Windows 托盘行为留给最终环境验证；不以构建通过代替部署证据。
