# QQ 图片、错误事实、Manager 平台与指令停止归档后续审核清单

## 范围

本清单归档以下已结项任务中尚未在生产或浏览器人工完成的细枝末节验证项与外围边界。正式功能与协议事实以 [`plugins/qq/README.md`](../../../plugins/qq/README.md)、[`docs/shared/protocol/qqbot-plugin.md`](../../shared/protocol/qqbot-plugin.md)、[`docs/shared/protocol/errors.md`](../../shared/protocol/errors.md)、[`docs/shared/architecture/manager-management.md`](../../shared/architecture/manager-management.md)、[`docs/shared/architecture/manager-plugins.md`](../../shared/architecture/manager-plugins.md) 和 [`docs/guides/backend-runtime.md`](../../guides/backend-runtime.md) 为准。

## 1. QQ 错误事实与受控问答外围验证

普通群问答已于 2026-10-20 在 `980129567` 群完成生产实测（问题和最终回复均有 `sent` 回执，同一 run 续接完成且 Core 只记录一次用户输入）。以下外围边界留待后续统一验证：

- 真进程重启窗口和并发恢复：安全错误事实到达后进程重启，同一 run 晚到的通用事件不得覆盖原因或发重复通知。
- 权限边界：原发起者之外的群成员、跨目标或连接的引用不能续接；权限与配置变更应使旧问题失效。
- 问题审批拒绝、取消以及工具审批等待后输入闭环；群消息不能批准工具。
- 全部错误生产者、错误码与渠道投影的独立审查，包括断开的 WS 与迟到错误事件。
- 问题送达确认未知、答案持久化后续接确认未知：不重放物理消息，不创建第二条输入；后续相同输入只核对原命令。
- 多个目标同时处理与同目标并发消息的恢复/串行边界。

## 2. QQ 群图片上下文后续验证

原生图片采集（QQ `0.1.40`、NapCat `0.2.14`）及 `settings 2.0.4` 严格 schema 已部署，真实群新消息（`640413920`）自动单图采集、资产提交及会话授权已通过生产验证。以下项目留待后续统一验证：

- 真实模型视觉理解与多图背景：普通群图作为背景、同群引用复用固定资产、不同发言者关系、感知相似去重边界及一轮到期后保留原件。
- Manager 浏览器登录后设置页实际操作：在浏览器登录 `http://10.2.3.6:39980/` 操作文件策略与 QQ 图片原件配额界面（当前仅完成认证 API 与 UI 静态资源摘要核验）。
- 原生撤回与监听物理注销：QQ 原生撤回事件入站协议（当前核心撤权测试不代表 QQ 原生撤回）、`removeKernelMsgListener` 物理注销实机效果，以及全链路高负载峰值/真实磁盘写满边界。

## 3. Manager 平台化与 Backend 启动监控（第一阶段）人工审核清单

同容器受管模式（`cherynyxus-runtime:managed-20261020`）与外部模式监控修正已部署，预装 `backend-manager` 插件、5s/15s/30s 最多 3 次异常重试、5 分钟稳定清零、离线平级插件置灰及自动测试已通过。以下浏览器人工操作留待后续统一审核：

- 登录 Manager（`http://10.2.3.6:39980/`）进入「插件管理」，确认默认预装 Backend 管理插件与 QQ、设置等平级展示。
- 检查 Backend 管理插件面板的服务状态、CPU/内存/运行时长、进程日志、“随插件启动 Backend”开关持久化，以及 Backend 未启动时平级插件卡片的“依赖 Backend 运行，当前不可用”置灰提示。

### 维护验收结论与适用范围

用户于 2026-10-26 明确接受生产 `rathole` 和外部 Relay 未验证的限制，并要求结束本批任务、提交相关修改。Manager 维护、工作台入口与媒体交互、命令监控 A–F、隔离 Relay/设备配置及真实 QQ 停止恢复的本次范围已经结束，不要求重复验收。未验证限制不记为通过：

