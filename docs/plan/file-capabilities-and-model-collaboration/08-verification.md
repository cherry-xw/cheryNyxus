# 综合验证与用户验收

**文档创建时间：** 2026-10-16T02:02:00+08:00

状态、依赖与当前结果见[总任务](README.md#当前恢复检查点)。可复用命令与判断条件归[文件能力验证](../../quality/verification/file-capabilities.md)；需求逐项核对见[验收矩阵](acceptance.md#7-需求完成核对)和[服务端工具 §5](server-tools-design.md#5-cherynyxus-当前实现缺口)。

**本轮设置与常规文件交互已获用户批准收尾并提交相关代码。** 第 1—7 批已通过项不重测，A3 保持按用户决定跳过；本页下列未完成项单独继续，不能据此把总任务标为完成。当前只做提交检查，不新增真实调用、发送、配置修改或服务操作。

## 本地提交副本检查

验证对象是 `/tmp/opencode/file-capabilities-closeout-20261022/source/` 中准备提交的相关源码；基准为 `f335b594ae2e0ec91c9e69cef414169938effcc6`，不含上下文、Manager、QQ 或 ADV 的其他未提交修改。设置已接入的共用组件随其必要依赖保留。依赖包仅供工具执行，不读取其源码；工作区内的共用包指向该副本，避免误用其他任务的实时源码。原始命令、退出码、日志及源码摘要位于同任务目录的 `results.json`、各命令同名 JSON 与 `checked-source.json`；基准副本单独位于 `baseline/`。

| 检查 | 结果与限制 |
| --- | --- |
| 相关后端回归 | `npm run test:backend -- <所选测试> --no-file-parallelism`，26 文件、414 项通过 |
| Web 全量回归 | `npm run test:web -- --maxWorkers=2`，153 文件通过，924 项通过、1 项失败；失败是 `lite/singleConnection.test.ts` 查找工作台源码中的 `conversationViewVisible` 断言，在基准副本同样复现。未将其他任务的工作台改动放入提交以隐藏该失败 |
| 设置插件回归 | `vitest run --config plugins/vitest.config.ts plugins/settings/test --no-file-parallelism`，2 文件、10 项通过 |
| 协议契约与辅助测试 | 7 文件通过，580 项通过、8 项失败；均为 `responseParameterMatrix.test.ts` 缺少命令响应及 QQ 恢复样例，基准副本同样复现。其他任务修正过的样例未夹带，不将此前混合工作区 588 项通过冒充本副本结果 |
| 类型检查 | Web 与设置插件退出 0；后端仍有 `service/chat/send.ts` 的 resume 参数签名错误，以及 `service/ingress/coreAdapter.ts` 的未使用变量 `submitting`。两项均在基准副本复现，没有本轮新增类型错误；不声明后端类型检查通过 |
| 构建 | `npm run build:prod`、`npm --prefix apps/web run build`、`npm run settings-ingress:build` 均退出 0；Web 保留包体积与重复导入提示。构建不抵消类型检查或测试失败 |
| 文档与差异 | 文档测试 9 项、当前共享工作区全部文档检查及提交差异空白检查通过。独立副本仍有原提交已有的 4 项：ADV 入口不存在的链接/计划错误、受管运行文档根缺失、小应用任务状态不一致；基准有 6 项，本轮无新增。没有夹带其他任务文档来消除这些问题。完整结果见同目录 `docs-*-final`、`docs-comparison.json` 与 `whitespace.log` |

后端两处类型错误、Web Lite 断言和命令/QQ 响应样例归相应模块后续修正；恢复本计划时先核对这些问题是否已由其他任务提交，再判断是否需要重跑。它们不取消用户已反馈的本轮设置及文件交互结果，也不使总任务剩余事项自动通过。

## 尚未完成的验收

| 范围 | 当前缺口与恢复条件 |
| --- | --- |
| 会话绘图 | [补充验收](acceptance.md#8-会话绘图补充验收)对应的其余先实施与 Imagen 单独阻塞决定有效；已部署，但生产没有文件服务，绘图任务、轮次、定稿均为 0；开发只有一条旧生成结果，不是当前多轮候选。准备依据与待决定方案见[数据准备核对](#数据准备核对)，未执行真实生成 |
| 服务端工具产品实现 | 连接隔离观察记录、Web/AI 共用能力来源、设置只读已知目录已有实现；真实任务成功/失败的验证管理与完整事件顺序保存/受保护续接尚未完成，状态固定为尚未验证；先按 ST01—ST13 核对，不能仅补真实测试 |
| GLM 图片 | 原生文本能力与服务端图片理解分开；最小工具条件、自有请求 S1、非流式、私有块与真实产品多轮需新限额 |
| GLM 搜索 | 搜索和读取分别成功不代替搜索→原文→有依据最终回答；需要新限额完成原会话循环 |
| GPT 搜索及图片 | 搜索仅有独立请求证据；严格工具定义修正后的图片完整历史需新限额，不重测网页读取/Python/Shell |
| MiniMax 图片 | 本批隔离两轮保留配置下，首次、普通保留轮及明确重读均实际携图并返回描述；未复现普通轮拒答。图片准确性、完整角色运行及生产一轮策略不在本批通过范围 |
| 其他真实服务 | 按厂商、协议、型号及操作分别限定预算；部分保存重试不能重新生成 |
| QQ | 群 `980129567` 直接通道送达与用户触发的 Backend 引用文字收发均已核对并获用户收件确认；该次实际使用引用回复工具，未满足“不调用工具”，普通 `qq.reply.part` 仍未验收。不能代替混合输入、纯文件完成、未知发送及断线恢复验收，不主动代发或重发 |
| 生产依赖 | 获准环境内核对 Sharp 生产安装；开发机可用不等于生产可用 |
| 人工界面 | [manual-final.md](verify/manual-final.md)按用户决定直接使用实际环境，设置及双端回显、无服务提示、视图切换、图片选择、保存、页面无效值拒绝及旧页面覆盖保护已通过；[第五批](verify/manual-final.md#第五批web-附件草稿与键盘布局) Web 附件草稿保留、键盘与布局、[第六批](verify/manual-final.md#第六批web-草稿文件查看与复制引用)草稿文件查看、复制引用、独立用途及单份移除，以及[第七批](verify/manual-final.md#第七批web-历史文件准备与草稿进阶检查) A1 草稿图片切换预览、A2 编辑器附件标签删除撤销恢复、步骤 B 历史文件卡片生成、预览、下载与重新引用均已通过，不重测；A3 按用户确认暂时不用直接归档。最近只读核对质量为 `85`。首次单次 400 原因未定位，跨账号文件隔离及 QQ 文件收发等未满足条件分项不推断通过 |

## 会话绘图离线检查

验证对象为 Linux / Node 24.19.0、基于 `77af4f3214b309e76f5947b89c85201a5809cabd` 的混合工作区，不是独立发布副本或生产版本。绘图证据目录为 `/tmp/opencode/file-capabilities-drawing-20261021/`；恢复核对与协议重验证据为 `/tmp/opencode/file-capabilities-drawing-recovery-20261021/`。各目录的 `workspace.json` 记录源码摘要，每项同名 JSON 保存完整命令、执行时间、退出码和日志位置。恢复时原绘图记录的 142 个源码摘要均未变化，未重复运行未受影响的绘图检查；协议按已补齐样例的当前源码重验。可复用命令见[文件能力验证](../../quality/verification/file-capabilities.md#自动检查入口)。保留两目录用于本任务剩余核对，不将其中结果用于证明其他工作区通过。

| 编号 | 检查对象与命令记录 | 当前结论 |
| --- | --- | --- |
| DRAW-BE | `backend-tests.json`：绘图、配置采用、文件保存/迁移/恢复、会话输入/分支及角色协作回归 | 通过：26 文件、284 项，退出 0 |
| DRAW-WEB | `web-tests.json`：绘图草稿、试用、文件引用与消息状态 | 通过：10 文件、51 项，退出 0；无浏览器操作 |
| DRAW-SETTINGS | `settings-tests.json`：设置插件文件策略与绘图字段保留 | 通过：2 文件、8 项，退出 0 |
| DRAW-TYPE | `backend-type.json`、`web-type.json`、`settings-type.json` | 通过：Backend、Web 与设置插件均退出 0 |
| DRAW-BUILD | `backend-build.json`、`web-build.json`、`settings-build.json` | 通过：Backend、Web 与设置插件均退出 0；Web 有大包和重复导入提示 |
| DRAW-PROTOCOL | 恢复证据目录 `protocol-contracts.json`：`vitest run --config apps/backend/vitest.protocol.config.ts test/protocol-completeness/contract test/protocol-completeness/helpers --no-file-parallelism` | 通过：8 文件、588 项，退出 0。响应样例修正归发布任务，本任务未修改代码；仅证明契约与辅助测试，不宣称协议全套通过 |
| DRAW-DOCS | 恢复证据目录 `docs-tests.json`、`docs-check.json` | 通过：文档测试 9 项，链接/结构/计划/元信息检查均退出 0，无阻断错误或待核对提示；本轮相关差异空白检查通过 |

Backend 断言覆盖真实输入处理器的排队与非排队 ACK 重发、同标识参数冲突、配置变化事务撤销和修正后重交；生成传输使用替身。配置采用检查保留新增/修改/删除默认张数、文件服务及原生模型按操作限制、旧快照不变和未知字段拒绝。空文件设置不能产生删除整个设置的重复父项。这些是源码行为检查，不包含运行配置迁移、付费调用、真实编辑、部署或人工验收。

此前付费批次均已用完或关闭，不挪用余额。发布结果归发布任务；当前 QQ 恢复由用户授权本会话接手。用户明确测试套餐不用担心费用，取消旧 5 元上限。本批 MiniMax 3 次请求已完成，不生成新图、不自动重试。QQ 直接发送已确认最多 2 条，实际只发 1 条；不自动消耗第二条。另获准的用户触发 QQ 文字验收已收到反馈并核对证据，结果与工具使用偏差见下节，不重试。不启动浏览器或由执行助手查看图片；视频无素材，明确不测试。缺少环境或具体条件时标明阻塞，不填写猜测地址或标为通过。

## 文件草稿与绘图查询修复

2026-10-21，用户批准分开草稿观察与发送检查、查询失败停止自动重复，并在查明 Web 位于共用只读镜像后选择“允许必要启停并发布”。产品范围仅为 `useAgentDialogOptions.ts` 的已完成附件预览及 `useDrawingDraft.ts` 的预览/失败查询处理，另补两份现有测试。固定副本由工作台 HTTP 发布源码加本轮四文件形成，不发布其他工作区修改。Linux / Node 24.19.0；证据目录 `/home/chery/docker/cherynyxus/releases/file-draft-fix-20261021/`，原始输出及证据文件为 0600，构建副本 `/tmp/opencode/file-draft-fix-20261021/source/` 保留供反馈核对。

| 对象与证据 | 当前结论 |
| --- | --- |
| `verification/web-results.json`、`web-types.log`、`web-tests.log`、`web-build.log` | 固定副本 `npm --prefix apps/web run type-check`、`npm run test:web`、`npm --prefix apps/web run build` 均退出 0；155 文件/910 项测试通过，构建仍有大包及重复导入提示 |
| `verification/regression-before.*` | 新检查在原部署源码上出现 4 项预期失败，准确复现上传 GIF 抛错、失败附件观察报错、失败后继续重复查询及旧错误覆盖新结果；修复副本相应检查全部通过。不是生产上传或浏览器验证 |
| `source-manifest.json`、`image-comparison.json`、`deployment-result.json` | 当前镜像 `cherynyxus-runtime:file-draft-fix-20261021`，ID `sha256:41f86e95545f0850f09e2561f82bbc5b35022e6a751144fddbc47d493f7d4fd3`；原镜像层及运行配置不变，仅替换 Web；Backend 实例 `1a2d5c0c-0bc7-493b-9bd2-7183b17bd3a8` healthy |
| `qq-idle-before.json`、`ordinary-stop-confirmed.json`、`backend-pid-exit.json`、`manager-preserved-stop.json` | 停止前 activeRuns、runningChats 均为 0，QQ 无非终态任务及未确认发送；普通停止后实际 PID 消失，未强杀；重建保留停止意图，显式启动 |
| `backup-result.json`、`preserved-files-after.json`、`napcat-before.json`、`napcat-after.json` | 一致备份与停止后的源逐项比较通过；17 项配置/凭据摘要、网络、挂载、端口、用户、只读设置及 QQ 开关保持；NapCat 容器 ID、PID、启动时间及镜像不变，未操作登录或插件 |
| `runtime-machine-before.json`、`runtime-machine-after.json` | QQ 0.1.42、设置 2.0.5 active/applied，NapCat 连接与身份通过、暂停 false、reasons 为空；在线字段仍未知，不当作在线证明。文件策略及无服务事实不变 |
| `http-after.json` | Web 与 Manager 两页面、全部 253 项 Web JS/CSS 及两项 Manager 入口资源均 HTTP 200，并与发布文件逐字节一致，无浏览器或图片操作 |

维护必须沿用原六份 Compose 文件并追加本目录 `release.yaml`，完整七份命令见该目录 README；备份包含秘密，不公开或未经确认恢复覆盖。服务操作由本次获准会话负责，其他会话不得并发启停。没有模型请求、主动 QQ 发送、配置保存、暂存或提交。

**限制与下一步：** 首次 HTTP 400 的实际目标及原始拒绝原因尚未取得证据。只读 HTTP 调查没有获得绘图接口结果，机器与 Web 登录凭据不同，未重试登录或重置账号；不据此判断 GIF、文件权限或无服务是原因。自动检查证明失败后不会持续重复，不能证明首次拒绝已解决。用户已反馈图片实测通过，不重测；下一执行人与剩余项目按[第二批保存同步](verify/manual-final.md#第二批设置保存与双端同步)继续。已通过回显与视图切换继续有效，其余真实服务和总任务验收仍未完成。

## 剩余验收准备

用户确认“前面图片实测ok了，继续测试剩余项”后，按当前图片选择场景记为通过，不扩大为未反馈的草稿切换、绘图查询、其他型号完整运行或新图生成通过。复杂度 3/5，需要比较实际保存值、运行采用状态及双端显示，沿用已确认当前模型；不修改产品源码、不重新发布或启停。

2026-10-21 15:48 UTC / Linux / Node 24.19.0，实际运行镜像仍为本节上方的 Web 局部修复版本且 healthy。只读准备脚本 `npm exec -- tsx /tmp/opencode/file-settings-acceptance-20261021/baseline.mts` 退出 0，脱敏基准保存在 `/home/chery/docker/cherynyxus/releases/file-settings-acceptance-20261021/baseline-1792597703085.json`，权限 0600：

| 检查 | 结果与边界 |
| --- | --- |
| 保存前配置与采用状态 | quality=85、maxBytes=5000000、图片 1 轮、其他文件 3 轮；config.get 与 apply.savedRevision 相同、status=applied、restart.required=false；activeRuns、runningChats 均为 0 |
| 基准与非测试配置保护 | 全部磁盘配置逐字段摘要、配置文件摘要及七项凭据/目录摘要已保存；准备过程配置摘要未变化，不保存原文秘密。用于后续只允许 `/files/imageAdaptation/quality` 变化的比较；不是业务数据回退备份 |
| 实际访问 | Web 与 Manager 根页面均 HTTP 200；沿用已有账号，不重置、不用机器凭据代替用户网页登录 |
| FILE-AUTH-01 未登录读取 | 不携 Cookie 或凭据，Manager `GET /api/modules/capabilities/files` 为 401，Web `POST /api/file-services/drawings` 为 401。仅此两入口的未登录拒绝通过，不代替跨账号隔离、已登录保存权限或首次 400 原因核对 |
| 副作用 | 无配置保存、模型请求、QQ 发送、服务启停、浏览器或图片读取 |

**FILE-SAVE-01 及保存警告修复验收通过。** 用户已确认 Web 回读 `85`，随后再次保存 `84` 且没有警告，后台核对通过；不重测，当前值统一见[旧页面冲突及回读](verify/manual-final.md#第四批旧页面保存冲突)，不代用户改值。其他权限及真实服务条件不扩大。

## 保存预览异常

用户只编辑质量 `85 → 84`，保存前确认列出图片适配、压缩、看门狗、MiniMax 与两项记忆设置。实际接口只预览、不保存，证据为 `/home/chery/docker/cherynyxus/releases/file-settings-acceptance-20261021/preview-diagnosis-1792598894174.json`，0600；命令 `npm exec -- tsx /tmp/opencode/file-settings-acceptance-20261021/diagnose-preview.mts` 退出 0。未读浏览器草稿或图片，没有配置保存、模型请求、QQ 发送或服务启停。

- **调查时保存状态：** 本次预览调查没有落盘。当前状态以[保存操作卡](verify/manual-final.md#第二批设置保存与双端同步)为准，已有用户保存 `84` 及实际采用证据，不能继续按尚未保存处理。
- **直接原因：** 已核对部署固定源码，`GlobalTab.vue` 的立即执行观察向草稿补 `global.file_compression={}`、`global.watchdog={}`、`memory.global={}`、`memory.workspace={}`；`brainFormHelpers.ts` 的 `mediaCapabilities` 读取函数以 `??=` 补 `capabilities.output={}`，`BrainCard.vue` 在显示时调用。当前生产原配置没有这些项，浏览页面便会形成未由用户编辑的草稿差异。设置保存提交全份草稿，后端将这些新增空对象列入变化。
- **真实预览对照：** 原 config.get 结果只改质量时，实际 config.preview 仅返回 `/files/imageAdaptation/quality`，无需影响确认；按部署页面上述初始化行为补齐空对象后，实际预览返回与反馈完全相同的六项，MiniMax 项具体路径为 `/llm/brain/minimax/capabilities/output`，影响会话数 5，因此触发额外确认。没有取得浏览器原始请求，结论依据源码与实际接口的相同结果，不声称读取了用户草稿。
- **提示含义：** “等待模块接入或安全边界”来自部署版 `diffResources` 对预览差异统一填写的原因，不是实际采用失败或模块未接入的证据。大脑空输出配置被归入会话安全切换范围，才带出会话列表；不据此断言这些会话均正在运行。
- **当前处理：** 下节方案及补充修复已发布，不以隐藏确认条目或过滤所有空对象代替修复。无额外变化、双端回读、恢复保存和警告修复均已获用户反馈并有后台证据，保存项通过；图片通过项不重测。

### 设置默认显示与必填规则

**代码、模板、正式说明、离线测试、生产发布与实际基准重建均已完成；四项未核实内容按用户确认单列保留，现已恢复 `FILE-SAVE-01` 验收。** 本节维护本次设置反馈的要求、离线验证与生产发布结果；详细规则、默认来源与单列边界统一见[修复方案](settings-defaults-design.md)。

1. 有默认值且允许省略：配置未填写时，保存仍省略该字段；界面必须显示实际默认值，不能跟随配置显示成空白。
2. 没有默认值：属于必填项，必须有值；缺失必须提示补齐，不允许靠添加空对象表示已经完成配置。
3. 允许留空：必须按明确的默认处理解释，不能独立解释为“空本身就是业务值”。继承等行为需要核对实际默认规则和结果，不能借此绕过必填判断，也不能自行发明默认值。
4. 显示值和用户明确填写的值必须分开：仅打开、查看或切换页面不得新增配置；用户编辑后保存其明确设置；已有显式值不因恰好等于默认值而自动删除。

**实施、离线验证与生产发布结果（2026-10-22）：**
- 已在 `@chery/protocol` 建立共享默认常量、显示准备（`prepareConfigDisplay`）、恢复默认（`restoreOptionalField`）、连接解析、大脑媒体能力合并、图片参数字段与组合校验；移除无消费者的 `global.bash_log_retention_hours`。
- 后端 `readRawConfig` 保持原始缺省语义，`config.get` 返回原始配置，`config_manage.get` 另带只读 `display`；区分启动预检 `validateRawConfig`（`complete = false`）与完整候选校验 `validateConfigCandidate`（`complete = true`），强制 `contextLimit`、条件必填及必填环境引用非空，并将 MCP 缺省统一改为默认不启用（0 token）。
- Web 设置、Manager 设置插件与 AI `config_manage` 已接入统一默认显示、无副作用读取、主动清空恢复默认、容量必填与推荐采用、Manager `unset` 顶层覆盖删除及 `utils.models` 已存密钥安全复用；同步更新 `apps/backend/.chery.template/config.yaml` 与正式文档。
- 固定发布副本 `/tmp/opencode/settings-defaults-release-20261022/source/` 集中验证全部通过：`backend-types`、`settings-types`、`manager-types`、`web-types`、`settings-build`、`qq-build`、`backend-build`、`manager-build`、`web-build`、`settings-tests`（1 文件 8 用例）、`manager-tests`（39 文件 232 用例）、`backend-all-tests`（273 文件通过 / 1 跳过，2741 用例通过）、`protocol-tests`（18 文件 625 用例通过）与 `web-tests`（157 文件 934 用例通过）均退出 0。
- 用户授权后已完成生产发布（`/home/chery/docker/cherynyxus/releases/settings-defaults-20261022/`）：实际配置无 `bash_log_retention_hours` 残留，`llm.brain.minimax` 必填字段齐全；经 Manager 普通停止、确认 PID 退出、一致备份（`/home/chery/docker/cherynyxus/backups/settings-defaults-20261022/persistent.tar`）、安装 `cherynyxus-settings-module 2.0.6`、部署 `cherynyxus-runtime:settings-defaults-20261022`（`sha256:1aae491685637939cacdcb357f9cc91eba72c962e607345880f45752503de6d0`）并显式启动，Backend 实例 `c27762ee-1114-4d00-989f-9713b727319d` healthy，QQ `0.1.42` 与设置 `2.0.6` 均 `active`/`applied`，Web 与 Manager 静态资源 200 且逐字节匹配。
- 实际环境基准已重建（`baseline-file-save-01.json`）：重建时 `baseRevision` 与 `configSha256` 同前次基准完全一致，磁盘 `quality = 85`；真实 `config.preview` 验证仅改 `quality = 84` 时只返回唯一变更路径 `/files/imageAdaptation/quality`、无破坏性目标。四项单列内容（[第 8.1 节](settings-defaults-design.md#81-已确认单列的外部默认问题)）仅验证“默认未核实”标识与原值保护，不计为真实默认核实通过。
- 当前保存验收：用户已 Web 保存 `84`、Manager 回读 `84`，`step1-web-save-84.json` 确认仅质量变化、applied、保存与采用修订一致。Manager 恢复时报 `crypto.randomUUID is not a function`；图片设置页已改用现有兼容方法，并增加入口检查。核心保存返回本轮可执行采用尝试后的最新状态，Web 补齐文件分类及 operation 提示；没有实测此前浏览器通知先后顺序，不将源码覆盖风险当作已采集到的事件事实。
- 补充修复已通过 14 项固定副本检查；保留最新 Tab 修复后，Web 类型、157 文件/935 项测试及构建通过。实际部署、插件 `2.0.7`、入口和配置保护证据保存在 `/home/chery/docker/cherynyxus/releases/settings-defaults-fix-20261022/`，本轮最终范围见[文件能力验证](../../quality/verification/file-capabilities.md#设置与常规文件交互的当前验收范围)。`step2-manager-restore-85.json` 核对恢复 `85` 时全部配置字段与原基准一致；用户确认 Web 回读也是 `85`，随后再次保存 `84` 且无警告。`step3-save-84-no-warning.json` 核对该次保存的磁盘、核心与 Manager 接口均为 `84`、applied、保存与采用修订一致、无需重启，相对原基准仅质量字段变化，升级后 7 项受保护摘要不变。后续运行已叠加另一任务的 Web 开关交互发布；最近质量值按下方只读核对为 `85`，不宣称配置原文逐字节恢复，不擅自改值，不启停或新增真实调用。

- Manager 页面无效输入：用户确认 `101` 保存时出现字段错误、重新读取仍为 `84`；`step4-manager-invalid-101.json` 核对配置原文字节和 7 项受保护文件摘要均未变，核心与 Manager 接口均为 `84`、applied、保存与采用修订一致。本项通过仅限页面拒绝，不证明后端直接无效请求或并发冲突通过；下一操作为[旧页面保存冲突](verify/manual-final.md#第四批旧页面保存冲突)。

- 旧页面覆盖保护通过：用户确认 Web 保存 `85` 后，旧 Manager 保存 `83` 被拒、草稿保留 `83`，重新读取为 `85`；`step5-stale-manager-conflict-85.json` 核对实际 `85` 已采用、其他字段和受保护摘要不变。用户进一步确认类似恢复操作已测试、无问题，沿用既有实际保存/恢复证据，不重复安排。`step6-settings-acceptance.json` 确认当前仍为 `85`、applied、保存与采用修订一致，全部字段与原基准相同，7 项受保护摘要不变；不声称本次已恢复 `84`，不代用户改值。

## 后端拒绝与文件验收准备

2026-10-22 08:56—08:58 UTC，实际环境核对；复杂度沿用 3/5，需要区分保存入口、业务身份与文件引用，沿用已确认模型。证据统一保存在仓库外 `/home/chery/docker/cherynyxus/releases/settings-defaults-fix-20261022/`，权限 0600。无产品源码修改、模型请求、QQ 发送、服务启停、浏览器操作或图片读取。

| 对象与证据 | 已核对结果与限制 |
| --- | --- |
| `backend-invalid-input-1792659368651.json` | 使用已有 Manager 机器维护身份，核心 `config.preview` 对质量 `101` 拒绝为 `validation_failed`/400，设置插件 `PUT files` 管理入口拒绝为 `invalid_params`/400；各一次，没有重发。配置原文字节及 7 项受保护摘要与 `step6` 一致，质量仍为 `85`、applied、修订一致。只覆盖这两个实际入口，不是直接无效 `config.save`、浏览器模块 HTTP 或业务账号权限验收 |
| `file-readiness-1792659457361.json`、`step7-batch6-draft-copy-check.json` | 准备时生产 19 个资产、19 个版本，类型均为图片；用户按[第六批操作卡](verify/manual-final.md#第六批web-草稿文件查看与复制引用)完成草稿 TXT 上传、复制引用、独立设置用途、查看文件下载及单份移除并反馈“按操作完成全部ok”后，只读核对全库增至 20 个资产、20 个版本，`manager-internal` 拥有 4 个上传资产（新增 `text/plain` 资产 `06a56448-98ae-4455-8f5a-4c9f8cba49c4`、版本 `81e3369a-50e6-4c11-baa8-3ddacf87c27e`、`890971` 字节，以及 3 个图片资产），执行期间 `asset_draft_references=2`，全程 0 次模型请求与会话提交。该账号的 `asset_chat_grants` 与 `asset_references` 仍为 0；全库 46 条历史引用均属其他所有者，不能跨所有者冒充使用 |
| 同一准备记录中的运行观察 | 已更新为合规原图适配复用版本标识修复镜像 `cherynyxus-runtime:image-variant-reuse-fix-20261022`，ID `sha256:3822acc191aae503cfc4f39a68d3fe03b5078857add17799b0008336cc11f1c7`，Backend 实例 `0cc2045d-5404-46ee-a631-f058d826a66e`，容器 healthy。无凭据 GET：Web 根入口 200，Manager 根入口 200，全部 253 项 Web 静态资源及 2 项 Manager 入口资源逐字节匹配。发布与服务维护资料见仓库外 `releases/image-variant-reuse-fix-20261022/README.md`，一致备份 `backups/image-variant-reuse-fix-20261022/persistent.tar`（`1187256320` 字节，SHA-256 `34393488f0240e574251eff22dd431a21f4bd8d63b89540584bb1d140e75570b`），不重跑发布脚本 |
| `file-followup-source-1792659538293.json`、`releases/image-variant-reuse-fix-20261022/`、`step8-batch7b-history-card-check.json` | 用户反馈第七批“A1ok A2ok A3先忽略不测（暂时不用，直接归档）”，并在步骤 B 首次发送合规 PNG（`480x480`、`147438` 字节）时遇 `[83605de6] 系统出了点小问题`。后台容器日志核对 `chat.input.submit` 报错 `文件版本与 variant 不一致`：后端 `adaptAssetImage` 对合规原图直接复用原字节并返回 `transform.variant='original'` 的原版本，而旧前端 `configureImageAdaptation` 无条件写入 `attachment.compressed` 且 `composeMessageParts` 将 `variant` 置为 `'adapted'`，触发 `AssetStore.reference` 拒绝。已在固定发布副本 `/tmp/opencode/image-variant-reuse-fix-20261022/source/` 修复 `useComposerMedia.ts` 与 `messageParts.ts` 并补充回归断言，`web-types`、`web-build` 与 `web-tests`（345 套件 / 940 用例）全部退出 0，仅替换 Web 叠加部署完成，服务操作锁已释放。用户随后刷新页面完成步骤 B 重测并反馈“7B ok”：只读核对（`step8-batch7b-history-card-check.json`）确认 `manager-internal` 在会话 `8cae8b4d-0b35-4dc8-a818-c629504c7bc0` 新增资产 `f5ee3244-519a-4b47-ad04-dadc20ce18dc`（`360.gif`，版本 `a6a0fc04-7719-41f1-9dbb-89d9077faa94`，`variant='original'`，`146396` 字节）、`asset_chat_grants=1`、`asset_references=1`（消息 `message-1792669065365-cq1lj53ugb`），`file_request_plans` 记录请求 `1ba98944-ccba-4fa8-bb46-f211a0946bb6` 为 `phase='completed'`、`action='omit'`（`仅附文件，不读取内容`、`binaryBytes=0`），重新引用产生草稿租期记录 |
| 首次绘图 HTTP 400 | 原始请求与响应未保留；当前容器日志没有对应请求或拒绝记录。源码中的空绘图列表查询不要求配置文件服务，因此不能把“没有服务”认定为原因，也不能猜测 GIF 或权限导致；首次拒绝仍未解决，停止重复查询不代替解决 |
| 权限准备 | 本进程没有业务网页登录凭据及第二个实际账号条件，不能用机器维护身份证明业务文件隔离；未重置账号、伪造身份或读取他人文件 |

文件操作与绘图任务、轮次、定稿仍为 0；缺少服务和多轮候选的项目保持阻塞，不新增生成来补数据。第一至第七批在当前环境下无需额外外部条件的可执行 Web 与 Manager 手工项目已全部完成（7A3 按用户确认跳过归档）；AI 不擅自代发或把缺条件未测项写成通过。

四项外部默认继续按[已确认单列边界](settings-defaults-design.md#81-已确认单列的外部默认问题)保留未完成；官方资料访问情况见 `file-followup-source-1792659538293.json`。已取得的 Seedream API 正文、MCP v1 客户端说明未补齐本次缺失的默认依据；Google 正文访问超时、OpenAI 编辑接口正文返回 403，搜索摘录不替代对应接口的默认说明。未改变显示、原值或运行行为，没有启动 MCP 或调用模型。

## 本批真实调用

2026-10-21 / Linux / Node 24.19.0，使用基于 `77af4f3214b309e76f5947b89c85201a5809cabd` 的混合工作区源码，不是固定发布副本完整运行。证据与脚本保存在仓库外 `/home/chery/docker/cherynyxus/releases/file-capabilities-live-20261021/`；本次运行目录为 `/tmp/opencode/file-capabilities-live-20261021/`。`authorization.json` 记录已用次数，`minimax-results.json` 保存脱敏请求结构、图片摘要、计数、回答与用量；无密钥、图片数据或思考正文。`workspace.json` 为运行后源码摘要，不冒充运行前冻结副本。脚本有防重跑检查，不可直接再次执行收费或发送命令。

| 编号 | 对象与判断 | 结果及限制 |
| --- | --- | --- |
| LIVE-MM-01 | `minimax-retention.mts`，先无网络准备，再 `--live`；真实 `planFileInputs`、资产读取、持久轮次、OpenAI 消息构造及 continuous fetch Provider | 3 次均 HTTP 200、`finish_reason=stop`、非空图片描述；响应型号 `MiniMax-M3.1-Flash`，实际请求 `minimax-m3.1-flash-preview`、`reasoning_effort=low`。不是完整角色提示、自动工具选择或全部生产中间处理验收 |
| LIVE-MM-02 | 隔离 `recentUserTurns=2`，普通第二轮复用历史位置原图，第三轮先检查到期，再登记明确重读 | 每次仅 1 个原生 PNG，SHA-256 与既有原图相同、1,459,345 字节；普通轮不刷新起点（仍为 1），重读后起点为 3、请求已消费。第三次由测试脚本调用真实 `requestImageRead` 并附对应工具记录，不声称模型自主调用成功 |
| LIVE-MM-03 | 生产文件与权限边界 | 生产配置请求前后摘要一致，仍为图片 1 轮；不生成、编辑或由助手查看图片。三次描述均未拒答，但准确性仍需用户判断，普通轮也可能利用先前回答，不能据此证明每句话均来自重新观察 |
| LIVE-QQ-01 | `qq-direct.cjs`：现有 OneBot WebSocket 先查询状态并核对生命周期账号，再向已确认群发 1 条纯文字 | 通过：`online=true/good=true`；发送 `status=ok/retcode=0/message_id=1317856517`，2026-10-21 用户反馈“群里看到消息了”。无 @、图片或文件，不自动重发；仅直接通道纯文字送达通过。`qq-send.json` 保存回执，`user-feedback.json` 保存确认结果，不保存群消息内容或接收事件 |
| LIVE-QQ-02 | `runtime-readonly.json`，只读 Docker 镜像、运行及启动环境检查 | 发布镜像 `sha256:f9e01a17375b32572a18c5f852e3a0581d7a202bb6fdad962df83386b814d3d7` 在运行、`QQ_INGRESS_PAUSED=1`。本会话未解除暂停或变更连接配置；直接发送不证明 Backend→NapCat 完整收发通过 |

本批请求时间为 06:17:31—06:18:10 UTC，三次总输入 8,411 tokens、总输出 654 tokens；这是服务返回用量，不是费用结算。QQ 成功回执时间为 06:19:28 UTC，用户已确认群内收到。本批仅维护验证脚本和文档，未修改产品源码；文档测试 9 项、全部文档检查与相关差异空白检查通过。仓库外证据不包含已清理的隔离运行目录或原图副本。当前恢复授权与结果见下节，不要求用户重复确认本条消息；绘图、其他文件、Imagen、服务端工具和人工界面仍按上表未完成项保留。

## QQ 恢复检查

2026-10-21，用户明确选择“授权本会话接手恢复”，同意核对无活动任务后解除部署暂停、重建同镜像并显式启动 Backend，保留现有 4 群、配置和凭据；随后针对实际插件不就绪，明确批准备份并替换已验证构建、仅重载该插件。范围不含替换 Backend 镜像、重启或重装 NapCat、改登录或业务配置。证据与本次脚本归仓库外 `/home/chery/docker/cherynyxus/releases/file-capabilities-qq-resume-20261021/`，原始状态和检查文件保持 0600。此目录操作已有防重跑标记，不能再次执行停止、重建、启动、reconnect 或插件重载来碰运气。

| 编号 | 检查与证据 | 当前结果 |
| --- | --- | --- |
| QQ-RESUME-01 | `preflight.json`、`stopped.json`、`stop-observations.json` | 恢复前 activeRuns、runningChats 均为 0，无非终态 QQ 任务或待投递项；Manager 普通停止后确认 Backend PID 消失，没有强杀 |
| QQ-RESUME-02 | `container-after.json`、`running.json` | 同镜像 `sha256:f9e01a17375b32572a18c5f852e3a0581d7a202bb6fdad962df83386b814d3d7` 重建，`QQ_INGRESS_PAUSED=0`，经 Manager 显式启动，实例 `febf34d3-ae2e-45ca-998c-4cdf5002dbcb` 运行；挂载、网络、端口、业务配置及凭据摘要未变。不等于 QQ 恢复成功 |
| QQ-RESUME-03 | `qq-final.json`、`napcat-after.json`，替换前状态 | 06:49 UTC，QQ 0.1.42、设置 2.0.5 active/applied；Backend 显示 paused=false、napcatConnected=false、trustedIdentity=false、qqOnline=null。实际插件 backend-unsupported/ready=false；此状态不再代表替换后的当前连接 |
| QQ-RESUME-04 | `process-auth-comparison-all.json`、`hello-probe.json` | 实际 Manager、guardian、worker 的连接凭据与插件一致。单独使用当前源码向原地址执行连接和 hello 成功，后端返回预期账号、0.1.42 与有效能力清单；随后关闭测试连接，没有调用 bind、scope、recover 或事件提交。该结果不代表实际 NapCat 插件使用了同一请求结构或通过后续步骤 |
| QQ-RESUME-05 | `napcat-build-comparison.json`、`napcat-reconnect.json` | 部署插件摘要 `348c237645a0cd71c635255f34a9e268f4a6e534a0ea2a8154b79f34b566cf8b` 与本次发布验证构建摘要 `0f083ba50f1e746cbea2d8e7d565ae68ae42b19a79bc6e9249749619ff29821c` 不同；只比较字节摘要，未逆向产物。原插件一次显式 reconnect 后仍失败，未改插件文件或保存配置。该差异是待排查条件，不足以断言具体错误原因 |
| QQ-RESUME-06 | `plugin-replacement-prepared.json`、`napcat-plugin-before.tar`、`plugin-replacement-result.json` | 获准后备份旧插件和状态，核对固定副本类型/测试/构建退出 0，换为摘要 `0f083ba5…` 的入口；仅通过受认证 SetStatus 停用/启用该插件一次。实际状态 ready=true；NapCat 容器 ID、PID、启动时间不变，最终启用状态、配置、凭据及其余插件文件摘要未变。没有重启 NapCat 或 Backend，没有新增插件、端口或保存业务配置 |
| QQ-RESUME-07 | `qq-after-plugin-replacement.json`、`online-probe.json`、`qq-user-test-baseline.json` | 07:18—07:19 UTC，实际 Backend napcatConnected=true、trustedIdentity=true、paused=false、reasons=[]；实际 NapCat ready=true。管理状态 qqOnline 字段在当前实现固定为 null，不冒充在线证据；另经原生 get_status/get_login_info 与生命周期账号核对 online/good=true、账号为 1454963281。测试群允许且有绑定，4 群名单不变，无新任务和待投递；已保存 15 个既有任务及 28 条已发送项的标识作为后续对照，不保存群内容 |
| LIVE-QQ-FULL-01 | `qq-full-text-result.json`、`qq-full-text-user-feedback.json`，本次 Backend 状态与 NapCat journal 关联核对 | 部分通过：07:25:59 UTC 接受群内 @ 的测试输入，新增任务 `7f6a82ab-740d-4f7d-8d07-4dd132c165f2`、Core 请求/运行 `d4927caf-d6ef-412f-9505-7837520cd9f4` completed；入站 accepted=true，确认表情与引用回复均 sent/reported，原生回执和后端 QQ 回复 ID 同为 `52340882`，用户反馈“已收到”，文字收发通过。回复文本为“完整收发测试通过”（未带句号）；实际记录 1 次工具调用并通过 `qq.reply.action/quote` 发送完整回复，未满足输入中的“不调用工具”，普通 `qq.reply.part` 路径不在本次通过范围 |

**当前用户反馈与收发证据核对完成；文字收发通过，工具使用条件未通过，不重发。** 一次测试输入、已完成后端任务、原生投递确认及用户收件反馈相互对应，不借先前直接发送的反馈替代本次结果。工具使用偏差的只读核对见下节，不更改约定或将该工具调用解释为“不调用工具”。此前恢复准备仅核对 Backend 和后端业务插件，遗漏了实际 NapCat 构建是否与当前 Backend 配套的检查；现已补齐字节核对及实际插件就绪检查。换构建后 ready 证明该操作恢复了连接，但通用 backend-unsupported 状态不暴露内部阶段，仍不推断具体失败代码。插件清理及重载能力依据 [NapCat 官方插件 API](https://napneko.github.io/develop/plugin/api/doc)与[热重载说明](https://napneko.github.io/develop/plugin/hot-reload)，管理接口沿用本环境已有受认证 `Plugin/List`、`Plugin/SetStatus` 使用方式，未安装调试插件或开启新端口。本次只读核对没有发新消息、调用模型或触发重试。

当前恢复记录已同步；只读偏差与数据准备核对后的文档测试 9 项通过，链接、结构、计划及元信息全部通过，7 个本轮相关仓库文档的 `git diff --check` 通过。直接执行 `node --test scripts/docs/tests/*.test.mjs` 与 `node scripts/docs/check.mjs`，命令、退出码及输出保存在本节证据目录 `investigation-docs-*` 文件；没有修改产品源码或重跑产品完整测试。文档检查不能替代真实业务结果，工具使用偏差与其他未验收项继续保留。

### 工具使用偏差核对

只读对象为上述固定任务、主库会话信息、月库 `chat_events` 和保存的用户输入；只输出测试相关字段，不保存群背景、思考或完整配置。详细字段归同一证据目录 `qq-tool-use-investigation.json`。

- 用户输入的正文和持久文字 parts 均保留“不要调用工具”；不是入站时丢失了这句话。`decisionRequired=false`，没有要求先调用参与判断工具。
- 事件序号 140 的 `sense_started` 明确记录 `qq_quote_reply`、调用 ID `call_01a15d5a5871709289e13213`、原输入消息 ID 和 `completeReply=true`。这是实际工具调用，不是普通文字被 NapCat 自动改为引用。
- `plugins/qq/src/index.ts`、`replyTools.ts` 与固定发布源码摘要相同。引用工具可在群聊中使用；执行后设置完整回复标志，`PostToolUse` 结束请求，收尾不再追加普通 `qq.reply.part`。本次持久状态及回执符合这条路径，`job.reply` 为空不是漏发。
- 已检查任务快照中的系统说明、当前全局及角色提示、相关 QQ 请求规则与工具定义，未找到必须引用回复的要求。当前提示文件不是当次完整请求快照；没有完整模型请求/响应证据，不能据此确定模型为什么选择该工具，也不能声称已证明整个请求不存在其他影响。
- 继续保留“不调用工具”失败和普通文字路径未验收，不新增关键词禁用工具、不修改提示、不自动复验。若要修正或进一步实测，先明确具体方案与调用范围。

### 数据准备核对

只读核对当前生产与开发数据库、配置；详细摘要归上述证据目录 `file-acceptance-readiness.json`。未调用文件服务、迁移旧数据、启动新服务或读取图片。

| 对象 | 已核对事实 | 对验收的影响 |
| --- | --- | --- |
| 生产 | `file_services` 未配置；绘图任务、轮次和定稿均为 0，文件操作为 0；有 12 个资产及 12 个版本 | 没有可直接交给用户的多轮候选。一般历史资产不能冒充绘图结果；未核实其测试归属与使用权限，不擅自使用 |
| 开发 | `.chery/db/soul.db` 无绘图表；仅 1 个资产版本及 1 条旧生成操作，对应既有原图；旧服务只配置生成，默认仍含旧数量字段 | 不是当前可用的隔离验收环境，不能直接复用为多轮或编辑验证，也不能在原数据库上自动执行初始化/迁移 |
| 当前生产文件策略 | 单图上限 5,000,000 字节、图片 1 用户轮、其他文件 3 用户轮 | 保留不变；未把隔离测试的 2 轮设置写回生产 |

**已确认的准备方式：** 用户明确要求“不用隔离不用模拟，直接在实际环境给出操作方案即可”。只使用当前 Web 和 Manager，不新建环境、不构造候选，不自动修改配置或发起真实调用。2026-10-21 07:59 UTC 两个页面入口 HTTP 200、无重定向；只核对响应头，没有启动浏览器或读取页面渲染。当前生产读回单图上限 5,000,000 字节、质量上限 85、图片 1 轮、其他文件 3 轮、绘图默认 1 张，未配置文件服务。首批直接检查真实设置回显、说明、文件草稿和无服务提示，具体操作归[人工操作卡](verify/manual-final.md)。保存回读与并发冲突需另按实际配置变更步骤安排；多轮选图、定稿及真实编辑因没有服务和记录保持阻塞。“给出操作方案”不等于撤销“不生成新图”，不要求用户自行付费补齐候选，不把空态检查当作完整绘图验收。
