# 后端目录与配套启动

**文档创建时间：** 2026-10-16T09:45:57+08:00

**状态：** 待综合验证

**计划形式：** 单页

## 目标与授权

- 复杂度 4/5；沿用已确认模型，需要跨目录、进程、配置与部署检查能力。
- 用户批准破坏性修改：后端模板、开发数据、环境文件和 Manager 设置归 `apps/backend/`，一次迁移且不留旧路径兜底，保留会话、文件、账号与凭据。
- Manager 源码保留 `apps/manager/`；常规启动先监听 Manager，再由它启动 Backend。Backend 停止或失败不能关闭 Manager；整体退出清理受管进程，不能启动重复 Backend。
- 统一现有管理能力和服务归属，不新增 Web、Relay、NapCat 的启停实现，不授予任意服务管理权限。隧道仍由 Backend 设备客户端负责。
- 全部调整完成后集中检查，再启动本地环境查询模型和尝试生成一张 GPT 图片。真实接口缺少地址时明确阻塞；不自动重试收费生成。
- 不部署、重启生产，不发 QQ，不启动浏览器或读取图片。

## 实施顺序与完成条件

| 编号 | 工作 | 完成条件 |
| --- | --- | --- |
| R1 | 已实现：路径、环境加载与实际目录迁移 | 从任意工作目录启动均读取后端路径；根目录不再生成 `.env`、`.chery`、`.chery.template`；迁移前后文件内容一致 |
| R2 | 已实现并本地验证：Manager 配套启动与开发命令 | Manager 先监听，Backend 随后启动；停止、重启、启动失败及整体退出保持职责清晰，无孤儿进程 |
| R3 | 已实现并静态验证：构建、部署、依赖和所有引用 | 镜像与本机入口使用同一目录约定；模板链接与检查器同步，未实际部署镜像或系统服务 |
| R4 | 离线检查、本地启动和 GPT 单图实测通过 | 后端模型查询、文件服务生成、保存及重启后读取已验证；未查看图片或验收界面 |

## 依赖与验证

目录约定归[仓库结构](../../shared/architecture/repository-structure.md)，启动和进程职责归[后端运行](../../guides/backend-runtime.md)，Manager 认证边界归[Manager 认证](../../shared/protocol/manager-auth.md)。文件生图实现及验收仍由[文件能力任务](../file-capabilities-and-model-collaboration/README.md)维护；本次调整后其原环境相关验证待重验。

集中验证入口：`pnpm type-check`、`pnpm manager:type-check`、`pnpm manager:test`、后端路径/模板/启动/配置事务及文件服务相关测试、Backend/Manager 构建、部署脚本静态检查、`pnpm docs:test` 与 `pnpm docs:check`。所有实现完成并逐项核对后执行，不逐步完整测试。

## 当前恢复检查点

