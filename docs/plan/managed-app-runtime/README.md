# 受管工作容器与小应用运行

**文档创建时间：** 2026-10-15T16:50:33+08:00

**状态：** 执行中

**计划形式：** 总任务与专题设计；实现小任务在获得开发授权后按 WP1–WP5 拆分为执行卡片。

## 目标与授权

为 `cheryNyxus` 提供专用受管小应用与命令执行体系：模型在与 Backend 平级的可丢弃工作容器内开发、构建和运行小应用，文件与用户专用空间一致，对外通过统一域名和路径 `/qq/{userId}/apps/{appId}/` 交付。**现有 Backend、QQ、NapCat 和其他常驻服务的稳定运行最高优先**，小应用是受严格配额约束的附加能力。

用户已确认 D1/D2/D3 默认方案 A 并授权在当前会话按 WP1 → WP5 顺序一次领一个任务开发、完成全部源码后集中验证，最后统一构建部署实测。设计整理复杂度 `3/5`，跨宿主机 cgroup/配额、控制器、模板镜像、防绕过与网关的完整实施复杂度为 `5/5`。

原有配置、登录、允许名单、预设、用户文件及其他任务改动必须保留。

## 阅读入口

| 文档 | 唯一维护内容 |
| --- | --- |
| [开发设计](design.md) | 实测环境与代码基线、3 项待决拍板、控制面隔离、全路径防绕过、身份与目录锁、磁盘硬配额方案、全量资源公式与 4 GiB 回落状态机、`managed_app` 工具契约、固定模板离线依赖、同域网关与网络隔离、生命周期与通知、WP1–WP5 开发顺序 |
| [验收要求](acceptance.md) | 实施完成核对清单、A01–A20 自动化验证矩阵（含具体测试方法与通过判据）、LAN/公网部署与用户实机验收步骤 |

现有实现定位：后端[服务层](../../backend/service/README.md)、[Agent 内置感官](../../backend/agent/sense.md)、[接入插件契约](../../shared/architecture/ingress-plugins.md)、[QQ 模块](../../../plugins/qq/README.md)。通用文件与模型协作由文件能力计划（独立任务，不在本次提交范围）维护，本任务不接管其实现和状态。

## 工作与完成条件

| 工作包 | 状态 | 完成条件 |
| --- | --- | --- |
| 汇总详细设计与验收合同 | 已完成 | 全部功能、交互、卡点、堵点、防绕过、配额公式、状态机与开发顺序已落盘并通过文档检查 |
| WP1 宿主机底座与受限控制器 | 已完成 | `cherynyxus-apps.slice`（2 GiB/4 GiB）、XFS loop 或 ext4 硬配额、`cherynyxus_apps_net` 网络隔离与 `cheryNyxus-app-controller` 实测生效 |
| WP2 固定模板与工作容器镜像 | 已完成 | Node 24 + Vue + Express + SQLite + 鉴权/图表/CSV/附件/SSE 固定镜像断网构建与运行通过 |
| [WP3 模型工具与防绕过收口](design.md) | 进行中 | `managed_app` 工具接入，真实 `subject.userId` 贯通，`execute_command`/文件/MCP/`spawn_role` 旁路封堵测试通过 |
| [WP4 动态网关、生命周期与通知](design.md) | 进行中 | `/qq/{userId}/apps/{appId}/` HTTP/SSE/WS 代理、停止状态页、24h 空闲、7d 租期、周一 `04:00` 清理与 Outbox 通知通过 |
| WP5 综合验证、部署与用户验收 | 未开始 | A01–A20 自动验证、LAN `10.2.3.6` 与 `mini.xcherry.top` 真实链路验证及用户验收通过 |

## 当前恢复检查点

- **提交范围检查**：QQ核心暂存快照独立验证，Backend与QQ类型检查通过；Backend定向82项、QQ插件定向24项、NapCat适配与通信24项通过。共享文件按内容拆分，排除文件生图、Manager/Relay、目录迁移与ADV；保留本计划列出的综合验收缺项，提交不等于全部真实场景验收。

