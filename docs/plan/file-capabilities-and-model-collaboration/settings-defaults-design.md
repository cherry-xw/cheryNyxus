# 设置默认值与保存修复方案

**文档创建时间：** 2026-10-22T00:42:00+08:00

**确认状态：** 本文已获完整确认；代码、测试、模板、正式说明、发布及本轮实际设置验收均已完成，用户已批准本轮收尾和相关提交。四项外部默认按第 8.1 节单独保留未完成；不将本轮完成扩大为全部文件能力完成。实际结果见[文件能力验证](../../quality/verification/file-capabilities.md#设置与常规文件交互的当前验收范围)。复杂度沿用 4/5，沿用已确认模型，不分配其他执行者。

## 1. 目标、范围与边界

用户看到的值应是实际采用的默认值或明确填写的值；只改一个字段不能顺带保存浏览页面产生的其他内容。无默认的必要输入必须在保存前指出，并由后端拒绝缺失配置。

当前调查覆盖共用 `config.yaml` 的 Web 设置、Manager 设置模块、AI 配置入口及运行读取；不是只过滤 FILE-SAVE-01 的六条影响。立即生效的浏览器动效偏好、安装插件、编辑提示文件等独立保存操作不改成全局配置保存。保持现有设置分类、卡片交互、权限、版本冲突、保存与生效状态区分，不另建设置页面或自动调用模型核实能力。

**当前交付边界已选择：** 第 8.1 节四项的默认判定与支持范围核实单列为未完成；本次只给它们明确的“默认未核实”显示，不改既有运行行为、原始值及当前参数接受范围，不因省略新增保存限制。其余设置按本文统一修复。四项不会被记为通过，也不解除 Imagen 的独立阻塞；整个文件能力任务仍须按其余完成条件继续处理。

当前允许提交本轮相关代码、测试、模板与必要文档，不推送；不再执行已通过的保存同步，不新增实际配置修改、启停、模型或文件服务请求、QQ 发送、浏览器或图片操作。

**调查方法：** 从设置显示及用户编辑倒查实际读取，再检查原始配置与全部写入入口。默认数值必须有运行消费者的依据；模板填写值、输入框占位文字、模型目录推荐均不能单独证明默认值。源码结论不等于实际界面通过。

## 2. 已核实事实

### 2.1 不仅是页面初始化问题

- [GlobalTab.vue](../../../apps/web/src/features/agent/settings/tabs/config/GlobalTab.vue) 的立即观察会创建记忆、日志、压缩和看门狗对象；卡片能否显示又取决于这些对象存在。仅删除观察会使卡片消失，或让现有写入函数无法写回，必须一起调整读取和编辑入口。
- [brainFormHelpers.ts](../../../apps/web/src/features/agent/settings/tabs/brain/brainFormHelpers.ts) 的 `capabilities`、`mediaCapabilities` 在读取时创建对象；`MediaCapabilityGrid` 仅显示原始覆盖值，无法区分继承、未知和不支持。切换也必须以实际显示状态为起点，而不是以缺失字段为起点。
- [config.ts](../../../apps/backend/src/utils/config.ts) 的 `readRawConfig` 会给未填写的 `thinking` 添加 `off`；`normalizeRuntimeConfig` 也会补该默认，但它属于运行转换。前者作为设置草稿来源，会把原本缺失的字段变成显式值。现有 ID 补齐和退役字段处理是独立机制，不能因本次默认值修复全部删除。
- [NeonNumberControl.vue](../../../apps/web/src/features/agent/settings/controls/NeonNumberControl.vue) 使用字符串占位显示默认，但加减从 0 起算、进入编辑时变空。未修改内容的聚焦、失焦和退出还需设计为不生成显式覆盖。
- [LoggerCard.vue](../../../apps/web/src/features/agent/settings/tabs/config/cards/LoggerCard.vue) 把缺失的输出数组按 `[]` 切换，缺失布尔值直接取反；实际默认开启的终端、时间和位置可能显示关闭，首次点击还可能写入与实际原值相同的值。
- [LimitsCard.vue](../../../apps/web/src/features/agent/settings/tabs/config/cards/LimitsCard.vue) 的节点树阈值占位为 500；[useTreeCamera.ts](../../../apps/web/src/features/pets/nyxus/components/useTreeCamera.ts) 的实际缺省阈值为 150，卡牌模式还取 `min(配置或默认, 120)`。设置显示应说明基础阈值与该模式限制，不能把界面改为 500 后反过来修改运行默认。
- [FileServiceParameterFields.vue](../../../apps/web/src/features/agent/settings/tabs/tools/FileServiceParameterFields.vue) 用统一的“使用服务默认值”代替实际值；数组从原始字段或空数组开始切换，嵌套组件没有收到适配器和型号上下文。仅在最外层补一个默认占位不能解决嵌套比例、尺寸、画风和返回内容的显示与首次编辑问题。

以上有关实现的 12 份源码已逐字节比较工作区与 `/tmp/opencode/file-draft-fix-20261021/source/`，全部相同：`config.ts`、`sense/bash.ts`、`sense/read.ts`、`logger/index.ts`、`modelCatalog.ts`、`useTreeCamera.ts`、`NeonNumberControl.vue`、`GlobalTab.vue`、`LimitsCard.vue`、`LoggerCard.vue`、`CompressionCard.vue`、`brainFormHelpers.ts`。该比较对应保存异常调查时的固定发布源码，不是当前运行状态证明；本轮最终适用版本见[文件能力验证](../../quality/verification/file-capabilities.md#设置与常规文件交互的当前验收范围)，恢复实施前须重新核对受影响对象，不推定其他混合工作区文件均已发布。

### 2.2 默认来源核对表

下表记录缺省处理的调查依据；字段适用条件与拟采用的统一校验见第 5 节。调查不等于产品验收通过。

| 字段或设置组 | 缺省时实际采用 | 来源及当前问题 |
| --- | --- | --- |
| `files.imageAdaptation` | 5,000,000 字节、最长边 2048、质量 85 | `config.ts` 的 `DEFAULT_FILES_CONFIG` 与 `prepareImage`；Web 已有分离显示的局部实现，Manager 仍以占位表达默认 |
| 上传、未引用保留 | 100 MiB；未提交上传与无引用资产各 24 小时 | `DEFAULT_FILES_CONFIG`；不能为显示而写入这些值 |
| 绘图默认张数 | 1 | `DEFAULT_FILES_CONFIG.imageGeneration`；不写入服务 `defaults` |
| 图片上下文 | 最近 1 用户轮、描述替代、只用已有信息、单图 600 字和总计 6000 字 | `DEFAULT_FILES_CONFIG.imageContext`；选择自动补描述后服务引用为条件必填 |
| 其他文件及请求预算 | 最近 3 用户轮、最多 10 版本、16 MiB、单文件 20,000 字和总计 80,000 字、优先适配版本 | `DEFAULT_FILES_CONFIG.context`；0 轮是明确选项，不能按假值当缺失 |
| 模型请求超时 | 一般请求 10 分钟；QQ 任务路径不使用该限时 | `agent/middleware/chat.ts`；界面显示分钟，存毫秒，不借默认显示改变 QQ 执行规则 |
| 工具执行等待 | 30,000 毫秒 | `agent/sense/bash.ts`；现有等待与后台执行行为不在本次重定义 |
| 审批等待 / 资源等待上限 / 断连宽限 | 300,000 / 1,800,000 / 15,000 毫秒 | `normalizeRuntimeConfig`；各自已有 0 的语义，不得混同缺失 |
| 工具调用上限 | 30 | `agent/middleware/loop.ts` 与 `chat.ts` |
| 看门狗 | 300,000 毫秒，不唤醒主角色 | `agent/spawnBroker.ts`；显示 300 秒时加 30 应得到 330 秒，存 330,000 毫秒 |
| 读取大文件压缩 | 阈值 102,400 字节、预览 100 行、日志样例 3 条、扩展名 `.log/.txt/.out/.err` | `agent/sense/read.ts`；`CompressionCard` 目前缺省扩展名显示空，新增时也从空数组而非实际默认开始 |
| 全局 / 工作区记忆 | 30 / 15 条，各 500 字 | `normalizeRuntimeConfig`；需移除父页为绑定自动补的对象，同时保留实际编辑写回 |
| 日志 | `info`、`json`、终端输出、显示时间及位置 | `logger/index.ts` 的 `loadLoggerConfig`；数组和布尔默认必须参与显示与首次点击计算 |
| 节点树基础阈值 | 150；卡牌模式最多 120 | `useTreeCamera.ts`；设置占位 500 与实际不符 |
| compact | 警告 60%、自动 80%、最低容量 32,000、安全余量 1024 | `DEFAULT_COMMAND_CONFIG`；推荐显示和输入格式转换不能产生未编辑字段 |
| 大脑思考档位 | 配置缺省先按 `off` 处理；具体请求仍受全局开关、型号和协议限制 | `normalizeBrainThinking`；不得为显示把 `off` 添加到原始配置，也不得宣称强制思考型号一定被关闭 |
| 工具调用、原生输入/输出能力 | 显式覆盖 → 目录推荐/事实 → 工具调用开启、媒体能力 `unknown` | `modelCatalog.ts` 的 `resolveEffectiveBrainCapabilities`；媒体 `unknown` 是已实现的默认处理，不是“不支持” |
| 图片格式、动画和服务字节限制 | 显式覆盖 → 目录；格式仍无声明时不能假定支持，动画无声明按未知拒绝不确定的动图；服务字节限制不额外设有限上限，但仍受全局及其他预算约束 | `resolveEffectiveBrainCapabilities`、`service/media/prepareImage.ts`；不能把缺失上限显示成 0、5 MB 或任意模型上限 |
| 大脑每分钟限额 | 不增加本地限流，服务端限制仍可能存在 | `agent/provider/openaiCompat.ts` 的 `acquireRpm`；不是填写一个虚构的无限大数字 |
| 文本编辑器 | 由后端主机系统打开文件 | `service/utils/handler.ts` 的 `handleUtilsOpenFile`；不能显示或推断为用户浏览器所在机器的默认编辑器 |
| 文件服务启用、并发、执行与排队时长 | 启用、2 并发、一般执行与排队各 600,000 毫秒；QQ 连续任务路径不按这两个时长中止 | `service/fileServices/operations.ts` 的 `execute`；显示默认需同时说明现有适用条件，不更改任务策略 |

### 2.3 没有依据的默认与校验差异

1. **旧命令日志保留项没有找到使用处。** `global.bash_log_retention_hours` 在设置里显示 24，模板也填 24；当前 `sense/bash.ts` 使用统一命令运行与原始日志保存，不读取该字段。全仓相关自有源码搜索只找到类型、配置校验、影响计算、界面与测试赋值；`cleanOldBashLogs` 有定义及导出，未找到调用。现有 `bash.test.ts` 明确检查旧摘要保留配置不改变统一原始日志保存。本次不能将 24 小时写为当前有效保留规则，更不能擅自给原始日志增加删除任务。
2. **上下文容量推荐不是数值默认。** `BrainCard` 显示目录容量提示，但运行请求和统计读取保存的 `brain.contextLimit`；`contextUsage.ts` 缺失时按 0 表示未知容量，不证明模型容量为 0，也不证明自动采用目录推荐。需在终版明确它如何符合已确认的必填规则，不能把“未知”改名为默认容量或静默填目录数值。
3. **必填检查不一致。** Web 全量请求的 `brainSchema` 只要求 `model/provider` 为字符串，`validateRawConfig` 用真假判断，空白字符串可能通过；Manager 的 `SettingsBrainSchema` 则检查去掉空白后非空。MCP 按 transport 的 `command/url`、独立文件服务连接及认证方式，也必须在保存前一致校验，不能等真实连接失败才发现缺值。
4. **结构可选不等于业务可省略。** 例如文件服务直接连接的地址、型号、需认证时的凭据，指定工具/角色的目标，以及自动补描述的服务，是有条件的必要输入。未启用对应分支时不要求用户填写无关字段；选用后不能以空字符串或空对象通过。

### 2.4 大脑、连接与继承的补充核对

以下是源码调查与按已确认要求推导的设计约束，不是完整字段清单，也不表示已有实现通过验证。

| 字段或分支 | 已核实的实际处理 | 修复设计约束 |
| --- | --- | --- |
| 大脑服务与型号 | `SettingsBrainSchema` 检查非空白；AI 的 `brainConfigOperationSchema` 只检查字符串长度；全量请求与 `validateRawConfig` 还有不同检查 | 没有通用默认，统一要求非空白；不能只修 Manager 而让其他写入入口绕过 |
| 大脑协议 | `resolveBrainProtocol` 对缺省字段调用 `legacyProtocolForProvider`；例如 OpenAI 缺省走 Chat Completions，不是服务目录供新选择使用的 Responses 推荐；部分服务无法从旧映射得到协议 | 显示现有运行实际采用的协议，不用“新建推荐”替换运行默认；无法解析时必填。更换旧协议映射不属于默认显示修复 |
| 大脑地址 | 聊天请求通过 `resolveLlmProviderDefaultUrl` 使用按服务和协议确定的地址；自定义、中转没有公共默认 | 有可用基础地址默认时显示它但不补写。自定义地址、完整请求地址需填写；完整地址不可拿基础地址冒充。模型列表、连接测试和实际请求需一致使用解析后的地址 |
| 大脑密钥 | `fetchBase.assertChatOptions` 对 OpenAI / Responses / Anthropic 请求要求非空密钥；Ollama 原生客户端不读取 key；mock 不发远程请求 | 按实际协议判断是否必填，不给真实密钥编默认值；Manager 已保存密钥用“已配置，未修改”表示，不能为了显示而回传密钥。必填引用与引用所指环境变量是否存在是不同检查，拟定的保存检查见第 5.2 节 |
| 大脑上下文容量 | `contextUsage.ts` 只用保存值，缺失的 0 是未知标记；目录容量由 `useModelRecommendation` 提示，不是运行默认 | 按用户的无默认则必填规则，缺失时提示填写正数容量；目录推荐仍与正式配置区分。Manager 当前没有容量输入，需要同步提供，不能让用户只能到 Web 补齐 |
| 模型切换后的推荐 | `modelRecommendationDraft.ts` 用“等于上个推荐”判断是否跟随，并可清除或覆盖上下文、思考及能力；这不能证明原值由谁填写 | 不能仅凭相等就删除已有显式值。保留主动选择模型时的服务/协议联动；上下文、思考、能力及地址的拟定处理见第 6.3 节 |
| MCP 传输配置 | `core/mcp/client.ts` 按显式 transport 分支，stdio 缺 command、HTTP 缺 url 时连接失败；没有 transport 缺省分支 | transport 必填；所选分支的 command 或 url 必填且不能只有空白。不要求用户为未选的分支补值，也不靠真实连接测试才能发现缺失 |
| 文件服务连接 | `operations.execute` 使用 `brain.url ?? connection.baseUrl`、`connection.model ?? brain.model` 和相应密钥；这里没有复用聊天入口的服务默认地址解析 | 复用大脑连接必须与大脑实际连接的默认地址一致；独立连接没有地址和型号默认时必填。不能只让显示声称继承成功而让执行继续缺地址 |
| 文件服务认证 | `adapters/http.ts` 在无显式 authType 时，普通 HTTP 适配器用 Bearer，Google 分支用 `x-goog-api-key`；显式 none 不发认证信息 | 显示适配器实际采用的认证方式；需认证分支必须有密钥或有效的已保存引用，none 分支不要求无关密钥；不调用服务验证 |
| 文件服务工具映射 | `custom-sense-mcp` 要求映射；HTTP 直连字段不能充当已有工具映射的默认值 | 分开检查工具名、资产字段、问题字段及传输方式；只检查所选映射分支，不要求它填写无关 HTTP 连接 |
| 文件操作处理方式 | `capabilityResolver.resolveFileCapability` 采用本次指定、预设覆盖、角色配置、auto 的顺序；角色或预设的 disabled 是禁止，不能被本次指定越过 | 展示已解析方式及来源；tool / role 必须填写存在且被允许的目标。auto 不能显示成已支持，实际状态继续由已有能力查询给出 |
| 图片输入格式、动画、大小 | `resolveEffectiveBrainCapabilities` 合并目录与用户覆盖；无格式声明不能猜支持，无大小声明不增加额外有限上限；动画未知继续拒绝不确定动图 | 明确显示继承后的列表、未知或“不增加额外限制”，不能留空暗示有未查明默认；用户格式空数组是明确关闭，不按无配置清掉 |
| 图片输出张数能力 | `ImageOutputCapabilitySchema` 按多图与张数控制状态要求上限；`calculateImageCount` 对未知、不可控、单图分别处理 | 每个操作显示实际继承结果。支持原生多图或可控张数时要求对应有效上限；不能用 0 表示缺失，也不凭未知能力开放多图 |

**Manager 恢复默认还存在写回问题。** [service.ts](../../../plugins/settings/src/service.ts) 的 `SettingsService.commit` 将大脑提交值与旧资源浅合并；请求省略 `thinking`、`rpm` 等顶层字段时，旧值会保留。因此仅在 Manager 控件里删除草稿字段无法恢复默认。终版需明确单一的删除覆盖约定及请求示例，保留密钥不回显、不因字段省略而删除密钥的边界；不能靠全量清空资源解决。

**模型列表也受默认地址影响。** [useBrainConnection.ts](../../../apps/web/src/features/agent/settings/tabs/brain/useBrainConnection.ts) 与 [useCapabilities.ts](../../../plugins/settings/ui/useCapabilities.ts) 在 URL 缺失时阻止查询；Web 还统一要求 key，未按 Ollama 原生分支区分。[utils 处理器](../../../apps/backend/src/service/utils/handler.ts) 在部分分支解析环境引用后直接使用 URL；Manager [模型路由](../../../plugins/settings/src/index.ts)先检查 URL，再通过 `modelKey` 以已保存的显式 URL 比较来保护密钥。这些入口不能仅靠显示默认地址修复：需要统一解析且维持不向新地址发送已存密钥的保护，拟定约定见第 7.3 节。

**MCP 缺省目标已确认：默认不启用。** [设置说明](../../frontend/settings.md#角色图鉴与装备)和 [RolesTab.vue](../../../apps/web/src/features/agent/settings/tabs/agent/RolesTab.vue) 将 `mcpServers` 未设置显示为“继承全部”，但 `resolvePresetSelection`、`resolveDetailSelection`、[运行选择](../../../apps/backend/src/service/chat/runtime.ts)的 `resolveEffectiveSelection` 以及[会话配置](../../../apps/backend/src/service/runtime/session.ts)均把角色未设置值转换为 `[]`；[公共角色类型](../../../packages/plugin-api/src/config.ts)的 `RoleConfig.mcpServers` 也明确缺省为 `[]`。这与技能、插件的未设置继承全部不同，不能用共用装备控件的文案推断 MCP 的真实结果。

- 用户已选择“默认不启用”：保留当前执行结果，未设置 MCP 时界面显示“默认不启用”，选定服务后才使用；不扩大现有角色的工具范围，不实现自动继承全部。
- MCP 装备选择与汇总不能继续套用技能/插件的“未设置即全部”显示和估算；未启用时按无服务展示及估算，缺省字段仍保持省略。已有显式空数组与指定列表保留，新增服务不自动加入角色。
- 技能、插件原有继承规则不变。MCP 的选择入口不能再提供名为“继承全部”却实际清空配置的操作；完整交互纳入终版，不借修文案改变运行授权。
- 该决定属于修复目标，不代表产品已修改或获准发布；设置说明中的相应冲突描述在整体方案确认后同步落实。

## 3. 已确认的修改方式与数据边界

用户已选择“替换旧实现”：本次统一替换设置读取、编辑、默认恢复和多个写入入口中有问题的实现，不保留新旧两套执行路径。下表仅保留取舍依据，并存方案不是当前实施方向。

| 方面 | 破坏性修改：替换旧读写实现（建议） | 直接更新：新旧实现暂时并存 |
| --- | --- | --- |
| 用户看到的效果 | 所有本次相关字段用同一原则显示实际值；旧补值读取和误导控件不再使用 | 需要逐个入口接入新处理；过渡期间要同时确认旧路径没有继续补值或空白显示 |
| 实现与验证成本 | 一次替换造成默认与草稿混用的内部接口，并同步全部调用方；测试只维护一套目标行为 | 保留旧绑定及读取返回约定，以新增显示层和写入保护包住；两套路径都要测，遗漏风险更高 |
| 配置与数据 | 保留有效 YAML 字段、显式值、凭据、会话和文件；不全量清空空对象或自动清理等于默认的值。旧日志保留项按本节已确认边界撤下 | 可保留旧接口行为，但必须记录哪些值由读取补入，并防止回存；不能靠数值相等猜测用户是否明确填写 |
| 其他调用方 | 同批更新 Web、Manager 设置模块、AI 配置工具及原始读取调用方，不留旧补值返回分支；发布需对应版本一起检查 | 可以分批换内部调用方，但过渡安排不能让最终交付继续违反已确认规则；不能把未换入口称为完成 |
| 后续维护 | 一套默认读取、显式编辑和公共校验；不留兼容开关 | 必须在本次修复验收完成、正式交接前移除旧路径；若用户选择对照期，需另定明确结束条件，不能无期限保留 |

两种选择都不能更改已确认的默认/必填要求，也都不授予发布或实际配置写入权限。“破坏性”在这里是替换有问题的内部实现，不代表删除账号、历史、文件或全部配置，不要求为了换实现而更名现有业务字段。

**旧命令日志保留项：** 用户说明当前为测试环境，后续数据可全部删除。本次据此撤下无实际作用的 `global.bash_log_retention_hours` 设置入口和无消费者声明，不为它保留兼容路径，也不新建日志清理功能。实际配置中的残留字段在后续获准迁移时定点处理；当前不删除日志、不清空配置、会话或文件。“后续可全部删除”不是现在执行全量清理的授权。

上述修改方向及完整设计已获实施授权；实际配置迁移和发布仍需单独授权。

## 4. 拟定交互与保存流程

本节与第 5—7 节为已确认的实施要求；第 8 节维护范围划分、实施顺序与停止条件。

| 动作或状态 | 拟实现结果 |
| --- | --- |
| 打开、切页、查询目录 | 草稿只保留原始字段；默认、继承结果和查询状态只用于显示，不创建配置对象。日志、压缩、看门狗及记忆卡不因原始对象缺失而隐藏 |
| 默认数字进入编辑又退出 | 编辑框有显示数值及单位；没有实际编辑时不写入。不把聚焦、失焦、Enter 或 Esc 当成用户显式设置 |
| 点击加减或切换开关 | 从实际显示值计算，完成后仅写对应显式字段及必要父对象。日志扩展名增删从当前实际列表计算，不丢掉其余默认项 |
| 恢复默认 | 仅删除该字段的覆盖，立即显示实际默认及来源；单列项按第 8.1 节显示未核实。保留同对象其他值、明确的空数组、false 和 0。清理仅限该操作产生且无含义的空父对象，不全份递归过滤 |
| 显式值等于默认 | 按用户已确认要求保留其显式状态，只有用户恢复默认才删除；不按数值相等自动重写已有配置，不将此要求重新列为待决定 |
| 非法输入或必填缺失 | 字段显示具体错误，父级保存也识别错误；不把非法值悄悄变默认、裁到最小值或序列化为 null。后端预览、保存及其他写入入口复用同一检查，返回字段路径；不发出有副作用的保存 |
| 能力结果加载或失败 | 不能短暂显示为不支持；加载失败保留草稿并说明无法取得默认结果，不回写猜测值。默认来源变化的旧回复不能覆盖新型号、协议、身份或较新查询 |
| 保存与冲突 | 沿用现有 `baseRevision → preview → 同一快照 save` 及请求标识；预览只列实际编辑差异。失败和并发冲突保留草稿，不自动重载或重试；保存成功与运行已采用仍分开显示 |

复用共享默认常量、纯读取函数及既有能力查询；具体归属见第 6 节，不新增默认值 RPC。能力显示不调用收费接口、不执行真实连接测试。

## 5. 字段适用条件与保存检查

### 5.1 全局、文件与记忆

本表的默认值引用第 2.2 节，不另设第二套默认。下面的数值均须有限；表示个数、字节、字符、行数的字段检查整数。毫秒时长沿用当前有限非负数范围，不借本次修复额外改变精度规则。

| 字段 | 缺省显示及适用条件 | 保存检查与恢复默认 |
| --- | --- | --- |
| `global.thinking / stream / supervision` | 当前原始结构要求明确填写，没有由模板值推导的运行默认 | 前两项为必填布尔值，监管为必填枚举；缺失显示“必填”，不把缺失当关闭；不提供虚假的恢复默认 |
| `global.llm_request_timeout_ms / sense_execute_timeout / approval_timeout / approval_hard_timeout / disconnect_grace_ms` | 各自使用第 2.2 节实际时长；0 的含义及 QQ 路径保持现行执行规则 | 非负数；按控件单位换算，仅实际编辑时写入；恢复时删除对应叶字段，不动其他时长 |
| `global.maxLoopCount` | 30 次 | 正整数；不新增“无限”或负数约定 |
| `global.watchdog.timeout_ms / wake_on_timeout` | 300 秒、关闭唤醒主角色 | 时长非负，开关为布尔；原对象缺失仍显示并可编辑 |
| `global.tree_full_render_threshold` | 基础 150，卡牌模式最多 120；0 表示始终裁剪 | 非负整数；恢复基础默认不改变模式上限 |
| `global.history_recall.max_output_chars` | 4000 字符，依据 `normalizeRuntimeConfig` | 正整数；没有入口的隐藏字段不因打开设置而补写 |
| `global.logger.level / output / timestamp / location / format` | info、终端、显示时间与位置、JSON | 枚举、枚举数组、布尔值；明确的 `[]` 表示不输出，保留它，不当作缺失 |
| `global.file_compression.*` | 阈值、行数、样例数及扩展名使用第 2.2 节结果 | 三个数值为正整数，扩展名为字符串数组；`[]` 关闭日志扩展名匹配；添加/移除以实际显示列表为起点 |
| `global.command.warn / auto` | 60%、80% | 每项是完整的 `{unit,value}`；percent 为 0—1，tokens 为非负数；界面百分数与配置小数只在主动编辑时换算 |
| `global.command.min_context_limit / safety_margin` | 32,000 / 1024 | 非负数，继续保留 safety_margin 不在 UI 暴露的现有边界 |
| `global.textEditor` | 后端主机的系统打开方式 | 缺省用系统，不要求虚构编辑器命令；指定时为非空白字符串；清空为恢复系统 |
| `memory.global / workspace` 的 `max_count / max_chars` | 30 / 15 条，各 500 字 | 正整数；四个叶字段独立编辑与恢复，缺省对象不隐藏卡片 |
| `files.imageGeneration.defaultCount` | 1 张 | 正安全整数；仅这里保存全局默认张数，服务 defaults 不复制 |
| `files.maxUploadBytes / unreferencedUploadRetentionHours / unreferencedAssetRetentionHours` | 100 MiB / 24 / 24 小时 | 正整数；不借修复改变清理对象或删除历史文件 |
| `files.imageContext.mode / recentUserTurns / replacement / missingDescription` | recent / 1 / description / existing | 使用现有枚举；recentUserTurns 为 1—10,000 整数；当前轮和不限轮使用各自 mode，不用非法的 0 代替 |
| `files.imageContext.serviceId` | existing 分支不调用服务 | inspect 分支必选已存在、启用且支持 image.inspect 的服务；没有该分支时不要求无关服务，旧显式引用不因切换模式自动删除 |
| `files.imageContext.maxDescriptionChars / maxTotalDescriptionChars` | 600 / 6000 | 单图 100—4000、合计 100—40,000 整数；按缺省与覆盖合并后检查合计不小于单图 |
| `files.context.recentUserTurns` | 3 轮 | 非负整数，明确的 0 保留；不改图片单独的轮次规则 |
| `files.context.maxAssets / maxBinaryBytes / maxExtractedCharsPerAsset / maxExtractedChars / defaultImageVariant` | 10 / 16 MiB / 20,000 / 80,000 / adapted | 前四项为正整数，版本为 original/adapted；按叶字段恢复，不删除其他文件策略 |
| `files.imageAdaptation.maxBytes / maxEdge / quality` | 5,000,000 / 2048 / 85 | 正安全整数字节；边长 1—16,384 整数；质量 1—100 整数；PNG、合规原图和适配流程保持原要求 |
| `global.bash_log_retention_hours` | 不再提供入口和有效规则声明 | 按第 3 节撤下；旧字段的实际定点移除归获准迁移，不删除日志 |

### 5.2 大脑与环境引用

第 2.4 节的大脑服务、型号、协议和地址规则适用于所有保存入口。`contextLimit` 必填，为正整数 token 数，界面 K 按 1000 换算；不以预填占位或目录推荐代替用户明确设置。Manager 补齐此字段的输入、单位和错误显示。

| 字段 | 缺省处理与必要输入 |
| --- | --- |
| `provider / model` | 无通用默认，非空白必填；模板的 `<...>` 占位不算填写完成 |
| `protocol` | 只允许显式值或当前 `legacyProtocolForProvider` 能得到的实际协议；无结果时必填，不把目录新建推荐当旧配置的默认 |
| `url / fullUrl` | fullUrl 默认 false。基础地址可继承 `resolveLlmProviderDefaultUrl`；自定义服务或 fullUrl=true 时必须明确地址，且解析后为合法地址。Ollama 原生需要 HTTP(S) host；mock 不要求远程地址 |
| `key` | OpenAI Chat / Responses / Anthropic 分支要求非空密钥或引用；Ollama 原生、mock 不要求。保留本地兼容服务目前必须显式提供其接受的 key 的规则，不新造自动占位密钥 |
| `thinking` | 省略采用 off 的运行配置默认；显示型号/协议实际允许的档位及冲突，不把不允许关闭的型号显示为“确定已关闭”；不因查询而改全局思考开关 |
| `rpm` | 省略不增加本地限流；指定时为正数，清空或恢复删除覆盖，不写 0 或无限大 |
| `capabilities` | 按第 2.2、5.4、6.1 节显示实际继承及来源；缺省不创建对象，已有显式 unknown / false / 空格式数组均保留 |
| `hooks` | 缺省不叠加大脑专属 Hook 文件，仍执行全局 Hook；指定文件引用按现有 Hook 规则检查，不改成另一套保存入口 |
| `anthropicCompat.official` | 使用 `chat.ts` 的实际计算：DeepSeek 强制 false；其余先取显式值，否则仅显式 Anthropic 协议且服务为 Anthropic 或 MiniMax 时为 true；不能照注释一律显示 false |
| `mock` | 不创建新模拟环境；已有 mock 配置字段继续保留。配置脚本对象时 file 为非空白输入；脚本项未指定延迟时沿用 brain 延迟，再缺省为 0 毫秒，查看不写入 |

**环境引用的拟定规则：** 原始配置保留 `$ENV`，运行和校验结果不回填解析值。保存前由后端用与运行一致的 `.env + process.env` 读取方式，检查所选分支中必填地址、型号或密钥引用是否实际可得到非空值；未配置时返回字段路径并拒绝保存，不把已有“环境变量未配置”软警告冒充必填通过。该收紧是待整体确认的方案；不检查远端密钥是否有效、不做付费或连接请求。未参与所选分支的引用继续按现有警告规则处理，不凭本次要求禁止保存所有未使用变量。

**读取与完整校验分开：** 缺值配置仍须能够打开并定位错误；只读目录识别、能力显示不要求用户先修好所有资源。完整保存、AI patch、回滚、运行采用使用同一字段约束。新校验若发现现有配置缺必要字段，不迁移填值、不删除该资源、不为改质量而放宽校验；先列出具体缺口，获得用户输入或决定后再恢复实际保存测试。

### 5.3 角色、预设、工具与 MCP

| 设置组 | 实际缺省或必填条件 | 界面和保存要求 |
| --- | --- | --- |
| 资源名称、角色大脑、预设组长 | 没有可代替用户选择的默认 | 非空白；引用必须存在。预设组长属于普通私有成员；固定预设、公共与锁定角色约束继续按现行规则 |
| `roles.*.senseGroup` | 有工具能力时必须选已有组；无工具能力时沿用现有前置理解工具例外，不强行填一个组 | 统一修正 AI schema 目前不能表达空工具组的差异；不增加工具，不允许凭缺省绕过权限 |
| `mcpServers` | 未设置与 `[]` 均不启用 MCP；用户已确认 | 显示“默认不启用”或明确已关闭，列表仅在用户选择后保存；汇总和 token 估算为 0，不提供误导性的“继承全部” |
| `skills / plugins` | 缺省全部相应技能/插件，`[]` 为没有 | 展示实际目录名单或可展开数量，保留现有继承及明确关闭的区别，不与 MCP 共用错误的缺省解释 |
| `permissions` | 缺省采用 supervised；各叶覆盖按 `core/security/rolePolicy.ts` 的 `defaultPolicy + mergePolicy` | 显示模板和现有生效预览；恢复只删相应覆盖，不改成“全部允许”。工具、文件、命令、MCP、派遣各维度仍受真实执行校验 |
| 角色 `kind / scope / mentionable / lock` | 普通角色 / 非显式公共 / 不允许 @ / 不锁定；系统种子角色另受固定规则保护 | 不把固定角色当可编辑普通默认；元信息、描述、头像未设置时使用既有展示方式，不要求编造业务文本 |
| `systemPrompt` | 缺省不叠加角色提示文件 | 指定后检查文件存在，路径仍相对后端 `.chery` 解析；不把无文件显示成空白必填 |
| `fileCapabilities` 及预设覆盖 | 按“本次指定 → 预设 → 角色 → auto”，disabled 仍禁止越过 | 显示实际方式和来源；tool / role 目标为条件必填，检查存在、允许与同操作循环；auto 不等于可用 |
| `presets.*.roles / leader / detailRole` | 无成员时无法构成有效组长配置；未选解释角色时不可使用解释功能 | 成员须含有效组长；解释角色为不同于组长的普通成员。省略 detailRole 显示“未启用解释角色”，不静默找替代角色 |
| `workspace / rule / shadows.conversationRouting` | 缺省不限定工作区 / 只用基础审批规则 / 不启用会话路由 Shadow | 显示这些处理结果，不显示虚构路径；指定工作区仍按既有绝对路径检查与警告规则；路由 Shadow 的类型、专用工具组及无 MCP 限制不变 |
| `schedule` | 无对象不启用定时；对象存在时 enabled 缺省为 true | 启用后 cron 与 task 均为非空白必填，按既有 cron 解析器校验；仅查看不能创建 schedule，从而意外开启任务 |
| `sense_groups.*` | 用户已创建的空组可以是明确空工具列表 | 空数组保留，项为有效非空白工具名及合法监管后缀；显示生效等级，不为显示补 `:smart` |
| `mcp_servers.*` | transport 无默认；stdio 要 command；HTTP 要 url | 分支必填项非空白，HTTP 为有效 HTTP(S) URL；args 缺省无额外参数；env 的 SDK 缺省按已确认单列边界显示“默认未核实”，保持当前传递方式，不声称完整继承父进程环境，见第 8.1 节。supervision 未覆盖时沿用实际全局/工具监管链；不在打开页面时连接或启动 MCP |
| MCP 的未选传输分支字段 | 不参与当前连接 | 保留已有显式内容，不为了隐藏控件而删除另一分支；选回该分支再按该分支校验 |

### 5.4 文件服务、图片限制与参数

| 设置组 | 缺省或必填条件 | 保存与展示要求 |
| --- | --- | --- |
| 服务 ID、name、adapter、operations | 无替代用户选择的默认 | 名称非空白，ID 沿用现有格式；操作至少一个且由适配器支持；不能靠空 connection 对象算完成 |
| enabled、maxConcurrent、timeoutMs、queueTimeoutMs | true、2、一般任务各 600,000 毫秒 | 并发为正整数，两个时长为 1—3,600,000 整数；QQ 连续执行差异保持，不声称普通限时能中止 QQ 任务 |
| `connection.brainRef` | 选择复用时必须引用已有大脑 | 与独立 baseUrl/keyRef 互斥；型号覆盖允许保留。地址解析与聊天默认统一，执行、可用性判断、草稿试跑准备使用同一解析函数。HTTP 文件适配器复用 fullUrl=true 的大脑时，须为每个启用操作明确填写 endpointOverrides；不从完整聊天端点猜基础地址或截取路径。vision-brain 仍使用原聊天端点 |
| 独立 `baseUrl / model / keyRef / authType` | 无地址/型号默认，按适配器认证方式决定密钥必填 | 地址、型号非空白；none 分支不要求 key，其余分支必须有值；认证默认按第 2.4 节，不自动选择无认证绕过缺值 |
| `vision-brain` | brainRef 必填，复用该大脑连接和实际图片输入声明 | 只允许已有实现支持的视觉理解操作与协议；显示配置依据不等于模型已实测通过；同样复用正确的默认地址 |
| `custom-sense-mcp` | 工具名、输入资产字段、问题字段、传输方式均为必填映射 | 不要求无关 HTTP 地址与密钥。constantParams 缺省无附加常量，resultPath 缺省使用结构化结果/原文字；远程 MCP 不能用本地资产 ID，不能映射回文件服务形成循环 |
| `endpointOverrides` | 没有覆盖时按适配器现有路径规则拼接 | 指定后是所选操作的完整 HTTP(S) 端点；Imagen 的 Vertex 端点及 Bearer 条件继续作为独立阻塞，不自动填入其他服务地址 |
| 图片输入 `formats / animation / maxBytes / maxBase64Bytes` | 按第 2.2 节用户覆盖、目录、未知或无额外上限处理 | 列表和状态直接显示；无额外上限不表示绕过全局预算。指定大小为正安全整数；formats 的显式 `[]` 保留 |
| 图片输出 `nativeMultiImage / countControl` | 按操作继承目录及适配器边界；无依据时 unknown | 显示继承后的状态而不生成手动对象；主动新建手动组时完整保存两个状态，不把未知作为支持 |
| `maxImagesPerRequest / maxInputAndOutputImages` | 单图状态的实际单次上限是 1；无合计声明时不额外设合计限制 | 正安全整数。多图 supported 要求上限至少 2；requested/maximum 要求单次上限；手动单图上限只能是 1。恢复目录为删除该操作整组手动覆盖，说明这一作用范围 |
| 服务 defaults | 仅保存用户主动设置的非张数参数，不是整份执行请求 | 参数值先取本次覆盖、再服务覆盖、再适配器实际值、最后已核实的服务端默认。prompt、参考图片、蒙版等任务输入不因为设置默认值而变成服务必填内容 |

**外部参数调查（2026-10-22）：** 默认依据为 MiniMax [文生图原文](https://platform.minimax.cn/docs/api-reference/image-generation-t2i)、OpenAI 官方发布的 [OpenAPI 说明](https://github.com/openai/openai-openapi)及[接口说明文件](https://raw.githubusercontent.com/openai/openai-openapi/main/openapi.json)中的 `CreateImageRequest / CreateImageEditRequest / ImageGenTool / InputFidelity`、火山方舟[图片生成 API](https://ark.volcengine.com/region:cn-beijing/docs/image-generation-api.md)与[图片生成教程](https://ark.volcengine.com/region:cn-beijing/docs/seedream-4-0-5-0.md)。已读取对应原文，不以搜索摘要代替。项目额外处理依据为 [providers.ts](../../../apps/backend/src/service/fileServices/adapters/providers.ts) 及 [imageOutput.ts](../../../apps/backend/src/service/fileServices/imageOutput.ts)。以下默认仅用于对应接口、型号及已实现参数；不推广到同名中转服务，也不扩展现有型号参数支持范围。

| 参数 | 已核实的缺省结果 | 项目需要显示什么 |
| --- | --- | --- |
| MiniMax `aspect_ratio / width / height` | 官方缺省 1:1（1024×1024）；image-01 支持成对宽高 | 没有宽高覆盖时显示 1:1；使用宽高模式时二者同时必填，不能为了显示 1:1 把比例发到请求里覆盖宽高 |
| MiniMax `response_format` | 官方 url；项目 `providers.minimax` 显式补 base64 | 显示“Base64 · 项目默认”，不是“URL · 服务默认”；原始 defaults 不补 base64 |
| MiniMax `prompt_optimizer / aigc_watermark / seed` | false / false / 每张图随机种子 | 显示关闭 / 关闭 / 随机；恢复随机是删除 seed，不填 0 |
| MiniMax `style` | 未选不指定画风；启用时 style_type 必填，style_weight 官方缺省 0.8 | 仅 image-01-live 展示；没有选择画风不要求无关 style_type；选择后显示真实强度默认 |
| MiniMax `n` | 服务端默认 1，但本项目统一计算当次张数 | 不在 defaults 提供另一份数量，沿用全局及当次张数规则 |
| GPT Image `size / quality / background / output_format` | Images 生成、multipart 编辑及 Responses 图片工具的官方缺省为 auto / auto / auto / png | 显示自动尺寸 / 自动质量 / 自动背景 / PNG；auto 是选择策略，不声称固定像素或固定质量；型号限制仍按现有校验 |
| GPT Image `output_compression` | 官方默认 100，Images 仅用于 JPEG/WebP；项目也要求明确选择这两种格式后才能设置压缩 | PNG 显示“不适用”，不是缺少必填值；JPEG/WebP 显示 100，不与全局图片输入的编码质量 85 混用 |
| GPT Image `moderation / input_fidelity` | 生成接口和 Responses 工具的 moderation 默认 auto；已支持参考保真度参数的型号默认 low | 按接口及型号显示，生成操作不提供参考保真度输入；不把旧代 low 推广到已禁止此参数的型号。multipart 编辑的 moderation 按已确认单列边界显示默认未核实，见第 8.1 节 |
| Images `response_format` | GPT Image 总是返回 Base64；项目删除此旧参数后发送请求 | 显示固定的 Base64 返回，不提供 URL 选项；不为显示往 defaults 加入旧参数 |
| Responses `image_model` | 官方 `ImageGenTool.model` 默认 gpt-image-1；连接的 model 仍是对话型号 | 显示图片工具型号及来源，不能把对话型号当作图片型号；不因补齐显示而把 gpt-image-1 写入 defaults 或默认开放新版专属参数 |
| Responses `action / partial_images` | action 省略时项目按操作补 generate/edit，显式 auto 则保留 auto；partial_images 官方为 0，项目仅支持 0 的非流式路径 | 显示实际操作或用户的 auto 覆盖及不请求部分预览；恢复 action 后重新显示项目按操作确定的值，不显示厂商默认 auto |
| Gemini `responseModalities` | 项目显式补 `['TEXT','IMAGE']` | 显示文本和图片均选中；手动选择必须包含 IMAGE |
| Seedream `response_format / stream` | 项目显式补 b64_json / false | 显示 Base64 / 非流式；stream 固定值不提供假开关 |
| Seedream `size` | pro/flash 生图缺省 2K，由模型按提示确定宽高；5.0 lite、4.5、4.0 缺省 2048x2048 | 分型号显示 2K 或 2048×2048；不能把 pro/flash 的 2K 标成固定 2048×2048。图层拆分未实现，其 auto 默认不引入当前生图表单 |
| Seedream `output_format / background` | 支持指定格式的 5.0 型号常规输出默认 JPEG；pro/flash 背景默认 opaque，选择 transparent 且未填格式时输出 PNG；4.5/4.0 格式固定 JPEG | 按型号和透明分支显示，透明分支显式 JPEG 继续拒绝；没有可选背景参数的型号不展示为可以设置透明 |
| Seedream `watermark / optimize_prompt_options.mode` | 水印默认 true；优化模式默认 standard | 显示开启水印及标准优化；pro 可选 fast，flash 不可选 fast；不借默认显示扩大当前其他型号的参数支持 |
| Seedream 组图参数 | 官方默认 disabled，auto 下 max_images 默认 15；项目根据本次张数统一生成参数，pro/flash 不发组图参数 | 不在服务 defaults 中增加第二套数量入口，不把官方 15 当作项目默认张数；保留已确认的全局与当次计算 |
| 蒙版、画风、参考输入等分支 | 不选择相应功能时，不增加该处理；不是所有字段一律必填 | 用“未使用蒙版”“未指定画风”等实际处理表达缺省；仅在主动选择对应功能时检查必要输入。种子的缺省必须逐适配器核实，不能全部写成随机 |

**已确认单列的未核实部分：** Google 网页正文仍超时，但已读取其[官方 SDK 的 ImageResponseFormat 说明](https://googleapis.github.io/python-genai/genai.html#genai.types.ImageResponseFormat)：包含 `aspectRatio / imageSize`，只写可选，没有说明省略后的服务行为；字段名接近项目发送的 `generationConfig.responseFormat.image`，但 SDK 结构和枚举不能直接证明 REST 请求的序列化格式。同页旧 `ImageConfig.image_size` 的 1K 默认不能自动套到此结构。Seedream 当前两份官方资料未说明旧代 seed 的省略行为，不能从其他视觉服务接口搬来 -1。Images 的 multipart 编辑说明未列 moderation，不能把生成接口的默认照搬。保留行为、显示和继续核实安排统一见第 8.1 节；Imagen 独立阻塞不因此解除。

**文件参数表单的拟定处理：** 扩展现有 `imageParameterFields` 的显示资料，提供按适配器、实际图片型号、操作及透明/宽高等分支计算的显示值、来源、是否适用和必要输入条件，不使用会补写的 schema default。嵌套组件继续携带同一上下文；数组首次增删从实际显示列表开始。服务设置只写主动覆盖；试用和会话绘图另以服务 defaults 作为显示上层，删除本次覆盖后重新显示服务值，不把显示展开结果复制进本次参数。历史恢复保留既有请求显式值，不按等于当前默认删除。字段错误必须传到父级保存或提交入口；查看不触发试用、生成或连接请求。

## 6. 共用实现与原始配置边界

### 6.1 默认与能力的归属

1. 将第 2.2、5.1 节可共享的常量及纯读取函数归入 `packages/protocol/src/`；Backend 运行默认和 Web/Manager 显示导入同一来源。读取函数只返回值，不初始化入参、不读环境、不发请求。`useTreeCamera`、logger、read_file、watchdog、compact 等实际消费者同步使用相应共享常量，不能只改占位数字。
2. 模型目录仍由后端持有，Web 和 Manager 继续通过 `utils.modelRecommendation` 及现有 Manager 代理取得 facts、recommend、unknown 和档位。抽取共享的纯能力合并函数：输入当前模型的目录结果与用户原始覆盖，按现行顺序返回 toolCall、input、output、imageInput 和每项来源；后端 `resolveEffectiveBrainCapabilities` 与两个设置端复用，不在前端复制另一份目录。
3. 图片输出的目录/手动声明也共用纯合并函数；服务实际张数仍由 `resolveImageOutput` 按具体适配器、操作、参考图数量限制，不能把大脑声明当作已实现的文件服务能力。服务端点继续使用已有 `/api/file-services/image-output` 返回 availability、source、capability 和 count，不新增默认值接口。
4. 查询成功但目录未知，显示已实现的 unknown；查询尚未成功，不把“未收到目录”解释为“目录确定未知”。显式用户值可继续显示，依赖目录的缺省部分显示加载或失败并可重试；不因失败改草稿或禁用不相关设置。
5. Web `GlobalTab`、`brainFormHelpers` 和各控件改为纯读显示、用户操作时写叶字段。恢复默认仅清理本次删除操作产生且没有业务意义的空父对象；不扫描清空整份配置、不重写既有显式默认值。
6. 原始 `readRawConfig` 不再补 thinking；保留已有稳定 ID 和退役字段的独立处理，不将运行展开值用于设置基线、Manager 合并或 AI get。读取后的配置版本随原始语义变化重新计算；发布后所有客户端重新读取并建立新基准，不沿用旧 previewToken 或旧修订。

### 6.2 一套校验，各入口共用

- `packages/protocol/src/settings.ts` 维护共享的字段结构、枚举、数值范围和不依赖环境的条件检查；不使用会自动补写的 schema default，不静默裁切/转换非法输入。
- Backend 的 `configRawSchema`、AI 的 `brainConfigOperationSchema / roleConfigOperationSchema / presetConfigOperationSchema` 复用对应结构；`validateRawConfig` 使用同一结果，再检查跨资源引用、文件存在和分支条件。保留目前明确支持的扩展字段，不因统一 schema 自动丢弃其他任务或供应方配置。
- 环境解析、文件/目录检查、权限与运行限制归后端，前端只做能确定的必填及范围检查；不能因浏览器没有后端环境值就声称密钥缺失。Manager `keyConfigured` 仅证明保存过值，不代替后端对其实际引用的检查。
- Web 全量 `config.preview → config.save`、Manager 资源保存及文件策略保存、AI patch、回滚和外部磁盘采用都检查完整候选。失败不备份写盘、不产生采用或重启动作。读取和显示查询不套完整保存检查，避免无法打开并修复缺值资源。
- 区分原始读取结构与完整写入约束。`SettingsBrainViewSchema` 及 Web 的配置读取响应不能因复用写入必填约束而拒绝展示缺容量等旧配置；仍保留明确的字段类型和脱敏边界。Manager 局部 value 也不能在与旧资源合并前被当成完整大脑校验；合并及 unset 后再统一验证，保留未显示字段与未回显密钥。缺值显示错误，不由读取层自动修复。
- `/api/file-services/resolve` 与 `image-output` 的只读草稿准备须能处理编辑中的部分配置：校验与查询对象有关的结构，缺值返回现有 unknown/unavailable 及原因，不为了查询补全或提交候选，不因另一颗大脑缺容量而阻断目录显示。执行入口仍要求完整相关连接、权限及参数。
- 错误沿用现有 RPC / HTTP 包装和错误码，message 按行给配置路径及具体原因；Manager 的脱敏不得把字段位置一并丢掉。Web 错误定位补齐 files、file_services，单个控件错误通过 `aria-describedby / aria-invalid` 关联，必填和恢复默认均可用键盘操作；不靠短暂提示代替持续错误。

### 6.3 主动选择与推荐

- 打开、切页、刷新目录、修改同一模型的服务或协议，只刷新显示与合法性，不应用目录推荐到容量、思考或能力草稿。
- 主动换模型保留现行服务/协议联动。容量、思考和能力只保留已有显式覆盖，并刷新其合法性；缺省能力自动显示新目录结果，不复制成手动值，不以“等于旧推荐”判断可覆盖。
- 容量没有运行默认，新建或缺容量的大脑显示必填错误；目录推荐显示在容量字段附近，提供明确的“采用推荐值”动作，点击才写容量，不代替用户猜容量。已有显式容量即使等于旧推荐也保留。
- 地址缺省时跟随实际服务/协议默认显示，仍不写 URL；已有显式地址不因碰巧等于旧默认而自动替换。用户可主动恢复默认。切换后若显式完整地址与所选协议不符，给出具体错误，不发送探测请求、不自动覆盖。
- 若这些操作造成型号、思考、连接或权限组合不合法，指出相应字段并阻止保存，不自动关能力、换密钥或更换型号。

## 7. 保存约定与示例

### 7.1 Manager 的明确删除覆盖

在现有资源保存 body 增加 `unset?: string[]`，它仅表达“删除此资源的这些顶层可选字段”，不是任意 JSON 路径。保留 value 的局部合并方式，避免丢掉未显示字段；唯一正确恢复路径为先合并显式 value、再执行合法 unset、再完整校验候选。省略不删除，`null`、空字符串和数值相等都不代表删除。

- brains 允许删除其可选顶层字段：url、protocol、key、thinking、rpm、fullUrl、mock、capabilities、hooks、anthropicCompat；contextLimit、model、provider 无默认，不能恢复成缺失。某项结构上可删但删除后分支缺必填值时，完整校验拒绝。
- presets 允许删除 detailRole、workspace、rule、schedule、shadows、roleOverrides；稳定 id、leader、roles 不在删除名单。预设自有字段的清除同步作用到原资源，不把简化编辑用 brain/senseGroup 当原始预设字段写入。
- sense-groups 不接受非空 unset；空组通过 `value: []` 明确保存。文件策略继续以完整原始 policy 保存，删除叶字段通过 policy 的实际缺失表达。
- 同一字段既在 value 又在 unset、重复删除项、未知字段、带点或斜杠的路径、原型字段都返回 invalid_params，整个请求不写入。不存在的合法可选字段允许删除，结果仍为缺省。
- Web 与 AI 的完整资源写入直接省略要恢复的字段，不新增 unset 语法；其现有脱敏值恢复规则保持，不把 `[REDACTED]` 当新密钥。Manager 只读响应继续不返回 key，省略 key 保留原值；主动清除通过 unset，修改通过 value.key，清除后若当前协议必需密钥则拒绝。
- Manager UI 从读取基线与草稿比较生成 unset，仅包含用户主动恢复或清除的顶层可选字段。嵌套能力等通过对应顶层对象整体替换，保留其余叶字段；最后一项覆盖被删时发送 unset capabilities。恢复草稿后取消不发请求。
- 请求指纹包含 unset，仍按 requestId、expectedBaseRevision、预览与同一候选保存；不是另一套保存或兼容开关。同批更新 protocol、插件路由和服务、UI、测试，不保留无法删除覆盖的旧实现。

示例仅说明协议，不是可直接向实际环境发送的操作卡；修订与名称均为示意。

```json
{
  "name": "example-brain",
  "expectedBaseRevision": "revision-a",
  "requestId": "reset-example-1",
  "value": {},
  "unset": ["thinking", "rpm"]
}
```

在既有完整大脑上执行上述编辑，实际候选只删除这两个覆盖；key、contextLimit、能力与其他资源不变。成功响应仍为现有 `SettingsSaveResourceResultSchema`：`saved: true`、kind/name、原始 value、`secrets.keyConfigured`、新 baseRevision、apply 及 save；value 中没有 thinking/rpm/key，界面通过共享默认显示 off 和“不增加本地限流”。save/apply 是否 applied 按真实结果返回，不固定伪造为成功采用。

失败例：`value: {"rpm": 20}` 与 `unset: ["rpm"]` 同时提交，返回现有 HTTP 400 invalid_params，message 为“llm.brain.example-brain.rpm 不能同时赋值和恢复默认”，不进入核心保存。`unset: ["key"]` 导致当前协议缺密钥，同样返回路径化校验错误，磁盘和修订不变。

### 7.2 Web、AI 与只读能力查询

| 场景 | 请求与响应约定 |
| --- | --- |
| Web 只改质量 | 原始 candidate 完整携带当前配置，只改 quality 85→84；继续使用 protocolVersion=2、expectedBaseRevision；preview.impacts 的 paths 只能有 `/files/imageAdaptation/quality`，再用同一 candidate 和 previewToken 保存 |
| 必填缺失 | 缺 `llm.brain.example-brain.contextLimit` 时，preview/save 均按现有 INVALID_PARAMS 包装返回该字段“请填写正整数上下文容量”；不返回成功 token，不写默认推荐，不把 0 显示成容量 |
| AI `config_manage` | get 继续脱敏；putBrain 资源省略可选 thinking 即恢复运行缺省，但必须保留已有 key 的合法引用/受支持脱敏标记并填齐必填容量；patch 仍经统一候选提交，不增加可绕过校验的旧 save |
| 能力成功 | `utils.modelRecommendation` 入参保持 model/provider/protocol 及已有可选 connection，结果保持 facts/recommend/unknown/thinkingLevels/serviceCapabilities；共享纯函数将当前用户覆盖与目录结果合并，例如无 image 覆盖且目录声明 supported 时，显示“支持 · 目录”，不写 input.image |
| 能力未知 | 查询成功而目录未声明 input.image：显示“未确认 · 默认处理”；用户显式 false：显示“不支持 · 手动设置”，不混淆这两种状态 |
| 能力失败或过期 | 保留原始覆盖和草稿，继承部分提示无法读取；不回写 unknown，不拿前一个模型或账号结果作为当前默认；用户手动重试，不自动发模型请求 |
| 字段外部状态改变 | 新配置修订、型号、服务、协议、身份或组件销毁后丢弃旧异步回复；保存冲突保留草稿并提示重读，不自动把旧草稿强盖新配置 |

Web 断线或响应丢失沿用“未确认保存结果，先回读”的现有流程；Manager 保留 save_unconfirmed、saved_readback_failed、saved_revision_changed 等不同结果，不能都显示为“未保存”并自动重发。未登录与权限不足继续按既有 401/403 拒绝，独立账号和会话边界不变。

### 7.3 默认地址查询与已存密钥保护

以下为已确认的约定；查询模型列表会访问远端，连接测试会发送真实模型请求，二者仍仅由用户主动操作触发，不因补默认显示自动执行。本轮实施不执行这两种请求。

1. `utils.models`、`utils.testConnection` 以及 Manager 模型列表请求的 url 改为可省略；省略仅在 fullUrl=false 且 `resolveLlmProviderDefaultUrl` 有结果时有效。后端从相同环境快照解析显式 `$ENV`，再应用协议、基础地址和具体用途的路径规则；显式空白、未解析引用、无默认地址及不合法地址均在传输前拒绝。fullUrl=true 必须提供完整地址，沿用该用途的原样请求语义，不猜 `/models` 路径、不自动把聊天端点改成目录端点。
2. Web 与 Manager 的按钮可用性根据“能否取得有效地址及本分支是否需密钥”计算，不再因原始 url 缺省而要求用户补写默认值。Ollama 原生不要求 key；OpenAI 兼容和 Anthropic 分支维持现有密钥要求。容量等与本次目录查询无关的必填错误不阻止查询，但完整保存仍检查它们。
3. Manager 继续使用已有 `savedBrain` 选择已存密钥，另携带当前 `expectedBaseRevision`。将这两项明确传到核心 `utils.models`，由核心在同一原始配置与环境快照中检查，而不是由插件从 `config.get` 提取密钥再拼请求。请求结构同步到共享 schema、核心类型及所有调用方；移除插件原有仅比较显式 URL 的 `modelKey` 路径，不保留两条复用密钥的实现。
4. 只有请求未提供 key 且给出 savedBrain 时才尝试复用；要求修订未变化、大脑存在、请求的 provider、有效协议、fullUrl 与保存连接相同，且两者按本次用途解析后的完整目标 URL 一致。比较包含路径与查询，不仅是主机或域名。原始省略和显式填写同一个默认地址可以得到同一目标；改变服务、协议、完整地址开关或目标时拒绝复用，提示先保存新连接或明确输入用于新目标的密钥。修订冲突不发请求。
5. 显式 key（包括空字符串）不触发已存密钥兜底；必需分支的空值拒绝。已存引用由后端解析并检查，未配置时返回对应路径错误，不传原始 `$ENV` 当认证值。返回与日志不包含密钥或环境值；地址比较和读取状态不改原始配置。没有 savedBrain 时沿用用户显式提供的密钥规则，不偷偷选择另一颗大脑。
6. 成功仍返回当前 models 结果；请求未发出、远端失败和目录为空按已有错误包装说明，不自动保存、不自动重试、不把获取列表成功当作模型推理通过。Manager 与 Web 丢弃旧修订、旧连接、旧身份或已销毁编辑器的查询回复。

请求示例：已有 OpenAI 大脑省略 url、protocol 和 fullUrl，Manager 发送 `{ "provider": "openai", "savedBrain": "example-brain", "expectedBaseRevision": "revision-a" }`，不携带 key；核心确认原配置也是 OpenAI，双方实际协议均为 Chat Completions、fullUrl=false，再向该协议实际目录地址请求。显式指定不同 url 时，返回字段化的 invalid_params，发送次数为 0；revision 不同则返回 revision_conflict。示例不授权实际联网，也不允许将其他服务的已存密钥借给 OpenAI。

## 8. 终版前的决定、实施顺序与停止条件

### 8.1 已确认单列的外部默认问题

**用户已选择“四项单列处理（推荐）”。** 以下四项的默认与支持范围核实不阻止其余设置方案进入整体确认；它们仍留在文件能力总任务中，不能记为通过或从总任务删除。这是范围决定，不是产品实施或发布授权。其余已确认要求，包括替换旧实现、MCP 默认不启用及显式默认值保留，继续有效。

| 单列项 | 尚缺的依据及本次保留边界 | 继续处理的责任、条件与完成判据 |
| --- | --- | --- |
| Gemini `imageConfig.aspectRatio / imageSize` | 官方 SDK `ImageResponseFormat` 未说明省略结果，也不能代替 REST 字段取值依据；不套旧 ImageConfig 的 1K，不改请求结构、枚举及当前型号限制 | AI 在可取得同一 REST 接口、对应型号的官方原文后，核对请求格式与省略处理，再提交针对性方案及验证条件；未取得前保持未核实 |
| Seedream 非 pro/flash 的 seed | 当前接受该字段；官方 API 与教程未说明其支持及省略行为；不写“随机”或 -1，不删除已有值、不改变当前接受范围；pro/flash 现有禁用规则不变 | AI 补同接口、同型号的官方依据，明确能否使用及省略结果；涉及撤下入口或拒绝已有值时先取得用户决定，不靠填写数值消除支持范围疑问 |
| Images multipart 编辑的 moderation | 项目共用参数会接受该字段，但官方 multipart 编辑说明未列出；不套生成或 JSON 编辑的 auto 默认，不删除已有值、不改当前发送规则；生成与 Responses 的已核实默认仍在本次修复范围 | AI 取得 multipart 编辑的明确官方依据后提出支持、默认及旧值处理方案；在约定验证及必要实际权限具备后再判完成 |
| MCP stdio 的 env | 当前直接传 `cfg.env`；项目使用 `@modelcontextprotocol/sdk ^1.29.0`。[v1 客户端说明](https://ts.sdk.modelcontextprotocol.io/client.html)确认可传 env，但公开 API 索引未给 stdio 缺省说明；不从 v2 推定 v1，不声称完整继承进程环境，不更改当前环境传递或升级依赖 | AI 核实对应 v1 的官方说明及适用版本，明确缺省环境与显式 env 的关系后提交补充方案；不启动 MCP、不读取依赖源码、不回显秘密 |

**本次共用显示与保存边界：**

- 无显式值时显示“未设置 · 默认未核实”；已有显式值照常显示，并可查看尚未核实说明。不把空白、0、auto 或其他型号默认冒充已知结果，不因省略新增必填错误。当前已有的类型、范围和分支校验仍有效，不借单列放宽它们。
- 恢复只删除用户主动恢复的覆盖，随后显示未核实状态；不为首次编辑推算不存在的默认值。未核实的数字项直接输入，不从猜测默认执行加减；没有实际编辑时不写入。
- 文件参数按适配器、实际图片型号及操作说明默认。服务同时支持生成和编辑时，审核参数的默认说明分别表达生成的已知结果和编辑的未核实状态，不新增第二份覆盖值。嵌套 Gemini 字段沿用同一上下文。
- MCP 环境仅说明状态和配置方式，不增加后台查询或泄露变量值；角色未设置 MCP 时“默认不启用”的已确认修复不受 env 单列影响。
- 只访问可用官方资料，不反复请求同一超时入口，不进行真实模型调用或更换接口代替核实。新证据取得后由 AI 从本表恢复；没有自动提醒或调度承诺。若需新的服务调用或其他外部操作，先申请具体授权。

验收时分别记录：其余设置的默认显示与保存修复、四项未核实标识和原值保护、四项真实默认仍未完成。不能把用户同意单列解释为认可厂商默认已查明，Imagen 独立阻塞和其余真实服务验收也不因此解除。

### 8.2 实施与文档归属

本文当前范围及第 8.1 节单列边界已获整体确认及实施授权，按以下依赖连续完成，不逐文件申请继续：

1. 在 protocol 中确定共用默认、纯能力合并、字段校验及 Manager unset；同步调用类型和插件路由。Backend 统一原始读取、候选校验、连接默认解析，保留凭据、引用、版本冲突和采用边界。
2. 更新 Web 各配置卡、数字控件、能力组和模型选择行为；更新 Manager 原始字段显示、容量输入与明确删除覆盖。所有卡仍受统一草稿和现有保存入口控制，不增加自动保存。
3. 同步 AI 配置 schema、get/patch 的提示与工具说明、模板、现有调用方；撤下无作用日志字段的入口和声明，不执行实际数据清理。后续迁移需要单独授权，不能清空环境凑测试。
4. 保留[设置中心](../../frontend/settings.md#大脑连接测试)已获准的大脑八类入口、单一图标 Tab 与仅手动读取工具记录；只接入本方案默认及保存规则，不恢复旧平铺布局、不扩充未实现媒体能力。继续沿用同页控件、纵向滚动与窄窗换行。核对其最新确认与共享文件；如影响本方案行为且无法在现有授权内处理，先协调决定。`BrainCard.vue`、图片字段、能力查询和混合工作区文件逐段修改，不整份覆盖，不并发启停服务。
5. 持久规则按归属落实：[设置中心](../../frontend/settings.md)维护交互，[配置工具层](../../backend/utils/README.md)维护原始/运行边界，[共享协议](../../shared/protocol/websocket.md)维护跨端数据和保存，[模型能力](../../backend/agent/model-capabilities.md)维护继承，[AI 配置管理](../../backend/agent/config-manage.md)引用共用规则。先写正式契约并标实际状态，再实现，不把未确认建议写成已可用。
6. 全部实现与文档同步后先逐项核对第 4—7 节及第 9 节需求，再集中运行相关类型、测试、构建、文档与差异检查。产品实现、离线验证、发布、真实界面分别记录，不做一步完整测一步。
7. 按实际 Backend、Web、protocol、设置插件差异准备同批产物与版本，另取发布及必要迁移授权；不能沿用此前仅换 Web 的授权。发布前核对实际配置是否残留旧日志字段或缺必填输入；有残留则按第 3 节申请定点处理，有缺值则取得用户输入或决定，不自动填推荐值。获准处理与发布后重建真实基准再安排 FILE-SAVE-01；不把设计确认、代码完成或离线检查当作发布许可。

当前设计由当前执行者自查，不是独立评审。自查覆盖显示不写入、首次编辑、显式值保留、条件必填、读取不完整资源、Manager 合并与删除、密钥复用、环境引用、完整候选、错误恢复及已确认单列边界，分别对应第 9 节。模型列表和完整聊天地址的分支按第 7.3、5.4 节实施。交接阅读顺序为第 1、3、4 节理解目标及不变量，第 5—7 节确定各端行为和失败路径，本节确定实施、发布与停止边界，最后按第 9 节核对完成条件；不依赖缺失缓存或口头补充作默认判断。实施、发布与本轮验收已完成；当前只提交相关代码与文档，不新增实际配置写入或服务操作。

若必填规则使现有配置不能保存且需要用户输入或决定、当前修复范围内的来源不成立、发生无法在现有授权内处理的共享文件冲突、需要清理实际数据或新增收费/启停权限，暂停整项实施并报告具体影响；不擅自填目录推荐、放宽校验或用新假设绕过。已确认单列项按第 8.1 节保留未核实，不反复触发暂停；若新事实影响其余已确认行为，再按协作规范返回设计。普通实现错误在已确认范围内自行排查，不重复申请继续。

## 9. 验证要求与适用结果

| 要求 | 验证对象与预期 |
| --- | --- |
| 打开不修改 | 原始配置缺少可选段时打开/切换所有相关页及查询，草稿与基线相同；仅改质量后唯一差异为 `/files/imageAdaptation/quality` |
| 默认显示与首次编辑 | 默认来源和显示单位一致；看门狗 300 → 330 秒，节点树显示基础默认 150、卡牌限制 120；日志缺省已开启项首次点击应关闭，不是再次开启 |
| 恢复与显式状态 | 已有显式 85 保留；恢复默认后字段缺失但显示 85；同对象其他显式值、false、0 和有意义空数组不丢失；编辑后取消不留下对象 |
| 必填与非法输入 | 空白、缺失、无效数字、越界、条件引用不存在均由前后端一致拒绝；不得为测试修改真实配置。获准的离线检查与生产操作分开记录 |
| 继承与迟到结果 | 型号、协议、目录或上级选择变化后显示新的实际结果与来源；旧回复、旧账号结果不串入当前页；未知不显示成不支持 |
| 多入口保存 | Web、Manager、AI 配置入口用相同校验与原始缺省语义；不把 Manager 局部保存中的其他配置补上默认 |
| Manager 恢复默认 | 可选顶层字段的覆盖能真正删除并回读确认；不修改其他字段、密钥及其他资源。必填容量可在 Manager 填写，不能因缺少输入而无法修正配置 |
| 明确删除与凭据 | unset 与赋值冲突、非法字段、重复项均被拒绝；省略 key 保留，明确删除后仍检查所选协议必填；返回和错误不泄露密钥 |
| 分支与只读查询 | 必填配置有错误时仍可打开并定位；能力查询不要求无关资源全部有效；文件服务连接、MCP 和图片参数仅对所选分支检查必要输入 |
| 模型选择和目录推荐 | 查询不改草稿；主动换模型保留显式容量/能力/思考/地址，目录缺省显示更新；仅点击采用推荐才写容量，不因等于旧推荐被覆盖 |
| 文件服务连接 | 默认地址在聊天、理解服务、HTTP 文件服务和可用性显示中一致；完整聊天端点不能错误拼成绘图地址；无凭据时不伪称可用 |
| 默认地址与密钥复用 | 原始省略 URL 仍能显示并在主动查询时使用实际默认；Ollama 不被无关密钥检查阻止；savedBrain 仅在相同修订、服务、协议、开关及完整目标时复用密钥，改路径或目标、环境引用缺失和修订冲突均零传输，返回不含秘密 |
| 外部默认 | MiniMax Base64 与官方 URL 的区别正确显示；宽高模式不被显示默认比例覆盖；OpenAI 自动值、PNG 与有损压缩分支分开；Seedream pro/flash 的 2K 不伪称固定像素，透明分支显示 PNG；Responses 显式 auto 保留；不虚构默认或触发真实请求 |
| 已确认单列边界 | 第 8.1 节四项明确显示未核实，显式值不丢、缺省不补写、不增加必填、不改变当前请求和环境传递规则；其余已核实默认及 MCP 默认不启用正常修复。四项标识和原值保护通过，不等于真实默认核实通过 |
| MCP 默认结果 | 角色、组长、解释角色、会话和委派在未设置时均不启用 MCP；界面和估算与真正工具表一致，不由共用控件暗中扩大默认工具范围；新增服务不自动启用，技能/插件继承不受影响 |
| 实际环境最小复验 | 获准发布后由 AI 重建实际基准，再按[FILE-SAVE-01](verify/manual-final.md#第二批设置保存与双端同步)安排 85 → 84 → 85；每次由 AI 核对唯一变化、实际采用状态及受保护文件。未发布前不交接保存操作 |

**离线验证与生产发布记录（2026-10-22）：**
- 固定发布副本 `/tmp/opencode/settings-defaults-release-20261022/source/` 已完成 14 项全量构建与测试验证（见 `/home/chery/docker/cherynyxus/releases/settings-defaults-20261022/verification/results.json`）：四端类型检查与构建、`settings-tests`（1 文件 8 用例）、`manager-tests`（39 文件 232 用例）、`backend-all-tests`（273 文件 2741 用例通过）、`protocol-tests`（18 文件 625 用例通过）及 `web-tests`（157 文件 934 用例通过）全部退出 0。
- 用户授权后已部署运行镜像 `cherynyxus-runtime:settings-defaults-20261022`（`sha256:1aae491685637939cacdcb357f9cc91eba72c962e607345880f45752503de6d0`）并升级 `cherynyxus-settings-module 2.0.6`，Backend 实例 `c27762ee-1114-4d00-989f-9713b727319d` healthy；一致备份与受保护文件核对通过。
- 实际环境基准（`baseline-file-save-01.json`）确认 `quality = 85`、单字段修改预览唯一影响路径为 `/files/imageAdaptation/quality`，已恢复 `FILE-SAVE-01` 人工保存验收。

用户负责实际显示、键盘和交互判断；AI 不运行浏览器或以程序化页面检查代替人工验收。现有通过项不重测，以上设计与源码核对也不替代产品通过结论。