- 阶段性提交已建立：迁移相关改动已作为独立提交（模板与环境文件迁入 `apps/backend/`、运行根解析、部署路径与文档引用更新）进入历史；文件能力、认证、中转、QQ、ADV 等其他任务的修改仍保留在工作区未提交。`config.ts`、Manager `server.ts`/`index.ts`、部分测试与文档因两类改动交织，其迁移部分随本提交、其余部分随各自任务提交；根 `package.json` 的 sharp 依赖随文件能力任务提交。
- 根目录 `.env`、`.env.example`、`.chery/`、`.chery.template/` 已迁入 Backend。`CHERY_DIR` 指向 `apps/backend`；迁移时核对运行目录 66 文件、模板 35 文件内容一致。受限完整迁移备份在 `/tmp/opencode/backend-layout-backup/`；模板同步仅更新仍为官方原版的文档。账号、凭据和数据没有丢弃。
- `backend-layout.mjs` 为两个入口提供同一环境与运行根解析；系统环境优先。安装只初始化 Backend 目录；根目录没有重建旧文件。`pnpm dev` 与 `pnpm manager:dev` 配套启动，`pnpm manager:build` 同时构建页面与服务器。启动/重启的端口检查与进程操作按同一服务串行执行，关闭时拒绝再启动。
- Compose 默认由同一配套镜像启动 Manager 与 Backend，不再定义单独 Manager 容器；保留显式外管模式防重复实例，不保留旧目录回退。隧道归属不变；Manager 不获得 Docker socket 或任意系统服务管理权限。
- 当前集中结果：Backend/Manager 类型与构建通过；Backend 路径/模板/配置/工具及接入相关 43 文件、292 项；文件服务相关 11 文件、107 项；Manager 全部 31 文件、168 项；Web 模板相关 1 文件、3 项；文档检查器 9 项均通过。`pnpm docs:check`、Compose 配置静态检查通过。日志在 `/tmp/opencode/layout-*-types.log`、`layout-*-build.log`、`layout-*-tests.log`、`layout-docs.log` 与 `layout-compose.log`。未跑后端全仓测试，不将局部结果扩展为全仓通过。
- 本地实测：开发模式使用回环地址及空闲管理端口 39981，Manager 日志先于 Backend 健康事件；机器认证状态接口和 Backend HTTP 均返回 200。通过 Manager 停止 Backend 后，Manager 仍返回 200，Backend HTTP 关闭；再次启动成功。构建后的 Manager 另用随机空闲端口验证启动、重启与整体退出，退出码 0。两次验证均已关闭自己启动的进程，未留下 Backend、nodemon 或端口监听；原有 39980 进程未停止或重启。
- 现有浏览器可信地址配置拒绝测试管理端口的普通请求（403）；未放宽登录限制。本次用回环机器认证验证；容器健康检查同样使用受限机器凭据，不依赖浏览器可信 Host。
- 用户提供地址 `https://ai.xcherry.top`。真实模型列表返回 22 个型号，后端 `utils.models` 使用 `/v1` 基础地址再次确认 `gpt-image-2` 可用；默认聊天大脑未修改。
- 本地配置新增 `file_services.gpt-image`：`openai-images`、`gpt-image-2`、`keyRef: $API_KEY`，仅声明已实测的 `image.generate`，默认单张/low/PNG/1024×1024。没有把明文密钥写入配置。服务地址不含版本时由文件适配器追加 `/v1/images/generations`。
- 单张真实调用经后端 `runFileOperation` 执行（源码维护脚本调用服务层，不是浏览器或完整 HTTP 试用验收）。操作 `ba1559cf-175f-4143-8849-6df24be8b356`，执行 `succeeded`、保存 `saved`，输出一个 PNG 资产 `6698a383-d622-4efb-b1a6-5147e63a1699`，版本 `bf5210b4-72e4-4b7c-9e65-9278a6f8dfc3`，1459345 字节。请求固定 ID `gpt-image-real-2026-10-16-single-01` 防重复生成；未自动重试生成。
- 请求 1024×1024，服务返回文件的元数据为 1254×1254，按真实值保存，尺寸遵从未通过；未为此再次生成。服务 usage 为 input 32、output 515、total 547 tokens，不据此推断实际金额。没有读取图片内容，inspection 为 `not_requested`。
- Backend 重新启动后 HTTP 返回 200；另一个独立进程读取持久操作与固定版本元数据、核对磁盘文件大小，并确认其他身份访问被拒绝。证据在 `/tmp/opencode/gpt-image-real-result.json`、`gpt-image-real-test.log`、`gpt-image-verify.log`，开发运行日志在 `gpt-image-development.log`。
- 单张实测结束后已关闭本次开发 Manager 与其 Backend，保留服务配置和已保存资产；原有 39980 进程未停止或重启。
- 大量未提交修改属于本任务前的文件能力、认证、中转、QQ、ADV 等工作。逐段保留，不重置、不提交、不改写生产数据。
- 实测条件：图片服务已配置并实测；默认聊天大脑仍是原占位配置，`LLM_API_KEY` 提示不影响单独引用 `API_KEY` 的图片服务。不把图片接口通过等同于聊天功能已配置。

## 待处理事项

- 图片内容、界面、模型编辑与其他厂商/渠道尚未验收；服务返回尺寸不符合请求尺寸，需按服务方行为说明，不擅自宣称精确尺寸可用。
- Docker 镜像实际构建/部署、systemd 和 Windows 实机未执行；不声称已通过这些环境验收。
- 全局 `git diff --check` 仅报告其他任务 `docs/guides/relay-deployment.md:12` 末尾空行，未为掩盖它修改无关文件。
- 用户最终验收与完成审批待执行。