- **应用彻底删除**：新增managed_app delete及deleteApp RPC，仅可信本人指定应用，活动任务拒绝，停止容器后清代码/数据/备份、XFS限制、登记和通知；软链路径拒绝。Backend类型检查及40项定向测试通过；控制器payload 8234408d2ae79266259ed32692b5cbc0fe0ffdd5a3c8f3c55ff0b3131b3034e4已安装、NRestarts=0；Backend已部署apps-delete-20261016并healthy，QQ/NapCat连接与身份正常。独立delete-live-probe经真实RPC创建、写数据、跨用户删除拒绝、本用户删除成功，随后核实两处目录不存在、容器不存在、应用登记消失。未删除QQ新建应用；QQ模型自然语言触发delete仍待用户验收。

- **固定依赖扩充已部署**：runtime latest 为 `sha256:b96167993c2000e7a649e06743a45a788d18777cbb61c633a6d20960555f9396`，新增 UI/离线图标、状态与交互、Tailwind/SCSS、内容处理工具，具体清单见设计7.3及模板package.json。新依赖从npm注册表核实并固定版本；弃用的lucide-vue-next未纳入，使用@lucide/vue。断网、只读根、1.5GiB/1.5CPU/256PID下组合构建通过，模板外安装仍拒绝。QQ重新创建的vue-hello-test已保留代码/数据并更换为新镜像，发布health=ok，LAN/公网HTML/JS/CSS均200。Backend、Manager、NapCat未重建。未将测试页面重新写入用户项目。组合测试刻意全量引用产生大包警告，真实项目需按需引入与分包；不默认全量加载所有库。

- **当前应用状态**：旧测试代码已按要求清空；随后QQ自行重新创建了vue-hello-test，当前代码由QQ生成，本会话仅更换运行镜像并重新发布，未覆盖其代码或数据。vue-hello-page与wp3-probe仍保留空目录及应用登记。主服务、运行模板、配置、登录与share文件未动。

