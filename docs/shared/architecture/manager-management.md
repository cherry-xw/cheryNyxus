# Manager 管理模块

Manager 是与 Backend 同环境一体运行（同容器或同宿主机）的纯净插件容器管理平台，管理登录与 AI Web 业务登录完全独立、不共享会话；常规启动顺序为 **Manager 先启动 → 加载插件 → 由默认预装的 Backend 管理插件（`cherynyxus-backend-manager`）按 `manager.backendPlugin.autoStart`、插件启用状态和持久运行意图，以本地子进程拉起、监控与有限重试恢复 Backend**，核心聊天与业务仍在 Backend 独立承载。Backend 未启动或异常退出时 Manager 始终可用；整体进程关闭清理自己拥有的服务，关闭网页不停止服务。管理页提供启动、取消重试、停止与插件停用；停止的等待、取消、强制结束和独立保存边界见下节，源码验证状态不等于已部署。启动和目录唯一说明见[后端运行](../../guides/backend-runtime.md)。管理登录和机器接口只由 [Manager 认证](../protocol/manager-auth.md)定义；QQ 运行职责仍由 [QQ 平台架构](qqbot-platform.md)定义。本说明负责管理页面、资源保存、模块启用和失败边界，不授权 QQ 核心配置迁移。

设置 Backend 业务位于 [`设置包`](../../../plugins/settings/src/index.ts) 的 `SettingsService`，共享请求与响应由 [`settings.ts`](../../../packages/protocol/src/settings.ts) 定义；管理注册提供 capabilities 路径，通过公开 `coreCall` 保存并回读核心资源。QQ/设置包均提供完整预构建页面；Manager 本体不再导入业务面板或构造静态业务工厂。动态加载与宿主管理 HTTP 由 [Manager 插件](manager-plugins.md#动态资源边界) 定义。旧静态工厂和内联页面已删除，不提供运行兜底。

## 外部 Backend 状态展示

显式 external 模式不接管外部进程生命周期。预装卡片使用当前配置连接地址探测端口，端口可连接不代表业务健康；PID、进程资源、运行时长和日志未采集时不得显示为停止或零时长。自动启动设置仅对受管子进程有效，外部模式置灰并注明由外部服务管理；系统资源来自 Manager。验证入口为 `apps/manager/test/backendPlugin.test.ts`。

## 职责与入口

### 已批准的停止控制约定（实施中）

停止功能的实现与验证尚未完成，不能从下列约定推断现有接口已经可用。Manager 持有 Backend 期望状态和停止操作；guardian 负责 worker 退出及父层登记的命令组，worker 负责关闭准入、暂存下一条输入及分类清理。默认等待没有倒计时，当前已采用任务可继续；实际关闭或强制取消开始后不能撤销。强制关闭及外部停止信号共享 10 秒总预算，进程退出和外部操作结果未知分别记录。

控制消息关联运行实例、操作 ID 与版本；旧操作不能取消新一轮关闭。控制失联保留停止意图，不自动恢复或强杀。取消须获实际确认，不能只改 Manager 页面。Manager 重启按持久期望状态恢复，明确的停止意图阻止自动启动；既有插件启用和自动启动开关仍保留。配置待重启遇停止时暂停派发，取消关闭后恢复未生效的待重启意图。

guardian 将普通命令组与受管任务的登记转给 Manager，两个父层分别保存，释放消息不能把仍存活的普通命令组当作退出。等待期间 worker 崩溃后不重启，父层继续请求清理，不创建强制期限；仅用户中断关闭或外部退出信号授权强杀。Manager 的受管任务清理只调用本地控制器固定的取消和状态查询，不执行命令、不停止已发布应用，也不把取消确认当作结束。失去执行结果时保留未知项；Backend 进程退出与这些项分别展示。

前端只请求和显示状态，不拥有唯一倒计时或唯一操作状态。只有持有进程句柄的组件观察退出后才可报告进程已停止；信号发送成功、端口关闭均不足以代替。受管容器、SSH 和其他远端结果单列，已发布应用不随 Backend 停止。

控制接线入口为 Manager [`BackendControl`](../../../apps/manager/src/backendControl.ts) / [`BackendSupervisor`](../../../apps/manager/src/backendSupervisor.ts)、guardian [`GuardianLifecycle`](../../../apps/backend/src/service/guardianLifecycle.ts)、worker [`createWorkerLifecycle`](../../../apps/backend/src/service/workerLifecycle.ts) 和[生命周期消息定义](../../../packages/protocol/src/backendLifecycle.ts)。[`BackendIntentStore`](../../../apps/manager/src/backendIntent.ts) 保存独立停止意图，状态文件损坏时不退回自动启动默认值；正常缺失文件沿用现有自动启动偏好。页面入口为 [`BackendPluginPanel.vue`](../../../apps/manager/ui/BackendPluginPanel.vue)，从服务端读取关闭进度、工作标识、未知结果和插件停用保存结果，不以刷新或关闭页面撤销操作。相关测试为 [`backendIntent.test.ts`](../../../apps/manager/test/backendIntent.test.ts)、[`backendControl.test.ts`](../../../apps/manager/test/backendControl.test.ts) 和 [`backendStopCoordinator.test.ts`](../../../apps/backend/test/service/backendStopCoordinator.test.ts)。待生产部署与人工审核项见[后续审核清单](../../quality/verification/qq-safe-outcomes.md)，不据此推断已经部署。

| 修改意图 | 实现入口与符号 | 验证入口 |
| --- | --- | --- |
| HTTP 授权后接入页面与接口 | [server.ts](../../../apps/manager/src/server.ts) 的 createManager | [管理接入测试](../../../apps/manager/test/management.test.ts) |
| 动态描述、资源与有限分发 | [dynamic.ts](../../../apps/manager/src/modules/dynamic.ts) 的 DynamicModules | [动态插件测试](../../../apps/manager/test/dynamicPlugins.test.ts) |
| 核心资源保存与同名回读 | [设置服务](../../../plugins/settings/src/service.ts) 的 SettingsService | [真实核心测试](../../../apps/manager/test/modules/capabilities.test.ts) |
| 管理页面和草稿 | [useCapabilities.ts](../../../plugins/settings/ui/useCapabilities.ts)、[useQq.ts](../../../plugins/qq/ui/useQq.ts) | [能力页面测试](../../../apps/manager/test/capabilitiesUi.test.ts)、[动态插件测试](../../../apps/manager/test/dynamicPlugins.test.ts) |
| 独立启动、维护失败隔离与本地保存 | [index.ts](../../../apps/manager/src/index.ts) 的启动入口、[server.ts](../../../apps/manager/src/server.ts) 的 createManager | [独立性测试](../../../apps/manager/test/independence.test.ts)、pnpm manager:type-check、pnpm manager:build |
| 受限设备维护与状态有效性 | [backendMaintenance.ts](../../../apps/manager/src/backendMaintenance.ts) 的 `BackendMaintenance`、[runtimeStatus.ts](../../../apps/manager/src/runtimeStatus.ts) 的 `readBackendStatus/readRelayStatus` | [维护调用测试](../../../apps/manager/test/backendMaintenance.test.ts)、[状态记录测试](../../../apps/manager/test/runtimeStatus.test.ts)；状态规则见[认证契约](../protocol/manager-auth.md#运行状态记录约定) |

能力管理拥有大脑、感官组和预设的创建、查看、编辑；复用核心资源字段、目录、版本校验、秘密保存和应用状态，不维护第二份业务配置。QQ 管理只消费已有预设和只读摘要，不提供模型或资源编辑副本。

管理插件的定义、注册、启用、生命周期、页面可见性与开发接入方式由 [cheryNyxus 插件体系：Manager 管理模块](manager-plugins.md)统一维护。本说明只负责资源管理与业务接口，不将管理模块等同于 Backend 接入包。

## 页面与 HTTP 边界

本体入口为基础信息、连接和插件管理；连接含账号与密码、中转连接、授权、身份服务。已安装包的描述生成业务导航，`/modules/capabilities`、`/modules/qq` 经 Session 校验后返回包内完整 HTML，不再跳转固定 tab。QQ 编辑仍复用 `plugins/qq/ui/QqPanel.vue`、`useQq.ts`，分项读取与错误互不遮蔽，非秘密草稿保留。中转授权接口尚未接入时显示不可用并禁止申请。接口前缀为 `/api/modules/capabilities/`、`/api/modules/qq/`。GET `/api/modules` 返回已安装且提供管理页的描述，停用仍保留配置诊断。所有模块页面和接口先通过同一 Manager Session 授权；修改请求还通过认证契约规定的 Origin 校验。旧 token 和机器凭据不能进入模块接口；机器路径不提供资源代理。

能力接口返回 `{data:...}` 或 `{error:{code,message}}`：

- GET `catalog`：资源名称、真实工具目录和 baseRevision。
- GET `resources/{brains|sense-groups|presets}?name=...`：同名资源脱敏视图和应用状态。
- POST 同一路径创建、PUT 编辑：`{name,originalName?,value,expectedBaseRevision,requestId}`。
- DELETE 同一路径删除已有资源：`{name,expectedBaseRevision,requestId}`，版本校验后经核心保存并回读确认不存在；被角色或 QQ 绑定引用的资源拒绝删除，不自动解除业务绑定。删除预设时清理仅属于它且未被其他预设或角色引用的私有角色。
- GET `apply`：核心 ConfigApplyState。
- POST `models`：提交 URL/Key 或 savedBrain 获取模型 ID 列表；savedBrain 在服务端复用已保存密钥且校验目标 URL 不变；上游错误不回显。POST `model-recommendation`：读取已有核心模型规则和对应协议的思考档位，不调用真实模型。

请求大小和 JSON 校验沿现有 Manager 认证规则，不另开无界上传入口。Key 只写不回显；省略保留，空字符串明确清除。不能从 HTTP 成功推断所有配置已应用。

## 预设提示词编辑

选中已有预设后分别读取全局 `system.md` 与主角色关联的补充提示词，使用独立多行输入框与保存入口。全局保存须明确确认影响所有预设；主角色提示词须展示共用该角色或文件的预设。文件内容经 Backend 受保护的 `prompts.preset.get/save` 接口操作，不由 Manager 直接修改业务文件。保存采用配置版本冲突校验与原子文件替换，回读后报告结果；运行中请求保留冻结快照，保存不等于已运行会话立即更新。

删除使用核心 `config.preview` 获取影响预览并以 `wait` 策略提交 `config.save`，保留引用保护，不绕过核心删除检查。

## 设备与隧道控制边界

设备Manager不持全局Relay管理密钥；旧bindings读/撤销路由返回退役错误，只使用Backend的受限设备控制操作。Relay健康检查不携带秘密且不跟随重定向。rathole唯一进程owner是Backend设备客户端；Manager所有rathole启停路径明确拒绝，不能另spawn副本。保存配置不代表运行已应用。

设备客户端配置经 `RelayClientConfigStore` 保存到部署指定的固定文件，页面不能指定该文件位置；`GET/PUT /api/relay/client-config` 保存并返回脱敏读回结果，不重启 Backend。`POST /api/relay/device-operation` 只接收共享 schema 允许的操作；绑定申请经 `POST /api/relay/bindings/request` 调用固定的 Backend 机器绑定接口。维护调用先机器登录、校验能力发现，再发一次操作；不提供任意 URL 或方法代理，不向可编辑 Relay 地址发送机器凭据、用户会话或全局密钥。响应有大小和时间限制，认证请求禁止重定向；写操作结果未知时要求读回，不自动重发。

运行状态、PID 和生命周期字段取自同一次观察；资源采集期间发生退出或重启，不混合前后两次状态，也不把旧进程的 CPU 采样用于新实例。验证见 `apps/manager/test/backendSupervisor.test.ts`。

## 独立维护服务边界

Manager 启动只读取自身监听、账号、OIDC 与本地设置，不检查、创建、写入或迁移 Backend 认证。Backend 连接是可选的；内部机器凭据缺失、不一致、旧格式或无法读取均不得阻止 Manager 启动、登录、改密、OIDC 和本地配置保存读回。`CredentialStore.status` 只返回脱敏诊断，读取失败按安全拒绝处理。

`/api/status` 分别返回 Manager 运行状态、Backend 存活性和 `maintenance` 维护连接状态。维护状态起始为 `not_checked`；仅实际请求维护操作时校验受限机器凭据及所需接口，并记录最后结果，不把端口开放或本地文件保存当成管理往返成功。机器登录接口 404/405 返回 503 `backend_version_unsupported`；凭据不可用返回 502 `backend_auth_failed`；连接失败返回 503 `unavailable`。这些响应不改变 Manager Session，也不返回机器密码或 token。

本地 `/api/relay/config` 保存只写入并读回配置；远程政策应用是单独、显式的维护操作。本地配置保存不代表 Backend 已应用或隧道就绪。外管 Backend 永不由 Manager 擅自启动、停止或重启。管理调用不使用旧业务 token、业务密码槽、兼容代理或磁盘业务兜底。

## 共享配置事务

配置仍使用单一 YAML 文件。Backend 保存、回滚、运行中恢复和启动恢复使用同一文件锁，锁内重读后只改自己负责的字段，原子替换前比较原文；锁冲突时拒绝写入，不自动删除遗留锁。Backend 业务根字段限定为 `global`、`llm`、`sense_groups`、`mcp_servers`、`roles`、`presets`、`memory`；未知根字段及 `server`、`manager`、`relay` 保持盘上最新值。可解析但业务校验失败的候选先保全原文，再恢复最后认可的业务字段；恢复产生的文件事件不自动解除维护状态，仍需有效用户保存。无法解析的 YAML 只保全，不用整份旧备份覆盖。启动明文密码的哈希写回须在锁内核对磁盘密码与启动时一致，否则拒绝启动和写回。

启动模板初始化和资产同步使用同一事务实现（`scripts/lib/config-transaction.mjs`），锁冲突时拒绝同步；已有配置不补入内置资源，具体规则见[环境搭建](../../guides/setup.md#2-安装依赖-ai-可执行)。guardian 启动恢复只恢复 Backend 业务分区，非法 YAML 只保全，不再整文件复制备份。Manager 自有账号的并发改密规则见[Manager 认证](../protocol/manager-auth.md#账号与配置)。事务释放后继承异步上下文不能继续写入。

实现见 [configOwnership.ts](../../../apps/backend/src/utils/configOwnership.ts) 的 `mergeBackendConfig/persistStartupPasswordHash`、[configStartupRecovery.ts](../../../apps/backend/src/utils/configStartupRecovery.ts) 的 `recoverStartupConfig`。验证见 [Backend 跨进程锁测试](../../../apps/backend/test/service/configTransaction.test.ts)、[启动密码与字段归属测试](../../../apps/backend/test/service/configOwnership.test.ts)及[启动恢复测试](../../../apps/backend/test/service/configStartupRecovery.test.ts)。

## 保存流程与失败语义

1. Manager 授权 Session、Origin，再把有限资源请求交给注册模块。
2. 通过独立`server.auth.machine`和`/api/machine/login`取得短时机器凭据，建立无Origin/Cookie的管理WS；业务密码槽位不被机器轮换覆盖。浏览器业务请求不能指定后端目标或 RPC 方法。
3. 能力服务获取完整核心配置，比对 revision，只修改目标资源，保留其他已声明配置字段。
4. 核心 config.save v2 负责校验、秘密保存、持久保存和逐项应用。
5. 同名回读后返回脱敏对象与核心保存/应用状态；共享角色不被简化预设编辑覆盖。

设置包有限调用 config.preview、config.get、config.save、config.apply.status、brain.list、sense.list、sense.tools、utils.models、utils.modelRecommendation、prompts.preset.get/save、search.test/settings.get/settings.save；QQ管理使用[接入插件](ingress-plugins.md#qq-管理api)管理方法及 qq.memory.stats，不授权传输或任意代理方法。Manager 不加载核心 handler 在自己的进程中保存资源，也不从磁盘读写资源兜底。后端离线或认证失败时资源操作明确不可用；Manager 登录、状态与自身子进程管理仍可用。提交后断线不自动重试写入，须回读核实。版本2由已登记有限管理 route 和 ingress.management.call 分发，资源保存仍用上述核心公开管理能力，不改成包直接写配置。

页面区分已保存、待应用、失败、需重启，非秘密草稿可在标签页内跨页面保留，Key 不进入草稿存储。不会自动重启服务。正在运行的请求保持原核心快照，后续请求使用应用后的版本。
`/modules/capabilities` 返回设置包页面。能力页面复用 [CapabilitiesPanel.vue](../../../plugins/settings/ui/CapabilitiesPanel.vue) 与 [useCapabilities](../../../plugins/settings/ui/useCapabilities.ts) 管理三个平级区域：模型、工具组、预设。三个全宽区域上下排列，区域内部横向排版并在窄屏换行。协议与思考等级允许手动选择，推荐不可用不禁用编辑。普通工具组保留 auto/smart/manual 下拉选择；QQ 正在使用的工具组须为 auto。明确的校验失败允许继续编辑，版本冲突或未知写入后必须重新读取，目录刷新不改变旧草稿版本。预设只引用已保存资源并保留未编辑字段。离开能力页面清除 Key；不把 Key 写入浏览器存储。

模块接口的 401 只表示 Manager 未登录或会话失效。后端机器凭据缺失、不一致、无法读取、机器登录拒绝（包括 401、403、429）、WS 认证连接拒绝及 RPC 权限拒绝统一返回 502、`backend_auth_failed`；提示检查后端凭据或权限，不返回上游原文或凭据，不触发 Manager 登录跳转。后端离线仍返回 503、`unavailable`。

保存调用明确被后端拒绝认证或权限时，可返回 `backend_auth_failed`；保存响应不明、断线或超时仍按未知写入处理。已经收到保存成功响应后，回读认证失败不能解释为“未保存”：QQ 保持 `save_unconfirmed`，能力模块保持 `saved_readback_failed`，均要求回读核对，不自动重试保存。边界验证见[认证失败测试](../../../apps/manager/test/backendAuthBoundary.test.ts)、[RPC 测试](../../../apps/manager/test/modules/rpc.test.ts)及[QQ 页面保存测试](../../../apps/manager/test/workspace.test.ts)。

## 当前 QQ 边界

QQ 管理的固定 HTTP 路径、共享数字版本与状态类型见[接入插件](ingress-plugins.md#qq-管理api)。已安装 `cherynyxus-qq-module` 即保留管理页面；停用不撤配置诊断，卸载后页面与专用 API 返回404。运行服务离线返回503。页面只查看已有预设摘要，不复制能力编辑器。不读取旧平台业务文件，不启动旧QQ中转，不伪造保存成功。保存结果不确定时返回明确的未知写入错误，要求回读而非重试。

旧QQ独立管理和生产中转入口退出后，仅保留旧数据供显式离线迁移；通用relay网关不属于旧QQ中转。关闭 Manager 网页不影响 Backend QQ 运行；整体进程退出遵守配套服务生命周期。插件页的停用按钮是明确的 Backend 插件操作，不是隐藏页面的开关。设置包不依赖 QQ。QQ 实际业务验收结论见[QQ 模块说明](../../../plugins/qq/README.md#当前限制与验证边界)，不代表 Manager 页面或其他部署操作已验收。

## 文件策略消费者

设置包的 `GET/PUT files` 对应 Manager `/api/modules/capabilities/files`，通过核心配置事务保存并读回。服务和模块 UI 必须使用同一 `SettingsFilesPolicySchema`；严格接纳已生产的 `imageGeneration.defaultCount`（可选正安全整数，核心默认1），其他未知字段仍拒绝。图片输入能力与文件策略全量读回、编辑、保存时保留，不能为适配旧消费者删除字段或使用宽松透传。配置生产端新增有效字段时，部署检查必须覆盖已安装消费者的真实认证读取及无变更保存读回，不能只检查 HTML/JS200。

模块 UI 资源按安装包 `resourceVersion` 读取并对照构建摘要；认证 RPC 读取模块资源不等于 Manager 浏览器登录后操作或视觉验收。定向回归见 [`imageGenerationCompatibility.test.ts`](../../../plugins/settings/test/imageGenerationCompatibility.test.ts)。

## 验证与部署

运行 pnpm manager:test、pnpm manager:type-check、pnpm manager:build。接入测试使用临时文件、真实 Manager Session 与临时核心 HTTP/WS；合成失败仅证明调用方的失败处理。不得用自动测试代替真实 QQ、模型、OIDC、反代或页面验收。

构建生成 apps/manager/server-dist/index.js；使现有 Manager 进程使用新产物需要重新启动 Manager，本实现不重启用户服务。核心协议未变，不要求为接入另造或重启 QQ 运行层。已实现、自动验证、部署和用户验收必须分别报告。

显式连接由外部工具运行的 Backend 时，可设置 `CHERY_MANAGER_BACKEND_MODE=external`；它是受限外管模式，不是默认配套启动方式。该模式不自动启动 Backend，所有启停请求返回 409 `backend_externally_managed`，避免重复实例。当前配套 Docker 镜像内由 Manager 拥有 Backend；不能把 Manager 的子进程状态当成任意外部容器的状态。
