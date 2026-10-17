# cheryNyxus 统一插件宿主契约

**状态：** 通用宿主、QQ 与设置 Backend 包已实现接口版本 2 并通过定向离线测试；QQ 真实发送与媒体的验收结论见[QQ 模块说明](../../../plugins/qq/README.md#当前限制与验证边界)。Manager、其他集成和部署场景分别验证，不随 QQ 验收自动完成。

本文唯一负责统一插件包、宿主公开类型、可信请求身份、请求视图、生命周期和 Backend 管理 RPC/schema。入站只是能力之一，不新建平行插件系统。阶段字段和结果处理由 [Hooks](../../backend/agent/hooks.md) 拥有；Manager 动态资源、HTTP 路径和双端状态由 [Manager 插件](manager-plugins.md) 拥有；业务资源保存仍由 [Manager 管理](manager-management.md) 拥有。QQ 业务见 [QQ 架构](qqbot-platform.md)，NapCat 传输见 [QQ 协议](../protocol/qqbot-plugin.md)，认证见 [Manager 认证](../protocol/manager-auth.md)。技能包 `apps/backend/src/service/plugin/` 与 MCP 仍按各自职责运行，不把它们改成第二套宿主。

## 阅读和实施入口

通用宿主以接口版本 2 契约和 `api.ts` 为准；QQ 业务已迁入包，核心旧上下文和记忆实现已删除，不保留并行 API。QQ 当前数据与执行入口见 [QQ 架构](qqbot-platform.md#api2-业务入口与持久数据)。

`cheryNyxus-extension-host` 位于 `apps/backend/src/service/ingress/`，QQ 业务包源为 `plugins/qq/`，逻辑包名为 `cherynyxus-qq-module`，协议命名空间为 `qq`。NapCat 技术包 ID为 `napcat-plugin-cherynyxus`，用户可见名称为 `NapCat Plugin Chery Nyxus`，二者不能混淆。宿主不得固定内置 QQ 业务；独立构建包经显式安装和注册后加载。受信任包与运行服务同进程，拥有进程权限，不声称沙箱或任意不可信包安全。

下文第一节描述 API v1 实例在宿主内的运行方式；接口版本 2 的完整契约从“[接口版本 2 契约](#接口版本-2-契约)”开始。

受管根为现有 `CHERY_DIR/.chery/ingress/`：`registry.json` 保存 schemaVersion=1、revision、plugins（id/version/apiVersion/enabled/packageDigest）；`packages/<id>/<version>/` 保存安装包；`config/<id>.json` 保存独立业务配置；`data/<id>/` 保存受限运行状态；`backups/` 保存迁移和更新前备份。目录0700、敏感文件0600。路径由宿主计算，拒绝穿越、符号链接逃逸、重复ID、未知API版本和摘要不符。

包清单 `ingress-plugin.json` 字段为 id、version、apiVersion=1、entry（包内ESM相对路径），可选 `rpcNamespace` 用于协议命名空间；入口导出 `createPlugin(context)`，返回 start/stop 及配置校验、配置应用能力。context 由宿主提供该ID的配置/数据目录、只读核心能力解析、受限请求执行与事件订阅、连接通知及脱敏日志，不传 Manager 对象。API v1 清单与运行方式由现有 `ingress.test.ts` 覆盖；API v2 清单改用 YAML `config.yaml`，见接口版本 2 契约。

安装、升级、启用、禁用、卸载及状态查询提供本地维护命令；卸载默认保留配置与数据。启停和包版本变更保存后标记 requiresRestart，重启后生效；不做复杂热卸载。禁用在下次启动时不导入包、不读其业务配置、不注册其业务入口；当前进程仍活动时准确显示待重启。普通QQ策略保存可热应用，运行请求保持旧快照。独立只读命名空间 `extensions.qq` 由宿主持有，不塞入 ConfigRaw/config.yaml，也不让核心配置保存覆盖插件文件。

### Skill 声明与作用范围

Skill 来源、请求身份筛选和撤销由统一宿主管理。QQ 源码、页面、Skill 和脚本归 plugins/qq，完整包由组件构建；公共结构类型归 packages/plugin-api，插件不导入 Backend 私有实现。生命周期验证见正式资源与宿主测试；部署和用户验收分别判断。

包清单可选 `resources` 数组，每项为 `{id,kind,path,channel?}`。`kind` 仅 `skill` 或 `script`，`path` 为包内普通文件的相对路径，`skill` 必须指向 `SKILL.md`。同包 ID 不得重复；路径沿入口的安全限制校验。声明渠道时，宿主必须已授予该渠道身份；未声明渠道的资源只属于该包发起的请求。资源声明不自动扩大工具、身份或文件权限。

宿主仅在业务成功启动后登记 Skill 来源（包 ID、版本、声明、安装路径），停用、失败或卸载时撤销。默认全局 Skill 仍来自 `.chery.template` 对应运行目录；业务包 Skill 不复制到全局。请求准备只将当前可信身份可用的包 Skill 目录注入本请求，`skill` 感官加载时再次核对当前来源与身份。旧请求快照不能绕过撤销。`context.resources.resolve(id)` 返回本包声明资源的安装绝对路径，仅活动业务可调用；脚本执行与取消仍由所属插件负责。

## 配置与迁移

QQ文件封装为 `{schemaVersion:1,revision,config}`。实际字段以 [`QQConfigSchema`](../../../packages/protocol/src/qq.ts) 为准，含 selfId、groups、users、bindings、continuationMaxMessages（默认5）、waitIntervalSeconds（默认60）、continuationTtlMs、waitMessageMode、waitMessages、toolIconsEnabled、toolIcons、maxMessageChars、queueLimit、historyLimit。共享活动计时器按配置等待间隔运行；“固定30秒、固定最多5条”不是当前实现。QQ策略不放核心预设，bindings只引用核心预设；thinking/reasoning、模型Key、脑/工具资源全部仍由核心管理。默认空名单、不选目标、不猜预设。首次 hello 与原生身份绑定分开，未完成可信绑定不激活业务。

迁移读取显式指定旧QQ目录的 bridge.json/backend-settings.json/state.json 和专用配置引用，不读取仓库根.env，不遍历其他项目。先完整受限备份，再校验候选，原子发布，最后写迁移完成记录；失败保留旧文件和上一可用版本，重跑不重复迁移。已有核心资源继续使用同一核心配置，不复制新资源。旧preset选择映射各已授权目标；仅有brain+senseGroup直接选择时不能猜已有预设，保留原选择到迁移报告并拒绝对应目标，管理页可选择已有预设完成绑定。旧非30秒参数保留备份并报告为待确认差异，不静默改成新行为。旧未完成/未知发送任务必须保留并暂停核实，不能清空队列或重放未知QQ发送。

迁移不改变QQ账号、NapCat WebUI/OneBot token或管理账号。专用QQ通道token沿已有受限来源使用，不进入业务JSON/页面/日志。selfId须由现有可信NapCat身份只读发现并在后端显式绑定，不相信客户端首次自报。安装和握手不要求模型可用或名单非空；握手成功不等于可以聊天。

## 协议与安全

QQ端复用 [原生协议](../protocol/qqbot-plugin.md) 既有五个方法（包含 qq.identity.bind）和通知编码；QQ实施必须同时注册 Method、请求/响应schema、handler和事件，不能只给router塞handler。QQ专用凭据仅授权这些传输方法，不授权config/chat/管理方法；管理员普通认证不能冒充QQ连接。selfId、目标、requestId/eventId/seq、发送事件归属均在后端验证。开启后端密码/OIDC时仍有独立QQ认证分支，不以关闭核心认证换取握手成功。

每目标队列在上一请求终态实际发送确认后才推进。收到、工具图标、等待由后端发布，实际发送成功确认才重置按 waitIntervalSeconds 配置的计时；排入发送队列不算实际发送。unknown和确认丢失只阻断对应目标，不重跑模型或盲目重发。恢复重放与实时事件共用稳定序号；重复确认幂等，伪造时间不能推进业务。进程重启恢复持久状态，不能恢复的运行标暂停而非重新调用模型。记忆延用现有群/成员/私聊隔离，敏感原始记忆不进入公共输出。

## QQ 管理API

由QQ后端插件提供管理员限定RPC：`qq.config.get`、`qq.config.save`、`qq.status.get`、`qq.queue.get`、`qq.history.get`、`qq.entry.get`；NapCat token禁止调用。共享schema已集中于 [`packages/protocol/src/qq.ts`](../../../packages/protocol/src/qq.ts)，前后端不得自造第二份DTO。记忆统计已迁入 QQ 包的管理路由 `qq.memory.stats`，HTTP `/api/modules/qq/memory` 保持不变。

Manager路径 `/api/modules/qq/config` GET/PUT、`status` GET、`queue` GET、`history` GET；PUT body `{config,expectedBaseRevision,requestId}`，成功为 `{data:{config,baseRevision,saved:true,apply:{state,revision,reason?}}}`；GET config为同形读取视图但不带saved；apply.state取 applied/pending/failed/restart_required。失败沿 `{error:{code,message}}`，冲突409、非法400、禁用/离线503，未登录401与Origin403遵守既有认证。保存后回读同配置并区分未知写入结果，不自动重试写。

status至少区分插件安装/启用/活动版本、配置保存/应用版本、NapCat连接/可信身份、QQ在线（无可靠证据为null）、渠道许可与资源缺失原因、暂停目标数量；不回显token、正文、昵称、个人记忆。管理员限定的queue/history额外提供时间、目标号码、发送者、预设、输入与回复摘要、合并消息和附件数量、投递状态计数。GET `/api/modules/qq/entry?requestId=...` 经 `qq.entry.get` 按需读取对应原始消息、已有回复及投递记录；文本有明确长度限制与截断标记，附件只返回类型和名称。页面按当前结果分页，不扩大持久历史保留范围。不返回配置快照、秘密、内部提示词、私人记忆、附件URL或本地路径；原文只以文本展示。任务完成不等于发送成功，投递记录按实际pending/inflight/sent/unknown/failed分别展示，失败通知的成功不代表原回复成功。使用既有Manager服务端认证客户端并仅增加这些显式方法；浏览器不能提交目标地址或任意方法。Manager不开本地QQ存储，不导入业务执行器，禁用Manager模块或关闭Manager不停止QQ聊天。

## 部署验证暂停

提供独立运行开关 `QQ_INGRESS_PAUSED=1`，由QQ插件读取宿主明确提供的运行选项；不写入用户名单或业务配置。暂停时保留认证、hello及只读管理状态，但拒绝submit，不启动模型、计时发送或队列推进；recover不得回放任何会导致NapCat发送的事件，返回明确暂停错误。status须显示暂停原因。已在途的未知发送状态保留，不能当作成功。必须先在合成环境验证这个开关，再连接真实NapCat；解除暂停属于真实业务启用，需用户明确允许。

## 验证与扩展

### 基础宿主公共接口

公共类型唯一入口为 `packages/plugin-api/src/index.ts`，Backend `api.ts` 只提供宿主适配及重新导出，运行入口为 `IngressHost`，存储与本地维护为 `IngressStore`。包使用类型导入或独立声明构建，运行时只接收 `IngressContext`，不导入核心私有文件。API v1 的实例必须提供 `defaultConfig`、`validateConfig`、`applyConfig`、`start`、`stop`。宿主先校验配置、建立不可变快照，再调用 `start`；只有成功返回后才报告活动版本。启动失败会调用 `stop` 和释放宿主登记的订阅/方法。配置保存使用 revision 冲突保护；应用失败保留上一运行快照，保存版本与应用版本分别报告。实例自行判断配置变化是否需要重启。

`context.core` 提供按预设创建/读取该包拥有的会话、提交核心输入、停止运行、只读预设解析及有明确会话归属的事件订阅。会话所有权由宿主持有，不接受任意核心会话ID。执行沿核心真实的 chat.create/chat.input.submit/chat.abort 服务，不另造模型执行器；QQ身份、记忆等业务适配由QQ卡通过公共执行适配点完成。`context.connections` 只提供连接存活、定向发送与关闭通知；`context.rpc.register` 必须同时提供请求/响应schema及权限判断，禁止覆盖核心方法。宿主登记的释放函数在停止或启动失败时执行。`context.runtimeOptions` 是启动时明确传入的只读选项，宿主不解释QQ含义。

`context.core.internalText({preset,instruction,content,signal?})` 使用指定预设的模型生成无工具的内部文本，受插件活动状态、取消信号、输入大小和模型超时限制。`conversationHistory(key)` 只读取本包拥有的会话，保留最近压缩边界后的历史；`commitSummary(key,summary)` 仅向空闲的自有会话提交非空且有长度限制的压缩摘要，并清除对应运行时缓存。实现见 `createIngressCoreAdapter` 与 `IngressHost`，这些接口不直接向 QQ 发送消息。

包交付格式为已独立构建的目录（清单及ESM入口/依赖在目录内；不接受归档解压或自动下载），维护入口 `pnpm ingress:cli -- <command>` 与 `node apps/backend/dist/index.js ingress <command>`；命令为 install/upgrade/enable/disable/uninstall/status。安装与升级只检查清单、文件安全、摘要及入口语法，不执行包；实例契约在显式启用后的启动阶段验证。升级发布失败保持旧注册及版本目录。已经安装的同一ID不能通过install覆盖，需显式upgrade；已有版本目录不可覆盖。卸载保留配置、数据及版本目录以供恢复，不清除历史包文件。CLI状态没有当前进程内活动证据时以unknown报告，不推断已活动。

实现定位：[`plugin-api`](../../../packages/plugin-api/src/index.ts)定义公共类型；[`store.ts`](../../../apps/backend/src/service/ingress/store.ts)的 `IngressStore` 管理独立文件及包目录；[`host.ts`](../../../apps/backend/src/service/ingress/host.ts)的 `IngressHost.start/stop/status/saveConfig/extensions` 管理进程内生命周期和快照；[`coreAdapter.ts`](../../../apps/backend/src/service/ingress/coreAdapter.ts)的 `createIngressCoreAdapter/createIngressConnections` 接入核心；[`commands.ts`](../../../apps/backend/src/service/ingress/commands.ts)的 `runIngressCommand` 在导入核心配置前运行。`context.config.saved()`读取保存版本，`snapshot()`读取应用版本，不互相冒充。`startService().ready`等待宿主启动，worker关闭先 `stopIngress()`。动态 `RpcRouter.registerExtension` 禁止覆盖静态核心schema，宿主只允许该包ID方法前缀。QQ共享Method允许包登记处理器，但router强制采用共享QQ请求/响应schema，不能通过自带schema绕过；同名注册仍拒绝，停包时释放处理器。

执行会话key经包ID加SHA-256生成核心ID，已有会话须仍引用同一预设；切换绑定时业务包提供新的会话key。核心适配器只允许owner=qq提交QQ身份，以请求局部可信会话标记进入现有群/成员/私聊记忆；普通Web输入不能伪造该标记。QQ包不导入私有核心实现。连接定向发送返回仅代表已交给连接，不代表QQ发送成功。实例必须实现可靠stop/事务式apply；同进程受信任包不具备安全隔离，进程强杀与包主动越权不由该API保证。

维护示例：`CHERY_DIR=<独立工作目录> pnpm ingress:cli -- install <已构建包目录> [SHA256]`，随后 `enable <id>`，在获准重启后才激活。升级以 `upgrade <目录> [SHA256]`显式发布；卸载可恢复历史数据但同一历史版本目录不能覆盖，需选新版本。异常退出遗留 `.maintenance-lock` 时先确认无维护命令仍运行，再由维护人处理；宿主不猜测锁已失效。基础验证入口为 [`apps/backend/test/service/ingress.test.ts`](../../../apps/backend/test/service/ingress.test.ts)，运行 `CHERY_ENV_FILE=<空文件> pnpm ingress:test`；覆盖第二非QQ包、禁用坏配置、版本/路径/摘要拒绝、发布回滚、快照与清理、实际服务启动及离线核心执行。

基础：第二合成包安装/启禁/升级/版本拒绝/保留数据/坏配置拒绝；QQ：真实宿主与RPC/schema/后端执行适配、重启恢复、计时和隔离；Manager：真实Session→RPC→同名回读及认证负例。自动执行合成QQ和无付费执行器，不发送真实QQ、不调用真实模型、不操作浏览器。部署必须另给真实安装、握手、版本、持久化和重启证据，不能拿mock替代。实现后各责任卡补齐实际符号和正式测试入口。

### QQ包定位与维护

[`QQPlugin`](../../../plugins/qq/src/index.ts)负责五个传输RPC、五个管理RPC、策略快照和目标队列；[`state.ts`](../../../plugins/qq/src/state.ts)保存受限原子状态；旧目录不导入；插件只接受当前格式。正式验证命令与边界见[QQ协议自动验证](../protocol/qqbot-plugin.md#自动验证)。

构建 `pnpm qq-ingress:build` 生成完整目录 `plugins/qq/dist/`，必须一起安装清单、ESM入口、共享依赖文件和package.json，不能只复制index.mjs。先停旧消费者并经批准维护：`CHERY_DIR=<工作目录> pnpm ingress:cli -- install plugins/qq/dist`，`enable cherynyxus-qq-module`；已安装使用upgrade而非install。宿主下一次获准启动才活动，禁用仍遵守待重启约定。

离线迁移命令 `node plugins/qq/dist/migrate.mjs <旧QQ data目录> <CHERY_DIR/.chery/ingress目录> <可信selfId>`；禁止对运行中的宿主迁移。先备份三个专用文件，拒绝覆盖已有QQ配置或非空任务；完成记录最后发布，事务日志保留未完成恢复依据，正常结束清除。不会启用包、不修改registry、不写核心资源或秘密，备份本身可能含旧秘密，必须保持0700/0600。旧锁残留须由维护者确认无迁移进程后处理。旧待核实任务保留暂停；直接资源选择保持待绑定；非30秒差异保留报告并阻止新收件，不静默改变行为。

队列快照记录QQ配置revision及解析后的预设ID/脑/感官组。队列开始前发现引用发生改变时暂停为RESOURCE_SNAPSHOT_CHANGED而不是猜新配置；已经开始的核心请求仍沿核心既有运行快照。QQ状态接口不泄露消息内容、昵称或记忆；目标用摘要标识，QQ在线无真实证据保持null。

## 接口版本 2 契约

本节是唯一接口决定。公开宿主类型在 [`plugin-api`](../../../packages/plugin-api/src/index.ts)，跨进程宿主管理类型/schema 在 [`ingress.ts`](../../../packages/protocol/src/ingress.ts) 并由协议包导出。阶段专属类型仍放在 Hooks 模块，禁止在别处建立第二份定义。

通用宿主的当前实现：[`api.ts`](../../../apps/backend/src/service/ingress/api.ts) 提供 API2；[`ingress.ts`](../../../packages/protocol/src/ingress.ts) 提供共享管理 schema；[`handlers.ts`](../../../apps/backend/src/service/ingress/handlers.ts) 注册控制接口；[`identity.ts`](../../../apps/backend/src/service/ingress/identity.ts) 签发句柄并在停用、连接关闭时撤销；[`request.ts`](../../../apps/backend/src/agent/hooks/request.ts) 每输入准备一次请求视图。正式验证入口为 `pnpm ingress:test`、`apps/backend/test/agent/hooks/`、`apps/backend/test/agent/runtimeResolver.test.ts` 和 `apps/backend/test/agent/provider/`，只使用合成包及离线执行器。

当前宿主仅接受 API2 清单与当前注册表格式；不提供旧格式转换或导入命令。

### 包声明与能力授予

`IngressManifest` 使用严格 YAML 对象，文件名仅 `config.yaml`；必填 `id:string`、`version:string`、`apiVersion:2`、`entry:string`、`dependencies:IngressDependency[]`、`capabilities:IngressCapability[]`，可选 `rpcNamespace:string`、`ui:IngressUiDescriptor[]`。依赖元素为 `{id:string,version:string}`，version 是精确包版本，不引入模糊版本范围；空依赖必须写 `[]`。ID 保持当前小写规则，QQ 包 ID 为 `cherynyxus-qq-module`（技术 ID），职责名称为 `cheryNyxus-qq-module`；设置包技术 ID 固定 `cherynyxus-settings-module`，命名空间 `settings`。重复依赖、自己依赖、环、未安装/未启用/版本不符均阻断业务激活，稳定错误分别为 `DEPENDENCY_CYCLE`、`DEPENDENCY_UNAVAILABLE`、`DEPENDENCY_VERSION_MISMATCH`。依赖先启动，同一批可启动项按 ID 字典序；停用被依赖包前，反向顺序停用其使用者并显示原因，不让仍活动的使用者继续工作。

`IngressCapability` 固定联合：`'tools' | 'hooks' | 'rpc.business' | 'rpc.management' | 'ingress' | 'manager.ui' | 'channel.identity'`。重复项拒绝，未知项拒绝。声明只是申请，不构成授权；宿主受限注册表中保存 `grantedCapabilities:IngressCapability[]`，安装/升级由管理员确认授予，升级新增能力不得自动扩权。`channel.identity` 额外要求宿主保存 `{channel:string,credentialKind:string}` 的 `channelGrants`；不是任意包声明 channel='qq' 就获得 QQ 权限。其他同进程代码主动绕过进程权限不是沙箱承诺。

`IngressUiDescriptor` 字段固定为 `{id:string,title:string,entry:string,apiPrefix:string,resourceVersion:string}`。id 为模块 ID（QQ 为 `qq`，设置为 `capabilities`），entry 是包内预构建 HTML 相对路径，resourceVersion 非空且随资源更新改变；apiPrefix 必须恰好 `/api/modules/<id>/`。ESM entry 与 UI entry/资源均禁止绝对路径、URL、查询、片段、空段、点段、反斜杠、符号链接和逃逸；UI entry 必须是普通 `.html` 文件。不提供任意远程资源入口，不重建 Manager 才能安装包。

包声明不得含用户业务配置或秘密。`defaultConfig` 仍由 `createPlugin(context)` 返回的实例提供；安装包、`config/<id>.json`、`data/<id>/`、`backups/` 继续分离。既有根和 config 文件 schemaVersion=1 保持；registry schemaVersion 升为2，条目除清单及摘要、enabled 外含 grants；旧注册表经受限一次性迁移后才读入，不永久尝试旧 JSON 清单。apiVersion、宿主跨进程 contractVersion、Manager 加载能力 managerApiVersion 均为2，版本不符显式拒绝，不静默降级。QQ/NapCat 传输 protocolVersion 仍为1，不能把插件 API 版本混作传输版本。

### 注册与生命周期

沿用 `IngressHost`、`IngressContext`、`createPlugin`、`IngressPlugin` 与实例配置方法。新增实例可选 `prepareManagement():void|Promise<void>`，仅注册配置、状态、诊断和 UI，不提交模型工作。首次安装停用包也可加载其可信工厂、校验配置并准备管理能力；坏配置保留宿主状态和安全错误，不伪装业务活动。工厂和 prepareManagement 不得启动定时器/连接/业务；持续资源必须在 start 内创建并经 `defer` 登记。v1 “停用从不导入包/不读配置”测试须迁移为“停用不启动业务，管理仍可用”。

`context.tools.register({sense,metadata})`：sense 为现有 Sense 对象；metadata 必填 `{label,description,icon,doc}` 字符串，名称从 Sense 定义取得，schema 从 executor 取得。返回幂等释放函数。宿主生成 owner/source，不接收包自报 owner；source 固定 `builtin | custom | mcp | plugin`，plugin 来源附 `pluginId`、`pluginVersion`。任何同名工具（含核心、自定义、MCP）拒绝，不覆盖。Sense 全局注册表及版本刷新继续复用；本地工具重载不得擦掉插件项。

`context.hooks.register(definition)` 按 [Hooks 阶段契约](../../backend/agent/hooks.md#阶段契约) 注册并返回释放函数。`context.ingress.register({id})` 注册该包拥有的输入入口，返回释放函数；submit 必须使用已发布入口。工具、Hooks、业务 RPC 和输入入口一起准备，start 成功后统一发布；任一冲突或 start 失败撤销全批，不能出现可调用半个插件。

`context.rpc.register` 保持请求/响应 schema、authorize、handler，新增必填 `scope:'business'|'management'`。management 只允许管理员且不执行实时业务；business 只在 active 状态可用。namespace 默认包 ID 或其声明 rpcNamespace，不覆盖核心、其他包、认证接口；共享协议定义过的方法强制用共享 schema。管理注册与业务注册分两批事务：业务失败不抹掉已成功准备的诊断页面，管理失败不发布半份管理接口。启动时业务注册清单只能来自该包事务，释放函数归属该包。

新增 `context.channels.reportSendResult(input):Promise<void>`，input 固定 `{connectionId:string,entryId:string,identity:IngressIdentityHandle,requestId:string,eventId:string,status:'sent'|'unknown',terminal:boolean}`。仅授予 channel.identity 且当前身份有效的包可调用，channel取句柄，不接受自报渠道；包必须先校验并持久化真实回执，宿主核对该owner/entry/request归属并对eventId与状态幂等后触发只读ChannelSendResult。recordedAt由宿主产生；unknown后经真实核实转sent可以另观察一次，同状态重复不观察。宿主在包数据目录持久保存 requestId 对应的入口、原输入 eventId、渠道和可信主体，以及回执去重状态；重连或重启须重新签发当前连接的身份句柄，并与持久归属逐项一致，不能复用旧连接句柄。损坏关联文件拒绝加载，不当作空数据覆盖。不提供模型或浏览器直接触发此事件的RPC。停用后的迟到回执只能由包保存为待核实记录，不恢复业务或触发发送。

新增 `context.management.register({moduleId,routes})`，归属管理准备事务且要求 rpc.management 与 manager.ui 授予；moduleId须为清单ui已声明项。routes元素固定 `{method:'GET'|'POST'|'PUT'|'DELETE',path:string,rpcMethod:string,requestSchema:ZodType,responseSchema:ZodType}`，path是apiPrefix下相对路径模板（只允许静态段及 `:kind`）；输入统一为 `{pathParams:Record<string,string>,query:Record<string,string>,body?:unknown}`，经requestSchema校验后由固定RPC `ingress.management.call` 转交该注册handler，不由Manager执行插件服务端代码。注册项增加必填 `handler:(input,ctx)=>Promise<unknown>`，ctx沿管理员HandlerContext；rpcMethod为描述与权限核对名称，不授予任意代理。QQ适配把规范化body转既有qq.config.save、GET转只读配置/状态，设置适配调用宿主公开 `context.management.coreCall(method,params)`；coreCall只允许manager-management已列出的资源/提示词/搜索管理方法，不允许chat/传输/认证方法。

`ingress.management.call` 请求 `{contractVersion:2,moduleId:string,method:string,path:string,pathParams:Record<string,string>,query:Record<string,string>,body?:unknown}`，响应 `{contractVersion:2,status:number,body:{data:unknown}|{error:{code,message}}}`，仅control认证；宿主匹配已发布管理route的精确方法/模板且校验请求与响应，不按浏览器rpcMethod调用任意方法。`ingress.ui.list` 每个registration再附 `routes:Array<{method,path}>`，不暴露函数/schema对象。Manager只转已登记路由到这个固定方法；不要求新包改Manager方法允许列表。请求/返回资源沿既有业务保存schema与错误，不能用z.unknown绕过已存在共享schema。API声明、注册函数、调用映射的缺失属于启动失败，不能页面有导航但业务路由未接线。

宿主管理操作串行并带 revision 校验。停用先关闭 admission，再从新请求撤工具/hooks/业务 RPC/入口，再传播取消信号，等待最多30000ms清理活动任务及连接、订阅、定时器；迟到结果不得恢复注册或触发出站。无法完成清理则状态 failed、reason=`STOP_TIMEOUT`，拒绝卸载当前代码，不冒称停止成功；恢复须重启。插件自有停止逻辑负责持久化未决任务，禁止盲目重放。管理/config/UI 注册保留至卸载。卸载仅在业务停用成功后移除管理与页面，默认保留 config/data/backups/历史版本目录；删除数据是显式单独操作，第一版不提供自动清理数据接口。

运行中的代码升级可保存新包并报告 `restart_required`，旧活动版本与新保存版本分别展示，重启才加载新代码；不承诺任意热更新。启用未加载新包也允许要求重启；停用撤业务的要求不得以“待重启”替代。配置保存沿 existing revision 原子保存、事务 apply、失败保留旧应用快照；停用时保存可完成但 apply=pending，启用后才应用。`config.saved()` 与 `snapshot()` 不互相冒充。

### 宿主认可的请求身份

新增公开类型 `IngressIdentityHandle` 为宿主签发的不透明内存对象，不可 JSON 序列化为有效授权。其内部记录 owner、连接、入口、channel、verified subject 与有效代数，只能宿主构造。`context.identity.bind({connectionId,entryId,channel,eventId,subject})` 返回 `Promise<IngressIdentityHandle>`：验证当前包的 channelGrants、已认证连接的 credentialKind 和可信绑定信息，不以参数本身作为验证。subject 固定 `{selfId:string,userId:string,conversationType:'private'|'group',groupId?:string}`；private 禁止 groupId，group 必填；QQ 数字格式继续用现有 QQIdSchema。连接可信 selfId 必须由既有 NapCat Action 绑定完成，发送者/群信息只能来自这条连接已校验的事件。宿主绑定入口同时核对事件归属，插件不能在聊天正文中制造身份。

通用验证接口新增 `context.identity.registerChannel({channel,verifyConnection,verifyEvent})`，仅对宿主已授予channel注册一次，纳入业务准备事务。verifyConnection签名 `(connection:Readonly<{connectionId,credentialKind}>)=>Promise<{selfId:string}|null>`，从包已有可信原生绑定及当前连接检查；verifyEvent签名 `(input:Readonly<{connectionId,entryId,eventId,subject}>)=>Promise<boolean>`，仅接受该连接已经经schema/来源/白名单/绑定校验并保存的事件，返回false则不签发。宿主先检查grants/当前连接真实认证状态，再调用可信渠道适配校验，记录绑定代数；这两个函数由QQ包实现，核心不识别QQ字段值或包ID。包不能将聊天参数直接交verifyEvent当作来源。停用撤销验证器及所有句柄。身份只用于被核实eventId的新输入，重复eventId走既有幂等收件，不重新执行模型。QQ队列开始执行时凭保存事件和当前可信重连重新取得handle；持久化消息不保存可重放句柄。

`IngressCore.submit` 输入改为现有输入字段去掉 `chatId/platformIdentity/contextLimit`，增加 `{conversationKey:string,entryId:string,identity?:IngressIdentityHandle,signal?:AbortSignal}`。保留 commandId/messageId/content/attachments 等原语义；没有 identity 的普通输入是合法通用输入，有 identity 必须匹配当前 owner/entry/连接/代数。过期、跨包、跨入口、断开连接后使用一律 `IDENTITY_REJECTED`。Web 公共 wire 不接受此 handle；历史 platformIdentity 不构成可信来源。核心只验证通用 owner/capability/身份记录，不判断 QQ 包 ID、QQ 环境变量或 Chat 名称。安全校验是固定流程，不能卸载为可选 Hook。

新增 `IngressRequestIdentity` 只读投影 `{source:'web'|'plugin',ownerId?:string,entryId?:string,channel?:string,subject?:{selfId,userId,conversationType,groupId?}}`。subject 仅给需要处理该请求且有相同 channel 授权的包，其他 Hook 获得去掉 subject 的投影；命令 Hooks stdin 不含 subject，日志不含个人标识/正文。插件维护工具从执行 context 的 `requestView.identity` 取已校验信息，不接受工具参数里指定目标用户。子请求只能继承或收窄父请求身份，不能自建更大范围。

### 请求视图与工具可用性

新增 `IngressRequestView` 只读字段：`{requestId:string,inputId:string,chatId:string,preparedAt:number,configRevision:string,registryVersion:number,identity:IngressRequestIdentity,tools:IngressRequestTool[],unavailableTools:IngressUnavailableTool[],contexts:IngressRequestContext[]}`。requestId 为一次新输入执行 ID，不是一次模型 fetch ID；configRevision 为核心生效版本，registryVersion 为 Sense 发布版本；插件配置 revision 由对应 context 项提供，不把各模块版本合并成虚构总版本。`IngressRequestTool` 为 `{name,source,pluginId?,pluginVersion?,definition,supervisionLevel}`，definition 使用现有 SenseFunction，执行表在宿主内不序列化；`IngressUnavailableTool` 为 `{name,source?,pluginId?,reason:'plugin_disabled'|'plugin_uninstalled'|'plugin_failed'|'not_found'|'identity_required'}`。

`IngressRequestContext` 固定 `{ownerId:string,key:string,content:string,configRevision:number}`，来自 RequestPrepare 结果；ownerId 由宿主填，单包 key 不得重复。按 handler 顺序收集，仅本请求模型构建时使用，不落历史、不重复追加。内容总 UTF-8 上限256KiB，超限拒绝准备而非悄悄裁私人记忆。工具目录元信息、工具说明、模型 schema 和执行表必须源自同一次工具解析。

每条真正开始执行的新输入先取生效配置和可信身份，再解析工具和准备上下文，生成一次 view；本输入的模型/工具循环复用。排队时不提前冻结最新记忆，下一输入重新准备；存量会话下一次输入同样刷新。运行时身份失效、插件停用或固定权限变更必须执行前再检查，冻结视图不豁免撤权。再次检查失败返回结构化 `{status:'unavailable',error:{code:'TOOL_UNAVAILABLE',reason,toolName}}`，不调用旧 executor，不自动换通用工具。

保存工具组仍保留缺失名字；请求解析排除不可用项并报告 unavailableTools，未知名字 reason=not_found，不阻断整个请求。缺失工具组本身仍配置错误。QQ 专用工具仅 QQ identity 可用，不改通用命令/文件工具权限。QQ 记忆注入由 QQ 配置控制，不依赖维护工具启用；QQ 包只新增 `qq_memory_manage`，schema `{scope:'personal'|'group'|'member',save?:Array<{name:string,content:string}>,delete?:string[]}`，至少一个非空操作；name沿现有1–64字符规则，content非空最多300字符，save/delete 各最多100项，同名重复或同时保存删除拒绝。整批验证、按 scope 串行锁、一次原子提交；损坏文件拒绝，不能视为空文件。仅回报保存/删除数量，无 list/read/history 或私人内容返回；范围与文件共享差别由 QQ 架构维护。

### Backend 宿主管理 RPC 与共享 schema

以下新增方法/schema 已实现，方法前缀固定 `ingress.*`，不占技能 `plugins.*`。请求/响应严格对象，不接受任意 Backend URL、方法代理或包外资源路径。所有方法由既有 control 认证授权，渠道凭据无权限；插件不能覆盖。共享导出固定 `IngressRequestSchemas`、`IngressResponseSchemas`、`IngressMethodMap`、`IngressStatusSchema`、`IngressUiDescriptorSchema`；服务端 Method、请求与响应 schema 表同时引用，不能只加 handler。

| 方法 | 请求 | 响应 |
| --- | --- | --- |
| `ingress.list` | `{contractVersion:2}` | `{contractVersion:2,hostApiVersion:2,registryRevision:number,plugins:IngressStatus[]}` |
| `ingress.install` / `ingress.upgrade` | `{contractVersion:2,packagePath:string,expectedDigest:string,expectedRegistryRevision:number,requestId:string,grantedCapabilities:IngressCapability[],channelGrants:Array<{channel,credentialKind}>}` | `IngressMutationResult` |
| `ingress.enable` / `ingress.disable` / `ingress.uninstall` | `{contractVersion:2,id:string,expectedRegistryRevision:number,requestId:string}` | `IngressMutationResult` |
| `ingress.config.get` | `{contractVersion:2,id:string}` | `IngressConfigView` |
| `ingress.config.save` | `{contractVersion:2,id:string,config:unknown,expectedBaseRevision:number,requestId:string}` | `IngressConfigView & {saved:true}` |
| `ingress.ui.list` | `{contractVersion:2,managerApiVersion:2}` | `{contractVersion:2,registryRevision:number,modules:IngressUiRegistration[]}` |
| `ingress.ui.read` | `{contractVersion:2,pluginId:string,moduleId:string,resourceVersion:string,path:string}` | `{contractVersion:2,contentType:string,contentBase64:string,resourceVersion:string}` |
| `ingress.management.call` | `{contractVersion:2,moduleId:string,method:'GET'|'POST'|'PUT'|'DELETE',path:string,pathParams:Record<string,string>,query:Record<string,string>,body?:unknown}` | `{contractVersion:2,status:number,body:{data:unknown}|{error:{code:string,message:string}}}`，匹配登记schema后返回 |

`IngressStatus` 延用已有 installed/enabled/savedVersion/activeVersion/requiresRestart/savedRevision/appliedRevision/apply/reason，state 固定 `inactive|starting|active|stopping|failed|stopped|unknown`，新增 `apiVersion:2`、`grantedCapabilities`、`dependencies`。`reason` 仅稳定错误码，不返回 Error 原文。UI registration 为 `{pluginId,pluginVersion,apiVersion:2,descriptor:IngressUiDescriptor,enabled:boolean,businessState:IngressStatus['state']}`。`IngressMutationResult` 为 `{contractVersion:2,requestId,registryRevision,saved:true,status:IngressStatus}`；`IngressConfigView` 为 `{contractVersion:2,id,config,baseRevision:number,apply:{state:IngressApplyState,revision:number,reason?:string}}`。业务秘密只写不回显，包 validateConfig 与脱敏读取负责各自字段；管理 API 不开放任意 config 文件编辑。

具体沿用字段类型：id/pluginId/pluginVersion为string，installed/enabled/requiresRestart为boolean，savedVersion/activeVersion为string|null，savedRevision/appliedRevision为number|null，apply沿IngressApplyState。UI registration额外含前文固定的routes。所有未注类型的名称、reason/code/channel/credentialKind均为string，时间戳为非负安全整数毫秒。管理HTTP status只允许200至599整数；route handler返回业务data，宿主校验responseSchema后包装200成功；ClassifiedError经现有安全错误映射生成错误信封和status，不暴露Error原文。coreCall签名 `(method:string,params:unknown)=>Promise<unknown>`，运行时强制有限方法集合及现有共享请求/响应schema；ctx为既有HandlerContext的安全管理员视图，不向包暴露认证秘密。

registryRevision/baseRevision 非负安全整数，requestId 非空最多256字符。install/upgrade 仅服务端预先配置的受限安装来源目录下已构建包；UI 第一版不上传归档、不下载远程包，不允许浏览器任意路径。packagePath 为来源根内相对路径，expectedDigest 为64位小写 SHA-256；完整校验包后才安装。请求 ID 在同包同操作下相同参数幂等，参数不一致返回 `REQUEST_ID_CONFLICT`；未知写入不自动重试，回读 list/config 核实。

UI read 只读安装清单声明模块对应的 UI entry 所在资源目录内普通文件，path 相对该目录；单响应原始资源最多1MiB，总包仍64MiB/4096文件/深度32。明确 MIME 只允许 HTML/JS/CSS/JSON、常用图片/font/wasm 静态资源，不返回 config/data/凭据。Manager 按 [动态资源边界](manager-plugins.md#动态资源边界) 校验版本和路径；不在公开登录资产路径挂插件资源。

固定安全错误：`API_VERSION_MISMATCH`、`DEPENDENCY_*`、`REGISTRATION_CONFLICT`、`CAPABILITY_DENIED`、`IDENTITY_REJECTED`、`TOOL_UNAVAILABLE`、`STOP_TIMEOUT`、`REVISION_CONFLICT`、`REQUEST_ID_CONFLICT`、`INVALID_PARAMS`、`UNAVAILABLE`。跨进程错误沿既有 RPC 错误信封；不另造成功数据包裹失败。

## 现状行为与验证清单

插件的 `core.importFile` / `core.readFileChunk` 只作用于本插件已打开的会话，必须携带有效入口与渠道身份句柄。导入仅接受字节或受限 HTTPS 地址，不读取调用方给出的本地路径；地址下载拒绝本机、私网和不安全跳转，不携带服务凭据。保存后建立当前会话的固定版本引用。读取必须同时满足所有者与当前会话授权，单段最多 256 KiB；不会生成公开下载链接。插件停用、身份失效或异步期间会话权限改变时拒绝返回结果。

此清单记录当前核对的真实符号与验证入口。

| 行为 | 当前真实入口与调用 | 验证入口 |
| --- | --- | --- |
| 包安装与文件保护 | [`IngressStore.install/verify/readRegistry`](../../../apps/backend/src/service/ingress/store.ts)，CLI 到 Store | [`ingress.test.ts`](../../../apps/backend/test/service/ingress.test.ts)，包版本/穿越/摘要/发布回滚 |
| 配置应用与清理 | [`IngressHost.start/saveConfig/stop`](../../../apps/backend/src/service/ingress/host.ts)；service ready/worker stopIngress | 同上，快照、失败应用、partial startup、真实服务 readiness |
| 核心提交与身份 | [`createIngressCoreAdapter`](../../../apps/backend/src/service/ingress/coreAdapter.ts) → [`handleChatInputSubmit`](../../../apps/backend/src/service/chat/input.ts)；capability+identity handle | 同上，real public core adapter；[`qqRequest.test.ts`](../../../apps/backend/test/agent/middleware/qqRequest.test.ts) |
| 工具注册和刷新 | [`registerSenses/prepareLocalSenseReplacement/getSenseRegistryVersion`](../../../apps/backend/src/core/sense/senseRegistry.ts) → [`RuntimeResolver.resolve`](../../../apps/backend/src/agent/runtimeResolver.ts) → [`ensureChat`](../../../apps/backend/src/service/chat/runtime.ts) | [`runtimeResolver.test.ts`](../../../apps/backend/test/agent/runtimeResolver.test.ts) |
| Hooks返回与调用 | [`dispatch`](../../../apps/backend/src/agent/hooks/dispatch.ts) → [`prepareModelHistory/dispatchPostLLMResponse/dispatchStop`](../../../apps/backend/src/agent/middleware/chat.ts)、[`doExecuteSense`](../../../apps/backend/src/agent/middleware/tool.ts)、协议适配器经 [`protocolHook.ts`](../../../apps/backend/src/agent/provider/protocolHook.ts) | [`dispatch.test.ts`](../../../apps/backend/test/agent/hooks/dispatch.test.ts)、[`anthropic.test.ts`](../../../apps/backend/test/agent/provider/anthropic.test.ts) |
| QQ记忆与请求提示 | [`QQMemoryStore`](../../../plugins/qq/src/memory.ts) 与包内 RequestPrepare；通用工具不判断QQ | qqRequest测试、[`qqReviewBoundaries.test.ts`](../../../apps/backend/test/service/qqReviewBoundaries.test.ts)、[`qqBusiness.test.ts`](../../../plugins/qq/test/qqBusiness.test.ts)；批次/并发/损坏已覆盖 |
| QQ个人文件 | [`readQQFile/writeQQFile`](../../../plugins/qq/src/files.ts) 与 [`createQQTools`](../../../plugins/qq/src/tools.ts)，从requestView身份取sender；外部持久文件根保留 | [`qqFiles.test.ts`](../../../apps/backend/test/agent/qqFiles.test.ts)，跨会话共享/其他身份/旧版本更新 |
| QQ入站、身份绑定和回执 | [`QQPlugin.register/assertChannel/submit/confirm/start/stop`](../../../plugins/qq/src/index.ts)、[`Adapter`](../../../platform/napcat-plugin/src/adapter.ts)、[`QQTransportMethods`](../../../packages/protocol/src/qq.ts)；白名单/绑定/队列/回执/图片视频/暂停 | [`qqPluginWire.test.ts`](../../../apps/backend/test/service/qqPluginWire.test.ts)、[`qqProtocolContract.test.ts`](../../../apps/backend/test/service/qqProtocolContract.test.ts)、[`qqProcessRestart.test.ts`](../../../apps/backend/test/service/qqProcessRestart.test.ts) |
| Manager注册和页面 | [`createManager`](../../../apps/manager/src/server.ts) → [`DynamicModules`](../../../apps/manager/src/modules/dynamic.ts)，动态描述/预构建资源；旧静态机制已删除 | [`dynamicPlugins.test.ts`](../../../apps/manager/test/dynamicPlugins.test.ts)、[`management.test.ts`](../../../apps/manager/test/management.test.ts)、[`workspace.test.ts`](../../../apps/manager/test/workspace.test.ts) |
| Manager认证与保存 | createManager 的 auth.authorize → DynamicModules → 包管理注册；[`createManagerCoreRpc`](../../../apps/manager/src/modules/capabilities/rpc.ts) | [`auth.test.ts`](../../../apps/manager/test/auth.test.ts)、[`backendAuthBoundary.test.ts`](../../../apps/manager/test/backendAuthBoundary.test.ts)、[`settingsPackage.test.ts`](../../../plugins/settings/test/settingsPackage.test.ts) |

迁移与数据边界：迁移须受限备份先行，注册表/包清单一次切换并更新摘要；v1 包转API2须经 `migrate-api1` 一次性格式转换并按API2改写，不能原地只改apiVersion而不补契约。`.chery/qq-{personal,group,member}-memory/` 的文件内容、身份范围、context及时间保留到 QQ 包 data 下对应 `memory/{personal,group,member}/`，路径摘要算法保持，迁移标记最后写，目标存在则校验一致或冲突拒绝，损坏旧数据拒绝覆盖。`QQ_USER_FILES_ROOT` 保持现有外部挂载，配置传给QQ包而非核心按环境判断业务。核心与QQ配置revision保持，未决发送保留unknown/paused；备份包含秘密时0700/0600且不写日志。设置包复用核心资源保存，不复制模型Key或创建第二份核心配置。