- **执行边界**：当前主 Agent 使用 `gpt-6.1-sol` 串行实施，无子 Agent；共享工作区为 `/home/chery/dev/cheryClaw`。保留配置、登录态、队列、用户文件和其他任务改动，不自动发送 QQ 消息，不启动浏览器。
- **已部署基线**：Backend 当前镜像 `apps-retry-20261016`，容器 running/healthy；`apps-release.yaml` 挂载受限控制器 Socket 并固定应用网络172.29.0.2。QQ 模块0.1.21、配置revision12已应用，NapCat连接与可信身份正常。QQ工具组使用managed_app，不提供Backend普通命令。Nginx应用路由已接入，LAN与公网不存在应用均返回503，仅证明请求到达网关。旧临时Hello World进程及目录随旧Backend容器替换清除；旧模型上下文已隔离、讨论缓存已清空，任务/投递/登录/配置保留。Manager保持原运行版本。
- **当前真实重试阻塞**：请求 `72da6722-4bd2-47dd-ba97-673633424f34` 创建了vue-hello-test和vue-hello-page，但均serviceReady=false，30次工具调用后达到上限。独立受管build调用复现tc ingress filter replace返回File exists；已有私有police动作重复创建导致后续命令/发布无法推进。networkLimits已改为复用当前filter绑定的私有action索引并保持聚合限速；5项网络测试及Backend类型检查通过。控制器首次更新在启动reconcile阶段仍因matchall filter replace返回File exists失败，未通过真实验收。二次修复保留已核实的ingress/egress绑定，仅更新私有police action；异常绑定fail-closed，不删除限速规则。5项定向测试与类型检查通过；最新payload SHA256为3cb56aa51d3ca2be47540a4533209906c073ff4b15b1757276c7cfb33bab21c8，安装脚本失败会直接显示journal。控制器已安装，文件校验一致、active/running、NRestarts=0。重启曾重建/run通信目录导致Backend旧bind挂载看不到Socket；确认无活动任务/待投递后只重建Backend容器，连接已恢复。真实受管命令连续执行成功，vue-hello-test构建及startAppService发布成功，health=ok；应用Vite配置已补APP_BASE以避免资源落到站点根目录。Backend LAN8283、LAN80及公网应用HTML/JS/CSS均200且类型正确。QQ0.1.21/revision12已应用、NapCat连接和可信身份正常。未提高30次上限、未自动重放群消息；QQ模型自主创建到交付及用户视觉验收仍待用户触发。控制器后续重启仍需注意RuntimeDirectory重建使既有容器挂载失效的维护风险。
- **本次重试修正**：真实群请求create遗漏appId；请求内执行器将INVALID_INPUT正文丢弃并改为通用拒绝，模型因此错误要求用户重试。已保留错误正文、补充create必需参数及修正提示；29项定向测试、Backend类型检查、构建和镜像构建通过并已部署。日志中的interrupted来自请求内工具没有终态chunk的收尾统计，不能作为实际handler被提前取消的证据。未自动重放群请求；下一次真实QQ创建与发布仍待用户触发。
- **源码与自动验证**：受管命令、身份限制、取消、网关、生命周期、通知、备份与 veth 限速已有实现。最新 Backend 全量 `1925` 通过、`5` 跳过；Web `848` 通过；协议 Backend `573` 通过、`1` 跳过，协议 Web `7` 通过；Manager `164`、Relay `32`、插件 `38` 通过。全项目类型检查、文档测试 `9` 项和文档检查通过。协议场景覆盖父任务接收子结果后的自动恢复；配置安全检查按每会话最新持久运行判断，并继续检查全部内存运行预留、子任务、问答与审批。
- **统一构建产物**：`npm run build:all` 通过；Docker 镜像 `cherynyxus-backend:apps-close-final-2c2e203c`（`17ab201cfc4e`）、`cherynyxus-manager:apps-close-final-2c2e203c`（`2a0dde744221`）、`cherynyxus-app-runtime:latest`（`7cea1556d284`）已构建并 inspect 确认。控制器 bundle 已生成于 `$TMPDIR/controller-daemon.mjs`，未安装到 systemd 路径。
- **运行镜像验证**：新 runtime 在无网络、只读根、无 capability、禁止提权、1.5 GiB/1.5 CPU/256 PID 的构建额度中完成固定模板构建、SQLite 与附件快照打包及解压恢复；外部装包和根 `/api` 请求分别拒绝为 `DEPENDENCY_NOT_IN_TEMPLATE` 与 `APP_BASE_REQUIRED`。200 MiB 常态额度执行构建被内核终止（137），不作为构建通过；正式构建必须走瞬时额度。
- **部署阻塞**：`sudo -n true` 返回需要交互认证。需用户在宿主机完成提权授权后更新控制器及网络限速；不得绕过权限或索取聊天密码。统一部署前还需明确 Socket 挂载、专用网络、工具配置及当前安装 QQ 包的更新入口，不直接按现有 Compose 启动冒充接入完成。
- **剩余验收**：真实 tc 吞吐与重建对账、资源回落/压力保护、网关 HTTP/SSE/WS 与关闭排空、容器内控制器备份链路、LAN/公网与原 share 路径、真实 QQ 身份和通知均未完成。最终镜像尚未替换运行服务，旧镜像未清理；用户真实 QQ 和视觉验收仍须人工触发。已有 `wp3-probe` 已停止，持久目录仍待精确核对和清理。
- **差异检查**：全工作区 `git diff --check` 仍报告 `docs/guides/relay-deployment.md` 文件尾空行；不擅自覆盖共享任务文件。未创建提交。
- **日志位置**：本轮证据位于 `$TMPDIR/managed-*`；关键日志为 `managed-backend-final-check.log`、`managed-test-web-final.log`、`managed-test-protocol-gate.log`、`managed-type-check-all-gate.log`、`managed-build-release.log` 和三个 `managed-*-image.log`。这些是可重建日志，不是正式用户验收结论。

## 已确认方案与环境事项

1. **已确认 D1（同域信任范围）**：默认仅限自用及可信内容走 `mini.xcherry.top/qq/{userId}/apps/{appId}/`；若需向不互信多用户开放私密数据，须启用独立应用子域名。
2. **已确认 D2（主机极端压力时的动作）**：正常额度不足一律只排队/拒绝；当宿主机整体内存/磁盘跌破紧急红线时，默认仅取消临时构建任务（不主动关已运行应用），未获额外授权不得停止其他应用。
3. **已确认 D3（模板默认鉴权激活方式）**：默认采用应用独立账号表 + 创建后生成一次性管理员激活链接（不在聊天发密码）；不接入平台管理登录。
4. **宿主机一次性底座配置（WP1 执行项）**：当前 `/dev/nvme0n1p2` 未启用 `prjquota`，实施 WP1 时优先采用受管 `XFS` loopback 配额卷挂载（无需改根分区 `/etc/fstab`），并在宿主机配置 `cherynyxus-apps.slice` 与 `cherynyxus_apps_net`。