- Relay 使用真实服务、真实客户端和 Manager HTTP，但隧道子进程使用测试实现；生产二进制及外部隧道未验证。
- F 只显示 0 秒的情况已获接受，完整倒计时与实际强制退出耗时未独立测定；不宣称精确十秒实测通过。
- 未刻意制造真实未知 QQ 发送；未单独确认的其他设置分项、无工具短文的逐字标点一致性不扩大为通过。
- 文件、绘图及首次查询 400 仍由[文件能力独立跟进入口](file-capabilities.md#独立跟进入口)处理，不随本批结束取消或冒充通过。

原始检查报告保存在仓库外 `/home/chery/docker/cherynyxus/releases/manager-maintenance-verification-20261026/`，`README.md` 说明用途，`manifest.json` 记录逐文件摘要；维护者在替换证据或清理前核对本页引用。该目录不是部署入口。已有发布目录、持久数据和备份保持，不能用旧工作区覆盖后续 QQ 部署。下列版本与数量各自只适用于对应检查，不代表当前混合工作区重新通过全量测试。

### 提交前隔离检查

对象为原提交 `004f69a2` 加本批按功能选定的修改，不包含未提交的 QQ 来源、文件、模型及 ADV 修改。未重新部署、调用模型或重复 A–F。命令与输出由验收证据目录的 `closeout-checks/` 保存；运行工具使用已有安装入口，不重新安装依赖。

| 检查 | 本次结果 |
| --- | --- |
| Manager 定向测试 | 10 文件、93 项通过；另 1 文件 `management.test.ts` 在 QQ 插件启动前提处失败，6 项未执行，不记通过 |
| Backend 定向测试 | 7 文件、30 项通过，覆盖同源业务连接、两处无变更角色选择、状态及统一命令退出/日志 |
| Web 定向测试 | 7 文件、39 项通过，覆盖 HTTP 编号兼容、配置并发与目标隔离、登录读取、入口名称、交互与标题栏回归 |
| Relay 全量测试 | 13 文件、34 项通过 |
| Manager 页面构建，QQ/设置隔离安装包构建 | 退出 0；只供测试，不升级实际安装包 |
| Manager、Relay、Web 类型检查 | 均退出 0 |
| Backend 类型检查 | 退出 2；`service/chat/send.ts` 的恢复调用参数与 `service/ingress/coreAdapter.ts` 的未使用 `submitting`。原提交单独检查得到完全相同的两条错误，本批不修改这些其他任务文件 |
| 文档测试与静态差异检查 | 文档测试 9 项通过，本批差异检查通过；磁盘配额不足造成的早期检查失败另存，不作为通过结果 |
| 全仓文档检查 | 链接、结构、元信息通过；其他任务 `docs/plan/wechat-integration/README.md` 的 `PLAN_UNREGISTERED`、`PLAN_MISSING` 两项仍使综合检查退出 1，本批不改该任务 |

Manager 的 QQ 测试前提失败在不含本批修改的原提交上也复现；选定副本的诊断为旧 QQ `0.1.41` 未能 active、`STOP_TIMEOUT`。这不是当前线上 QQ `0.1.54` 的验收结论，也不以安装后续专题代码绕过本批提交范围。上述基线限制不改变已部署版本的验收证据，不能宣称本次独立提交副本全量检查通过或直接覆盖线上版本。

### 当前自动检查与实现差异

2026-10-21 在 Linux x64、Node.js v24.19.0、Vitest v4.1.9、提交 `77af4f3214b309e76f5947b89c85201a5809cabd` 加本轮未提交工作区上执行。检查对象包括 Manager 维护调用和状态读取、Backend/Relay 状态写入、共享状态格式及 Web 局部修复；其他任务的改动保持。测试使用临时账号、文件和合成服务，不证明生产环境曾发生密钥泄露，也不代替实际部署或真实服务验收。

| 检查 | 当前结论 |
| --- | --- |
| `TMPDIR=/tmp/opencode pnpm manager:test` | 通过，退出码 0；41 个文件、235 项测试全部通过。 |
| `TMPDIR=/tmp/opencode pnpm test:web` | 通过，退出码 0；152 个文件、890 项测试全部通过。 |
| `TMPDIR=/tmp/opencode pnpm relay:test` | 通过，退出码 0；13 个文件、34 项测试全部通过。 |
| 下述两组 Backend 定向命令 | 通过，退出码均为 0；9 个文件、45 项测试通过，不代表 Backend 全量测试。 |
| `pnpm type-check`、`pnpm manager:type-check`、`pnpm relay:type-check`、`pnpm web:type-check` | 全部通过，退出码均为 0。 |
| `pnpm build`、`pnpm manager:build`、`pnpm relay:build`、`pnpm web:build` | 全部通过，退出码均为 0；Web 保留构建包大小提示，不影响构建成功。 |
| `pnpm docs:check` | 通过，退出码 0；链接、目录结构、计划和元数据检查全部通过。 |
| `pnpm docs:test` | 通过，退出码 0；9 项测试全部通过。 |

Backend 两组命令均以 `TMPDIR=/tmp/opencode pnpm exec vitest run --config apps/backend/vite.config.ts` 为前缀，以 `--no-file-parallelism` 结尾，分别指定下列真实文件：

- 状态与控制：`apps/backend/test/service/runtimeStatus.test.ts`、`apps/backend/test/service/crossEndCompletion.test.ts`、`apps/backend/test/service/crossEndRepair.test.ts`、`apps/backend/test/service/backendStopCoordinator.test.ts`、`apps/backend/test/service/guardianLifecycle.test.ts`。
- 中转与命令生命周期：`apps/backend/test/service/relayLifecycleCompletion.test.ts`、`apps/backend/test/service/commandRuntime.test.ts`、`apps/backend/test/service/commandLogs.test.ts`、`apps/backend/test/service/chat/inputCommandLifecycle.test.ts`。

关键断言与入口：

- Manager `crossEndCompletion.test.ts`、`backendMaintenance.test.ts`、`auth.test.ts`、`regression.test.ts`：全局中转密钥不发送到可编辑目标；健康和认证请求不跟随重定向；退役接口为 410，浏览器轮换机器凭据为 409 且不保存、不重启；设备操作先发现能力、只调用固定路径、未知写入不重发。
- Manager `independence.test.ts`、`independentStartup.test.ts`：机器身份缺失或损坏时仍能启动和登录，本地配置可保存，账号、凭据和密钥不被初始化或覆盖；离线安装列表与真实远端模块发现分别验证，维护失败不撤 Manager Session。
- 两端 `runtimeStatus.test.ts`、Relay `statusExpiry.test.ts`：Backend 按 3 个实际上报周期到期，中转按当前连接确认的期限到期；未来时间、旧实例、错误设备或配置不作为当前运行依据，发送心跳及旧连接迟到确认不延长期限。`backendSupervisor.test.ts` 还在资源读取期间安排真实退出，核对状态和 PID 不混合。
- Web `interactionSafety.test.ts`、`settings/brainConnection.test.ts`、`architecture/vueSfcSizeBudget.test.ts`：保留草稿与附件交互检查、模型查询和连接测试参数及迟到结果隔离，保留原 800 行限制与文件能力任务的改动。

原始材料在上述验收证据目录的 `manager-maintenance-repair-20261021/` 与 `agent-command-closeout-20261021/`；通过输出与修复前失败输出分开。当前发布结果见[实际部署检查](#实际部署检查)，人工结果与限制见[维护验收结论](#维护验收结论与适用范围)。

### 独立发布与实际环境准备

2026-10-21 用户授权部署及必要启停、实际环境接口检查和验收准备；不包含主动 QQ 发送、付费模型请求、浏览器或图片操作、暂存及提交。部署使用仓库外 `compose.yaml` 与 `apps-release.yaml`，保留挂载、小应用网络，并增加下述发布叠加文件。当前机器状态、Web 地址及版本核对由[实际部署检查](#实际部署检查)维护。

为避免上线其他任务未完成代码，从上述基础提交导出副本，仅加入本次 Manager、Backend/Relay 状态修复及 Web 连接逻辑提取，排除文件能力、上下文、QQ、设置与 ADV 的未提交业务改动。副本与混合工作区不同，单独检查如下，不能与上表结果混用：

| 独立副本检查 | 当前结论 |
| --- | --- |
| `pnpm manager:type-check`、`pnpm type-check`、`pnpm web:type-check` | 失败，退出码均为 2。基础提交引用缺失的 `DrawingIntent`、`ImageOutputCapabilities`、`brainCapabilities`、绘图组件等；还存在 `ErrorId`、`isManagedRequest` 及图片输出函数未定义、已有类型缺字段等错误。 |
| `pnpm plugins:test` | 失败，退出码 1；`assetMessages` 的 4 项和 `reliableDelivery` 的 7 项失败，分别涉及图片来源等待与讨论总结实现未配齐。 |
| `pnpm relay:type-check`、`pnpm relay:test`、`pnpm relay:build` | 通过，退出码均为 0；只覆盖副本的 Relay，不代表整套可发布。 |

副本使用原已安装依赖的独立复制，按 pnpm 官方配置关闭运行前自动安装；未读取第三方依赖源码。离线重新安装曾因缓存缺少安装包失败，该准备问题与上述源码检查失败分开。清单和失败输出保存在验收证据目录的 `manager-maintenance-release-20261021/`；无部署价值的提取副本和一次性脚本不保留。

用户选择扩大发布范围，允许相关文件能力、上下文、QQ 与设置改动一起核对、修复、验证和部署；不包含 ADV 固件或额外业务规则。上述提取副本仅作为失败证据，不能用于部署；扩大范围的固定副本及集中检查输出使用 `/tmp/opencode/manager-maintenance-expanded-20261021/`，不复用旧通过结论。数据保留与实际发布结果见[实际部署检查](#实际部署检查)。

扩大范围固定副本的最终离线结果如下，退出码均为 0。原始输出由当前执行者保存在上述任务目录，当前仍供发布核对使用；跳过项不算通过。

| 检查 | 结果 |
| --- | --- |
| `pnpm test:backend --maxWorkers=2` | 272 文件、2719 项通过；1 文件、5 项跳过 |
| `pnpm test:protocol` | 协议 16 文件、618 项通过，1 文件、1 项跳过；角色协议 2 文件、7 项通过 |
| `pnpm manager:test`（先构建插件和页面） | 39 文件、233 项通过 |
| `pnpm test:web --maxWorkers=2` | 152 文件、890 项通过 |
| `pnpm relay:test`、`pnpm plugins:test` | Relay 13 文件、34 项；插件 24 文件、130 项通过 |
| NapCat 独立 Vitest | 5 文件、42 项通过；不表示部署或操作了实际 NapCat |
| Backend、Manager、Web、Relay、QQ、设置、NapCat 类型检查及构建 | 全部通过；Web 有体积提示 |
| 当前工作区 `pnpm docs:check`、`pnpm docs:test` | 全部通过；文档测试 9 项通过 |

旧进程注册接口、旧日志清理断言、按用户文字识别摘要的旧预期、QQ 恢复清队列后的原因字段、子进程脚本及协议核对记录已经按正式约定修正；测试未恢复旧产品入口。新镜像使用已运行镜像的固定 ID 为基础；断网且不挂生产数据的容器已确认 Node v24.19.0、ABI 137、SQLite/sharp、Manager 机器状态 200、Backend 运行、Web HTML 200、未认证 API 401。此检查没有真实模型或 QQ 操作，不代替实际发布。

生产只读预检：新源码可解析现有 QQ 状态与插件 registry；隔离副本配置可加载，不需要文件配置迁移。预检没有启动业务服务、调用模型或发 QQ，不表示实际部署或用户验收通过。

### 实际部署检查

2026-10-21 已完成用户授权的实际部署及首次登录连接修复更新。登录修复基线镜像 `cherynyxus-runtime:web-login-connection-20261021` 的 ID 为 `sha256:afcfad83e5de9b1601d4fd6e91397a10a00a097fde91a7e5f90f340e6d714ebc`，Backend/Web 产物来自同一固定副本；Manager、生产依赖与安装插件沿用已核对的基础发布。登录修复目录 `/home/chery/docker/cherynyxus/releases/web-login-connection-20261021/` 保存源码与产物清单、部署叠加、备份结果、完整业务连接及 HTTP/生命周期证据，基础发布材料保存在相邻 `manager-maintenance-20261021/`；实际运行版本和维护叠加以[首次进入检查](#工作台首次进入检查)为准。

- 旧 Backend 通过普通关闭确认 PID 为空、phase=stopped 后才停止容器，没有强杀。停止后的数据、个人文件、秘密及实际 Compose 配置保存在 `/home/chery/docker/cherynyxus/backups/manager-maintenance-20261021/persistent.tar`，1,152,942,080 字节，已用 tar compare 与源文件比较通过；SHA-256 为 `ec8aa6185f1b0ba98b6a486cb43d3182cbb73e1224952efc1d463b03858dd920`。
- QQ 0.1.42、设置 2.0.5 安装到新版本目录，保留全部原能力、渠道授权与启用状态。两插件均 active/applied，保存与应用版本一致；QQ 配置 revision 16、设置 revision 0 保持。
- Manager 账号、机器凭据及其加密密钥、机器 token、QQ 连接 token、核心配置和环境文件的字节摘要保持一致；原挂载、小应用网络及控制器连接保持。
- 新 Manager 重建后没有绕过持久停止意图自动启动 Backend；显式启动成功。新版本又完成一次普通停止/启动，确认旧实例实际退出、Manager 继续运行、新实例 ID 改变。没有用闲置停止替代带任务取消或强制期限验证。
- Manager `http://10.2.3.6:39980/`、Web `http://10.2.3.6:8283/` 及入口脚本/样式均为 200，并与发布产物逐字节核对。Backend API 未认证为 401，机器状态为 running。没有浏览器或视觉验证。
- 当前 QQ 部署暂停保持 `QQ_INGRESS_PAUSED=0`，QQ 0.1.42、设置 2.0.5 均 active/applied，配置 revision 16 与 0 保持；Backend 状态中的 NapCat 连接与身份为 true，QQ 在线字段为未知，不冒充在线证明。既有用户触发引用文字收发与限制见[QQ 完整纯文字收发](file-capabilities.md#qq-完整纯文字收发)。本次连接修复没有模型、主动 QQ 发送或 NapCat 操作。

连接修复更新前已确认无活跃任务，Manager 普通停止至实际 PID 为空及 phase=stopped 后才停止容器备份，未强杀；备份 `/home/chery/docker/cherynyxus/backups/web-login-connection-20261021/persistent.tar` 为 1,155,287,040 字节，与源文件 tar compare 通过，SHA-256 为 `ad20f3bb0fc20e0084fe7068687a379b4b86b8fcd6bc8367bd64954c72800670`。新 Manager 保留停止意图、没有业务子进程；显式启动后 Backend 实例改变。17 项账号、凭据、核心与插件配置等文件摘要、原挂载、网络、端口和 QQ 开关逐项相同；容器 healthy。实际 Compose 使用原 compose.yaml、apps-release.yaml、基础发布 release.yaml 与当前发布 release.yaml 四层，不能漏掉基础发布环境字段。

### Web 登录连接检查

用户反馈首次登录“连接服务器失败”、恢复与刷新无效，非浏览器请求定位到同源业务 `/ws` 没有转交现有业务服务器，以及启动 `chat.list` 缺少必填 scope。当前实现复用原票据、Origin、协议选择、身份与撤销，不放宽认证；启动读取使用 stage、最多 1 条且不含预览。

| 当前固定副本检查 | 结果（退出码均为 0） |
| --- | --- |
| `pnpm type-check`、`pnpm build:prod`、`pnpm web:type-check`、`pnpm web:build` | 通过；Web 有构建体积提示 |
| `pnpm test:backend --maxWorkers=2` | 273 文件、2725 项通过；1 文件、5 项跳过 |
| `pnpm test:web --maxWorkers=2` | 152 文件、893 项通过 |
| `pnpm test:protocol` | 协议 16 文件、618 项通过，1 文件、1 项跳过；角色协议 2 文件、7 项通过 |
| 实际 `http://10.2.3.6:8283/` HTTP/WS 流程 | 密码登录、身份、配置、票据、同源业务连接、有效 `chat.list`、新票据重连及退出关闭连接全部通过；缺票据、旧票据、错误 Origin、错误实例和空查询参数均拒绝 |
| 实际 Manager/Web HTML 与入口脚本、样式 HTTP | 均为 200，与各自发布产物逐字节一致；没有浏览器、图片或界面验收 |
| 当前工作区 `pnpm docs:test`、`pnpm docs:check` 与相关 `git diff --check` | 文档测试 9 项及文档检查通过，相关差异空白检查通过 |

源码与离线原始输出在 `/tmp/opencode/web-login-connection-20261021/`，测试准备漏复制隐藏配置目录的失败输出与补齐后的通过输出分开，不将准备失败写成测试通过。发布目录保存报告与无秘密验证脚本，验证会话均已退出。登录修复的请求通过不覆盖首次会话创建；工作台的配置、首次创建及后续读取结论由[首次进入检查](#工作台首次进入检查)维护，不以连接通过代替界面验收。停止恢复与 QQ/中转的结果见[维护验收结论](#维护验收结论与适用范围)；已结束批次不继续授权收费或发送。

### 工作台首次进入检查

用户第 1 项反馈错误 `ffc11266`；后端实际 `chat.create` 因固定 `cheryNyxus` 预设不存在而失败，原配置仅有 `minimax预设`、QQ 角色及 `qq` 工具组。前次验证遗漏首次创建步骤，现已加入实际检查，不能靠重置密码或换端口解决。

用户以“确认”授权恢复标准工作台配置并全部使用现有 `minimax`，保留 QQ 及其他配置，允许创建空会话与读取、不调用模型或发送 QQ。标准模板摘要 `6e07e08323c3a1db4f6f96a6adc8859c7f8a2eb2c3525a25b08206f9dc85ffa6` 与当前发布固定源码相同。实际通过 `config.get → config.preview → config.save` 新增预设、6 名角色与 6 个工具组；新增 `role-design`、`role-acceptance` 技能，提示词保持已有文件，不覆盖原技能。预览无删除目标、配置影响仅新增资源；技能资源生效使既有 QQ 会话同步配置代际，但未改其预设、角色、模型或工具组。

- 配置报告：`/home/chery/docker/cherynyxus/releases/workbench-config-20261021/config-result.json`。原配置备份 `/home/chery/docker/cherynyxus/backups/workbench-config-20261021/config.yaml`，摘要 `51ead36e34f911f11496c385ec11fac69c1aecd5796275d4f53c2e84ff0539da`，包含秘密，不公开。保存与生效修订同为 `config-135364019cfd311f97cc4bffda404fa9c55531eb7f168afa204d40217d6e2d9b`，无需重启；原资源、其余配置与认证段的保存前后语义比较通过。
- 实际请求：2026-10-21 `business-flow.json` 的 9 组检查通过，包含同源登录、配置实际生效、标准工具均可用、两项技能可读、首次空会话创建、稳定预设目录、直接会话与根订阅、节点树/会话读取、任务目录、命令三类列表及订阅清理、退出撤销。空会话 `297a3ce9-9ff5-4e08-9b54-cbf086c1ec1f` 留给用户打开，不删除业务数据；没有发送输入、付费模型请求或主动 QQ 发送。
- 当前入口与浏览器兼容：Web 标题、无障碍名称、错误提示和日志使用正式名称，浏览器功能与文件草稿的 UUID 调用使用 `utils/uuid.ts`。同一身份的配置读取共享进行中的请求，成功后缓存，失败可显式重试，旧请求失败不清除新缓存；初始化的重复加载触发已移除。身份、目标及连接改变后仍拒绝旧响应，不改变认证。`uuidCompatibility.test.ts` 的 4 项、`serverConfigConcurrency.test.ts` 的 5 项及 `interactionSafety.test.ts` 的缺少接口初始化用例覆盖该问题。固定 Web 副本 `npm --prefix apps/web run type-check`、`npm run test:web`（155 文件/905 项）、`npm --prefix apps/web run build` 均退出 0，范围包括全部 Web 及现有身份隔离回归。
- 当前发布与维护：仅替换 Web 的文件草稿及绘图查询修复已发布，准确镜像、实例、备份、检查与限制归[文件草稿与绘图查询边界](file-capabilities.md#文件草稿与绘图查询边界)。固定源码在本节工作台 HTTP 基线基础上增加四文件，不发布混合工作区的其他改动。维护使用原六份 Compose 文件并追加 `file-draft-fix-20261021/release.yaml`，完整命令由当前发布目录 README 维护，不能遗漏基础环境或加入中间配置镜像。
- 实际部署与保留：确认空闲后普通停止、实际 PID 消失、停止后备份、保留停止意图及显式启动已通过；17 项凭据及配置摘要、挂载、网络、端口、运行用户、只读设置和 QQ 开关保持，NapCat 容器及进程不变。当前备份由上述修复验证链接的 `backup-result.json` 定位，包含秘密，不能公开或未经确认覆盖新数据。
- 业务与静态验证分开：工作台 HTTP 基线的 `business-flow-after.json` 9 组检查、原空会话 `reused:true`、目录 1→1 属于该版本，不冒充本轮 Web 登录或绘图请求通过。本轮两页面、全部 253 项 Web JS/CSS、Manager 入口资源与发布摘要一致，容器 healthy；QQ 0.1.42、设置 2.0.5 active/applied，NapCat 连接与可信身份通过、暂停 false，在线字段未知不当作证明。首次单次绘图 HTTP 400 原因未定位。

标准配置和入口固定副本在 `/tmp/opencode/workbench-config-20261021/`，工作台 HTTP 兼容修复源码、离线输出及一次性脚本在 `/tmp/opencode/workbench-http-20261021/`，该版本最终检查输出和无秘密发布脚本保存于对应发布目录；失败的类型检查输出单列 `pre-type-fix/`，不当作通过结果。其文档测试 9 项、文档检查及相关静态差异检查通过，14 项文件发布时与固定副本及工作区摘要一致。当前文件草稿四文件覆盖及 910 项测试归上述修复验证，不重复宣称旧摘要与已修复文件仍相同。没有浏览器、图片、模型请求、主动 QQ 发送、暂存或提交。

界面第 1 项的 UUID 接口缺失及重复配置读取已修复并获用户确认；文字草稿切换、大脑功能与命令监控入口可见及标题栏稳定快捷位空位已获确认，不要求重做。首次单次绘图 400 不因此通过。媒体交互、命令监控和停止恢复的当前范围见[维护验收结论](#维护验收结论与适用范围)。

### 大脑能力图标 Tab 发布检查

2026-10-22 用户确认大脑能力区应为“开关一层、Tab 标题一层、内容一层”，并反馈上一版开关打开后没有 Tab 标题。当前实现不再依赖未在 `PreloadRoot.vue` 注册的 `el-tabs`/`el-tab-pane`，标题层改用已注册 `ElTooltip` 加原生按钮：上方八个图标只是开关，打开后在下方形成 `role="tablist"`，每个按钮显示媒体类型与输入/输出方向两个图标；内容只挂载当前 `role="tabpanel"`，未实现面板留空；支持左右方向键、Home、End。文件输入对应已有 PDF 能力，文件输出仅为页面临时空白入口，不写保存字段。离线测试不注册 `el-tabs`/`el-tab-pane`，与生产注册集合一致。

| 检查对象 | 当前结论 |
| --- | --- |
| 固定副本 Web 类型检查、本次涉及文件 ESLint、Web 全量及构建 | 均退出 0；157 个测试文件、932 项全部通过，含独立标题层、双图标、单面板、草稿保留、空白面板、工具手动读取与迟到响应隔离。不是浏览器或视觉验收 |
| 镜像与运行 | `cherynyxus-runtime:brain-media-tabs-fix-20261022`，ID `sha256:185971409083926422102d41079b1314cc0b6d717783233284b1eb08da150941`；Backend 实例 `b5d2c2d5-88d4-421c-b5ba-660eee0aad96`，容器 healthy。只替换 Web，原 Backend、Manager、依赖和安装插件保持 |
| 普通停止与备份 | 停止前无活动任务、暂存输入或未确认 QQ 发送；普通停止后确认 PID 消失，完整备份并 tar 比较通过，再重建、确认 stopped 意图保持、显式启动。备份 `/home/chery/docker/cherynyxus/backups/brain-media-tabs-fix-20261022/persistent.tar`，1,180,815,360 字节 |
| 静态资源 | Web `http://10.2.3.6:8283/`、Manager `http://10.2.3.6:39980/` 的 HTML、全部 253 项 Web JS/CSS 与 Manager 2 项入口资源均 200，MIME 正确、逐字节匹配产物；构建产物包含标题层与 `aria-selected` 结构 |
| 保留与受保护读取 | 17 项凭据/配置摘要、挂载、网络、端口、运行参数及 NapCat 容器/进程保持；QQ 0.1.42、设置 2.0.5 均 active/applied，NapCat 连接和可信身份 true、暂停 false；QQ 在线字段未知，不据此认定业务收发通过 |

发布目录 `/home/chery/docker/cherynyxus/releases/brain-media-tabs-fix-20261022/` 保存源码覆盖、类型/测试/构建输出、镜像比较、备份、生命周期、HTTP 与前后受保护读取证据；README 维护完整十份 Compose 命令。`deploy.py` 为已执行的一次性脚本，不得重跑。后续启停须重新协调。本次发布没有浏览器、图片、模型请求、主动 QQ 发送或实际配置保存。最终媒体交互已获用户确认，见[维护验收结论](#维护验收结论与适用范围)；保存与回读由[设置保存验证](file-capabilities.md#设置保存与最近回读)维护。此表只代表对应发布，不覆盖后续版本。

### 设置默认显示与保存修复发布检查

2026-10-22 用户授权发布设置默认显示、恢复默认与保存修复。固定发布副本 `/tmp/opencode/settings-defaults-release-20261022/source/` 在 `brain-media-tabs-fix-20261022` 源码基础上叠加本任务改动（保留八类媒体入口、原生按钮/Tooltip 独立 Tab 标题层与手动工具刷新），完成全量验证后构建镜像并升级插件。

| 检查对象 | 当前结论 |
| --- | --- |
| 固定副本全量检查与构建 | 14 项检查均退出 0：四端类型检查与构建、`settings-tests`（1 文件 8 项）、`manager-tests`（39 文件 232 项）、`backend-all-tests`（273 文件 2741 项通过 / 1 文件 5 项跳过）、`protocol-tests`（18 文件 625 项通过 / 1 跳过）及 `web-tests`（157 文件 934 项通过）。不是浏览器或视觉验收 |
| 镜像与运行 | `cherynyxus-runtime:settings-defaults-20261022`，ID `sha256:1aae491685637939cacdcb357f9cc91eba72c962e607345880f45752503de6d0`；Backend 实例 `c27762ee-1114-4d00-989f-9713b727319d`，容器 healthy。替换 Backend、Web、设置插件与 `.chery.template`，Manager 服务端/UI、QQ 插件与运行依赖保持 |
| 普通停止、备份与插件升级 | 停止前无活动任务；普通停止后确认 PID 消失，完整备份 `/home/chery/docker/cherynyxus/backups/settings-defaults-20261022/persistent.tar`（1,180,825,600 字节，SHA-256 `4c2ba105677647cb02fd70ffac72882f9cf9b9ed630d05995817a90bd29e8344`）并 tar 比较通过；通过 `IngressStore` 升级安装 `cherynyxus-settings-module 2.0.6` 并保留授权；重建后确认 stopped 意图保持、再显式启动 |
| 静态资源与保留 | Web `http://10.2.3.6:8283/`（HTML 与 253 项 JS/CSS）与 Manager `http://10.2.3.6:39980/`（HTML 与 2 项入口资源）均 200 且逐字节匹配产物；17 项凭据/配置摘要、挂载、网络、端口及 NapCat 容器/进程保持；QQ `0.1.42`、设置 `2.0.6` 均 active/applied |
| 实际基准与预览 | `baseline-file-save-01.json` 确认 `baseRevision` 与 `configSha256` 同前次基准完全一致，磁盘 `quality = 85`；真实 `config.preview` 验证仅改 `quality = 84` 时唯一影响路径为 `/files/imageAdaptation/quality`、无破坏性目标 |

发布目录 `/home/chery/docker/cherynyxus/releases/settings-defaults-20261022/` 保存源码覆盖、14 项验证日志、镜像比较、备份、插件升级、生命周期、HTTP 及 `FILE-SAVE-01` 基准证据；README 维护完整十一份 Compose 命令。保存验收已完成，结果与最近回读归[设置保存验证](file-capabilities.md#设置保存与最近回读)。

### 媒体 Tab 固定顺序修复发布检查

2026-10-22 用户反馈媒体能力 Tab 仍按勾选先后从左往右追加。固定发布副本 `/tmp/opencode/brain-media-tabs-order-20261022/source` 在 `settings-defaults-20261022` 源码上只改变 `BrainMediaCapabilities.vue` 与对应测试；Tab 栏改为八个固定槽位，按图片输入、视频输入、音频输入、文件输入、图片输出、视频输出、音频输出、文件输出的按钮显示顺序渲染。开启只显示对应槽位并激活，关闭只隐藏该槽位，关闭再开启回到原位置，不再把已选 Tab 放入会插入或移动的数组。内容、继承、统一保存、文件输出临时入口与工具仅手动刷新均保持。

| 检查对象 | 当前结论 |
| --- | --- |
| 固定副本检查与构建 | Web 类型检查、157 文件/935 项 Web 全量测试与构建退出 0；其中 `brainMediaCapabilities` 8 项覆盖乱序勾选、关闭再开启、双图标、单面板、细项保留、空白面板与键盘切换。不是浏览器或视觉验收 |
| 镜像与运行 | `cherynyxus-runtime:brain-media-tabs-order-20261022`，ID `sha256:6531ee66c4b3eba70ab8fd953e7b1eba23374f28a4c84a8fbe81275cd03941b3`；Backend 实例 `0b05434c-1456-41d4-899b-7b8c014557fe`，容器 healthy。基于 `settings-defaults-20261022` 仅替换 Web，Backend、Manager、设置插件 `2.0.6`、QQ 插件 `0.1.42`、依赖与 NapCat 保持 |
| 发布方式与边界 | 沿用十一份 Compose 文件并追加本发布 `release.yaml`，仅重建 Backend 容器；重建后确认停止意图保持并通过 Manager 显式启动。活动运行 0、未知外部操作 0、暂存输入 0；配置修订保持 `config-41fb1e448248ab9e6ff5cd619025a54a7a098783a163c508ed26fe2fe9c793e3`，挂载、网络、端口、运行用户与 NapCat 容器/启动时间不变 |
| 静态资源 | Web HTML 与全部 253 项 JS/CSS、Manager HTML 与 2 项入口资源均 200、MIME 正确且逐字节匹配产物；实际提供的 `SettingsDialog-D0kd8pbr.js` 含八个固定槽位渲染与 `tabIndex` 辅助函数 |

发布目录 `/home/chery/docker/cherynyxus/releases/brain-media-tabs-order-20261022/` 保存源码、构建产物、镜像与部署边界、HTTP 和生命周期证据；README 维护完整十二份 Compose 命令。本次只替换 Web，未新增持久数据；该发布备份为 `/home/chery/docker/cherynyxus/backups/settings-defaults-20261022/persistent.tar`，回退不得未经确认覆盖新数据。没有浏览器、图片、模型请求、主动 QQ 发送或实际配置保存。最终固定顺序及选中交互已随[媒体能力开关验收](#媒体能力开关交互发布检查)确认，不要求重做。

### Manager 图片设置保存与采用状态修复发布检查

2026-10-22 用户反馈 Manager 保存报 `crypto.randomUUID is not a function`，并要求继续处理。图片设置页直接调用了仅安全上下文提供的方法，未使用已有的局域网 HTTP 兼容请求编号方法；测试此前只验证共用方法，未检查该页面入口。本次接入共用方法并补入口检查。核心保存在完成本轮可执行的采用尝试后返回最新状态；Web 补齐文件分类名称及新操作采用提示，真实等待和失败仍保留。未取得此前浏览器通知/响应的实测顺序或耗时，不将可能的旧响应覆盖解释为已测定事实。

| 检查对象 | 当前结论 |
| --- | --- |
| 固定副本检查 | 14 项检查退出 0；Backend 273 文件/2741 项通过，1 文件/5 项跳过；Manager 39 文件/232 项、设置 8 项、协议 625 项通过。保留最新媒体 Tab 源码后，Web 类型检查、157 文件/935 项测试及构建再次通过。不是浏览器验收 |
| 镜像与保留 | `cherynyxus-runtime:settings-defaults-fix-20261022`，ID `sha256:cb471c7b23de2c082ce02f2cc73b358bbbadc392c1e837f84696146d477479e0`，基于 `brain-media-tabs-order-20261022`；Backend 实例 `44062f1d-e0d8-4f6d-abe3-8a1c2a78292f`，容器 healthy。仅更新 Backend、Web 和设置插件；Manager、QQ 插件、模板与运行依赖保持，媒体 Tab 固定顺序组件及测试摘要与已发布版本一致 |
| 停止、备份与升级 | 无活动任务、暂存输入或未知外部操作；Manager 普通停止后确认 PID 退出。一致备份 `/home/chery/docker/cherynyxus/backups/settings-defaults-fix-20261022/persistent.tar`，1,181,634,560 字节，SHA-256 `1fea42b149f2593c32002d826be6ed32826b91b4f5a938faaf9022741fbe50db`，tar 比较通过。`IngressStore` 升级设置插件至 `2.0.7` 并保留授权；重建后 stopped 意图保持，再显式启动 |
| 实际入口与插件 | Web HTML 及全部 253 项 JS/CSS、Manager HTML 及 2 项入口资源均 HTTP 200 且匹配产物；受保护 `ingress.ui.read` 读取设置插件 3 项 HTML/JS/CSS，逐字节匹配 `2.0.7`。QQ `0.1.42`、设置 `2.0.7` 均 active/applied，QQ 连接及身份通过、未暂停 |
| 配置及运行保护 | 发布前后 16 项配置/凭据/部署文件摘要、挂载、网络、端口与运行用户不变；NapCat 容器、PID 和启动时间不变。对照原 `85` 基准，仍只有 `/files/imageAdaptation/quality` 变化为 `84`，保存与采用修订一致、applied、无需重启。原基准 6 项凭据/目录文件不变；第 7 项插件注册表仅设置包版本、摘要和 UI 版本按授权升级，其余插件和授权不变 |

证据目录 `/home/chery/docker/cherynyxus/releases/settings-defaults-fix-20261022/`，README 维护本发布完整十三份 Compose 文件与一次性脚本限制；后续叠加 Web 发布的当前运行及维护命令见[开关交互发布检查](#媒体能力开关交互发布检查)。`acceptance-before-restore.json` 保留升级后的受保护摘要。用户已确认 Manager 恢复保存成功、Web 回读 `85`，随后再次保存 `84` 且没有警告，`FILE-SAVE-01` 及保存警告修复验收通过。`step2-manager-restore-85.json` 核对恢复时全部配置字段与原基准一致；`step3-save-84-no-warning.json` 核对最后保存的 `84` 在磁盘、核心和 Manager 接口一致、applied、保存与采用修订一致且无需重启，相对原基准仅质量变化，7 项受保护文件摘要不变。保留用户最后选择的 `84`，不擅自恢复，不宣称原文逐字节恢复。AI 未代保存，未新增服务操作、模型请求、QQ 发送、浏览器或图片操作，未暂存或提交；其他验收项不因本项通过而扩大结论。

### 媒体能力开关交互发布检查

2026-10-22 用户确认理解输入与原生输出八个开关的提示显示在上方；增减非当前能力不切换正在查看的 Tab，仅首次出现 Tab、取消当前项时保留必要默认选择，并授权发布。长期交互规则由[设置中心](../../frontend/settings.md)维护。

| 检查对象 | 当前结论 |
| --- | --- |
| 源码与范围 | 固定副本 `/tmp/opencode/brain-media-controls-release-20261022/source` 基于 `settings-defaults-fix-20261022` 对应源码，2039 项文本源码与文档比较只有两个组件和两个测试不同，没有其他新增或删除；共享工作区未发布的推荐按钮源码及测试不在范围内，其他任务修改保持 |
| 集中检查 | 固定副本 Web 类型检查与构建、157 文件/937 项 Web 全量测试和涉及四文件的 ESLint 均退出 0。覆盖提示上方设置、开关不抢当前 Tab、首次选择、删除相邻选择、全取消隐藏、固定顺序、草稿保留、单面板及工具手动读取；不是浏览器或视觉验收 |
| 镜像与运行 | `cherynyxus-runtime:brain-media-controls-20261022`，ID `sha256:7e53763690e2aa951677464e8a36a75f09a1a9b9f001b5dac67235d756dc9b8f`；Backend 实例 `a04854e3-95a0-434d-bd15-16ec5b9caf6f`，Backend、Manager 运行且容器 healthy。基础镜像各层与运行配置不变，仅叠加 Web；Backend、Manager、模板、依赖及插件保持 |
| 停止、备份与启动 | 停止前活动任务、暂存输入、未知外部操作为 0，无未确认 QQ 发送；Manager 普通停止并确认 PID 消失，再停止容器并完整备份。备份 `/home/chery/docker/cherynyxus/backups/brain-media-controls-20261022/persistent.tar`，1,182,146,560 字节，SHA-256 `c4bc79e20c9c2cb9d2fe98c8c800070c5e9694bdcdcbc9e964965b3e37e744bd`，tar 比较通过；重建后确认 stopped 意图保持，再显式启动，未强制停止 |
| 实际资源 | Web HTML 与全部 253 项 JS/CSS、Manager HTML 与 2 项入口资源均 HTTP 200 且逐字节匹配产物。Web 设置入口 `SettingsDialog-C5ocRjqs.js`，SHA-256 `fdfaa8a5e3db8b19b18f7b5e398dabe130573dd00ee7e59120f951c8b7e1ff01` |
| 配置、插件与部署保护 | 27 项凭据/配置/部署文件摘要、挂载、网络、端口、运行用户、启动参数及环境摘要不变；保留用户恢复的质量 `85`，配置修订保持 `config-135364019cfd311f97cc4bffda404fa9c55531eb7f168afa204d40217d6e2d9b`。QQ `0.1.42`、设置 `2.0.7` 均 active/applied；QQ 未暂停、NapCat 连接和可信身份 true，在线字段仍未知，不据此认定收发通过；NapCat 容器/PID/启动时间不变 |

证据目录 `/home/chery/docker/cherynyxus/releases/brain-media-controls-20261022/`，README 维护完整十四份 Compose 文件及一次性脚本限制。服务操作锁已释放；本次发布没有浏览器、图片、模型请求、主动 QQ 发送、配置保存或插件升级。用户反馈“界面确认ok了”，媒体提示位置与 Tab 选中交互验收通过，不要求复验。其他未反馈分项不扩大为通过。业务保存和后续当前质量值由[设置保存验证](file-capabilities.md#设置保存与最近回读)维护；表中配置修订与 `85` 是发布前后保护快照，不覆盖后续用户保存。

**只读验收准备（2026-10-22 08:14–08:15 UTC）**：检查时运行镜像与 Backend 实例仍与本节发布一致，Backend、Manager 运行，活动任务、暂存输入及未知外部操作为 0。Web/Manager 页面 HTTP 200；未认证业务 `/api/config` 与 Manager `/api/status` 均 401。受保护插件读取确认 QQ `0.1.42`、设置 `2.0.7` 均 active/applied，QQ 未暂停、NapCat 连接和可信身份 true、在线字段未知；中转 `unknown/status_not_configured`，不认定为在线。原始证据为同发布目录 `monitor-manager-readonly-20261022T081447Z.json` 与 `monitor-manager-plugins-20261022T0815.json`。本轮未重新以浏览器业务身份读取命令列表，当前环境未提供既有测试密码，不重置账号、不使用机器凭据替代命令监控的会话授权。AI 未操作浏览器、图片、模型、QQ 发送、配置保存或服务启停。

**用户验收结论**：命令监控列表、执行后历史登记及 Manager 状态显示已获 A/B 通过反馈；历史日志、摘要与刷新补读（C）获“检查ok”确认；实时输出与单条停止（D）获“日志增长正常／停止成功”确认。只读核对 D 命令 `c53c8a7d-0238-495b-aadb-2ebeca12e91b` 为 `killed/SIGTERM`，69 个日志块与 Drain 摘要完整，Backend 仍运行。E 的无变更 `session.runtime.set` 排队阻塞修复已发布为 `cherynyxus-runtime:session-runtime-queue-fix-20261022`（镜像 `sha256:44209b94c9955b1a1ba60e834bb4bd11f22c9f1f6906c6fe275a65b1ab1ade97`）；证据、源码清单及备份摘要位于 `/home/chery/docker/cherynyxus/releases/session-runtime-queue-fix-20261022/`，一致备份保留在同名 backups 目录。用户确认 E“操作了，与描述内容一致”；会话 `32a37363-ed19-45ec-9b52-14fa533a859e` 的命令 `a2860c1d-12d3-4c72-af1f-3c15e118ff2a`、排队输入 `ccf14253-d9f8-4c45-a784-043c54d77d1e` 与取消关闭操作 `337e2c07-2c0c-4447-933c-ad0ff185357f`（版本 8）及恢复消费均符合预期。

**F 关闭与恢复（用户确认通过）**：用户接受点击中断关闭后只显示 0 秒的情况；完整倒计时及实际请求至退出的耗时未独立测定，不声称精确 10 秒已实测。用户手动继续后反馈“操作了，回复也对的”。2026-10-22 14:18 UTC 输入 `c27798b1-731a-43a4-88ac-10bf083911ff` 仍为 queued、根会话 resume_required=1；14:26 UTC 核对输入已 consumed（`consumed_at: 1792679167525`）、resume_required=0，F 命令 `68b310b9-6ac7-466d-9a8d-76eba069167c` 仍只有一条，原记录 result_unknown、日志 partial_truncated 保持，没有重跑。Backend 实例 `e0e08bea-5758-41df-ab53-1aade2cfc55f` 与 Manager 正常运行，活动命令及任务为 0。D/E/F 实际共执行六条命令（D 一条、E 修复前正常结束三条及修复后验收一条、F 一条），不以最初三条计划冒充实际次数。A–F 本批已结束，不要求再次操作，不继续授权模型请求、QQ 发送或服务启停。

### 剩余项目自动验证

2026-10-22 14:40–14:47 UTC，用户以“使用现有的环境开始自动测试”授权自动检查。对象为镜像 `sha256:44209b94c9955b1a1ba60e834bb4bd11f22c9f1f6906c6fe275a65b1ab1ade97` 对应的固定源码 `/tmp/opencode/session-runtime-queue-fix-release-20261022/source`；不使用混合工作区证明部署行为。测试不修改产品源码、生产配置或数据，不启停线上服务、不调用模型、不发送真实 QQ、不操作浏览器或图片。原始报告和日志见验收证据目录的 `manager-remaining-auto-20261022/`，一次性脚本与缓存不保留。

下表 Vitest 命令均在该固定源码根目录执行，以 `TMPDIR=/tmp/opencode/manager-remaining-auto-20261022 npx --no-install vitest run` 为前缀。最终 11 文件、102 用例通过，无跳过，退出码均为 0：

| 对象 | 配置与测试文件 | 结果与断言 |
| --- | --- | --- |
| Manager 状态与维护隔离 | `--config apps/manager/vitest.config.ts apps/manager/test/runtimeStatus.test.ts apps/manager/test/backendMaintenance.test.ts apps/manager/test/independence.test.ts` | 3 文件、35 项；状态到期、身份与配置一致性、受限维护及认证失败不影响 Manager |
| Relay 状态有效期 | `--config apps/relay/vitest.config.ts apps/relay/test/statusExpiry.test.ts` | 1 文件、2 项；发送心跳及旧连接确认不延长当前有效期 |
| QQ 停止与投递 | `--config plugins/vitest.config.ts plugins/qq/test/backendLifecycle.test.ts plugins/qq/test/reliableDelivery.test.ts` | 2 文件、25 项；清空旧队列、保留历史及未知结果、不重放 |
| Backend/适配器断线与进程重启 | `--config apps/backend/vite.config.ts apps/backend/test/service/runtimeStatus.test.ts apps/backend/test/service/qqProcessRestart.test.ts apps/backend/test/service/qqDisconnectOutcomes.test.ts --no-file-parallelism` | 3 文件、16 项；真实临时进程退出/重启和本机 WS 断线后旧任务取消、不重发未知结果。安装包使用生产 QQ `0.1.42` 的只读复制，原生发送及模型为测试实现 |
| NapCat 适配器队列 | `--config platform/napcat-plugin/vitest.config.ts platform/napcat-plugin/test/adapter.test.ts` | 1 文件、23 项；关闭阻止待发送内容、旧结果不影响新实例、未知投递不重放，不接触实际 NapCat |
| Relay 控制连接 | `--config apps/relay/vitest.config.ts apps/relay/test/client.test.ts` | 1 文件、1 项；真实本机 WS 挑战与客户端握手通过；隧道进程和探测使用测试实现，不证明生产加密隧道可用 |

首轮 9 项因测试副本缺少 Manager 页面产物和 QQ 安装包失败，其他 92 项通过；对应日志保留，不作为产品通过结果。补入当前运行容器的 Manager 页面产物及已安装 QQ `0.1.42` 的逐文件一致副本后，Manager 35 项、Backend 16 项重新运行全部通过，没有修改断言。`copied-artifacts.json` 记录复制范围，`prepared-test-results.json` 记录重跑；本轮创建的两份产物副本已清理，不改变原固定源码。其余组与额外握手结果分别由 `test-results.json`、`relay-handshake.json` 记录。

**配置保存与运行分开**：隔离配置检查以 `TSX_TSCONFIG_PATH=apps/manager/tsconfig.json npx --no-install tsx` 运行，退出 0，`config-roundtrip.json` 的 6 组检查通过。使用实际 Manager 实现、临时账号/配置及真实本机 HTTP；设备状态为合成记录，不连接生产 Relay。未认证读取被拒绝，保存与回读修订一致、秘密保留但不回显，旧应用修订不变、状态为 `unknown/configuration_not_applied`、`restartRequired=true`；不启动 Backend 或隧道，Manager 登录保持有效。`relay-live-e2e.json` 另记录 2026-10-22 15:40 UTC 的五组隔离流程：真实 Relay 服务、`RelayBackendClient` 与 Manager HTTP 的 V1 握手、心跳续期通过；保存 V2 后旧应用修订保持且不重启、不双开隧道；显式应用 V2 恢复 online；断开和到期变为非在线。宿主机与容器均未安装 `rathole`，隧道进程由测试实现承载，不声称生产二进制或外部公网 Relay 已配置。

**线上只读核对**：`live-before.json` / `live-after.json` 确认 Backend 实例 `e0e08bea-5758-41df-ab53-1aade2cfc55f`、PID `11265` 保持，容器 healthy；7 项配置/凭据摘要、QQ/设置插件版本及启用状态、NapCat 容器 ID 保持。QQ 没有活动任务，旧记录为 18 completed / 3 failed、38 条投递均 sent，前后计数相同。当前没有在途或未知投递，不能以空队列证明带任务关闭和未知发送的真实 QQ 效果。

文档检查、9 项文档测试及本次文档静态差异检查通过。文档检查另报告 `conversation-observability-and-input/qq-context-verification.md` 与该任务 `verify/manual-final.md` 两条入口引用待核对提示；这是其他活动任务的文档，不在本次修改范围，也不声称已解决。

**验证范围**：真实 Relay 服务、客户端及 Manager HTTP 的隔离流程已通过，但隧道进程为测试实现；生产 `rathole` 和外部 Relay 未配置、未验证。用户已明确接受该限制并批准结束，不修改生产配置凑测试。真实 QQ 带任务停止与后续新请求结果见下节，A–F 不重测。

### 真实 QQ 停止恢复与当前复核

对象为测试群 `980129567`；用户已授权本群真实 QQ、`minimax` 不设费用上限及必要 Backend 停止/显式启动。验收证据目录 `manager-remaining-auto-20261022/qq-live-stop-recovery.json` 确认 A `15c9c4cb-e6fc-49bd-876a-1f573aeef272` 正在执行 `qq_container_exec`、B `cefbd9ab-f2f5-4601-ae05-8d317936ca01` 排队时，普通停止进入 draining 并列出 QQ/工具阻止项，B 未消费；强制停止后两者 cancelled / BACKEND_STOPPED，显式启动和 NapCat 恢复未重跑或补发旧回复。未知外部工具如实登记，未为测试刻意制造未知 QQ 发送。

原 C `0b098139-bcc7-4ca2-8c62-7da8253aad16` 失败及用户可见失败通知由 `qq-live-post-restart-c.json` 保留，不能改写为成功。原因是旧版本将 QQ 会话的停机继续标记当成活动运行阻止新请求。后续 QQ 专题已完成提交 `e6097702`：仅经身份及来源验证、当前无活动运行且内存/持久输入队列均为空的可信新 QQ 请求，才能随新输入保存事务解除标记；失败回滚，不调用旧运行继续入口，普通 Web 仍须明确继续。相关 21 项入口测试及安装包流程结果来自该专题已有验证记录，不是本轮重新运行。

修复后的真实新请求证据为 `/home/chery/docker/cherynyxus/releases/qq-restart-input-20261023/m02-new-request.json`：请求 `e6a0e4ae-e0eb-470a-ab83-a90dd1c0da76` completed，继续标记由 1 变为 0，有效输入队列为空，最终正文回执 sent / `619999232`；该请求的工具和参数问题不因此全部通过。无工具普通短文证据为 `qq-argument-feedback-20261023/m02-short-reply.json` 及 `m02-short-reply-confirmed.json`：请求 `cd21c3bb-d58d-4ea8-8362-48c0f9edd442` completed、一个模型步骤、无工具调用、唯一回复 sent / `1693871247`，用户以“看到了”确认收件；末尾句号缺失仍不记为逐字一致。这些均为已存在的真实结果，本轮没有重发、调用模型或重跑工具。

2026-10-26 当前只读复核：容器 healthy，Backend 镜像 `cherynyxus-runtime:qq-original-task-20261024`；容器内 `/app/apps/backend/dist/index.js` 的 SHA-256 为 `9ed44b633ec64f4b545564d7222f2f9a98bc88fea784e45092755a86669a708f`，与该发布 `build-manifest.json` 和 `ready-check.json` 一致。QQ registry 版本 `0.1.54`、包摘要 `01a3b25f761539c87070116d2ff87539cc7c321038b30950515347235e5d9b2d`，与 `qq-source-modules-20261026/deployment.json` 一致；设置插件仍 `2.0.7`。本群当前有效来源绑定会话的继续标记为 0；全部 QQ 活动任务和持久待执行输入均为 0；原 A/B 保持 cancelled / BACKEND_STOPPED，C 保持 failed。旧停机测试会话标记仍为 1，不代表当前来源会话阻塞，不手动清理。当前发布已有后续问答和来源功能，不能用旧工作区覆盖；本次只同步文档，未启停、改配置/数据库、暂存或提交。

## 4. Agent 命令监控与 Backend 停止（第二阶段）部署与人工审核清单

共享协议（`agent.command.*`）、分块 gzip 日志与流式 Drain 摘要、七天保留及单条 10 MiB / 全部 200 MiB 配额淘汰、Manager / guardian / worker 停止协调、Web 显式继续及 QQ / NapCat 空队列恢复已实现并部署。当前已接受的验证范围见[维护验收结论](#维护验收结论与适用范围)，不再将已确认项目列为待验收。

- 普通关闭无限等待任务，只有强制请求开始不可延长的十秒期限；状态过期不能触发关闭或重启。
- Web 重启后仍须明确继续；QQ 旧任务取消、不重放，可信新消息恢复的范围见[真实 QQ 复核](#真实-qq-停止恢复与当前复核)。
- 未验证生产隧道、精确强制耗时和刻意制造的真实未知发送仍保留限制，不为补验重放旧任务或修改生产数据。

后续如需生产隧道或其他范围验证，应重新明确环境与操作授权；本次结束批准不扩展到其他任务。
