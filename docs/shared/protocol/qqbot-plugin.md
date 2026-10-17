# QQ 插件协议

本文是 NapCat 插件与 Docker 后端之间的消息协议说明。QQ 原始事件格式属于插件内部适配，不直接成为后端业务契约；身份来源和 selfId 拒绝规则以 [NapCat 身份来源与 selfId 验证](./qq-identity.md) 为准。

## 原生入口与实现状态

原生后端通道方法（包括 `qq.identity.bind` 和目录回传 `qq.lookup.result`）由 `cheryNyxus-extension-host` 加载的 `cherynyxus-qq-module`（源目录 `plugins/qq/`）提供，显式安装、启用并由 `cheryNyxus-runtime` 启动后注册；它不是独立服务。未安装或禁用时不提供业务处理器。生命周期与管理接口见[统一宿主](../architecture/ingress-plugins.md)。插件接口为宿主API版本2，QQ/NapCat 传输 protocolVersion 仍为1；版本与身份句柄以宿主owner为准；不提供旧格式迁移。真实发送与媒体的用户验收结论及已知限制统一见[QQ 模块说明](../../../plugins/qq/README.md#当前限制与验证边界)，不能用合成测试推断其他生产场景已验收。

原生入口为 `platform/napcat-plugin/src/index.ts`，NapCat 技术插件 ID固定为 `napcat-plugin-cherynyxus`，用户可见名称为 `NapCat Plugin Chery Nyxus`；其逻辑职责名称为 `cheryNyxus-qq-adapter-napcat`。构建入口为目录内 `pnpm build`，生成 `dist/index.mjs`、`dist/package.json` 和 ZIP 安装包。NapCat 调用 `plugin_init`、`plugin_onmessage`、`plugin_cleanup`；QQ Action 使用官方四参数调用，不另建 OneBot 连接。新的安装、重载和真实发送操作仍需用户授权，不因已有验收而自动操作真实账号。

共享请求/响应类型和运行校验集中于 [`packages/protocol/src/qq.ts`](../../../packages/protocol/src/qq.ts) 的 `QQRequestSchemas`、`QQResponseSchemas` 与 `QQNotificationSchema`；Method、方法类型和后端两份schema表同时引用这些定义。`QQPlugin.start` 通过公共宿主注册受限处理器，router固定使用共享QQ schema，禁止覆盖核心方法。WebSocket在持久RPC缓存之前检查连接权限；QQ业务自身保存输入收件与发送结果，不复用普通聊天RPC重放。`qqbot.config.loaded` 是旧配置通知，不作为能力证据。

以下是已实现的后端与原生消费端契约。插件先验证握手，失败时不提交消息、不发送 QQ，也不退回旧 Chat RPC 或 relay：

- `qq.plugin.hello` 请求 `{protocolVersion:1,pluginVersion,selfId,capabilities}`；响应必须包含 `{protocolVersion:1,backendVersion,selfId,authenticated:true,capabilities}`。必需能力为 `qq.event.submit`、`qq.delivery.result`、`qq.request.recover` 及下文全部标准事件名；后端必须把连接凭据绑定到 selfId。
- `qq.identity.bind` 紧接握手执行，只接受插件从 NapCat 原生 Action 验证得到的 `{selfId,sourceType:'napcat-action',validation:'accepted',verifiedAt,sourceVersion}`。后端持久化首次绑定，重复绑定必须保持同一 selfId；身份变化、过期来源、配置身份不一致或绑定缺失均拒绝业务激活，不回退到 hello、连接自报或旧配置猜测。
- 群内明确 @ 允许空正文，原文保持为空，不补造用户话语；发送者、@ 标志、引用和近期讨论共同提供意图，只有影响执行且无法确定时才澄清。无 @、无正文且无附件的空输入仍拒绝。
- `qq.event.submit` 成功响应为 `{eventId,accepted:boolean}`，只表示收件结论，不等待模型结束。超时或断线后该输入处于未知状态，插件不自动重交。
- `qq.request.recover` 请求 `{selfId}`，响应 `{events:[]}`；events 使用下文通知形状。后端须在返回后恢复该连接的实时通知，并保证回放与实时通知的 eventId 和每目标 seq 顺序一致。插件先补报已经知道的发送结果，再调用恢复；恢复完成前拒绝新输入。
- 每条 QQ 输出通知的 data 至少有 `{eventId,requestId,selfId,conversationType,targetId,seq}`。seq 是每个 selfId/目标跨请求连续递增的发送序号，首条为 1；状态类不发送事件不占该序号。ACK 另有原消息 `messageId` 和 QQ 表情编号 `emojiId`；群聊不发送“收到”文字，尝试添加原消息表情回应，私聊仍发送“收到”，等待/正文/失败另有 `text`，工具另有 `icon`。`qq.reply.completed`、`qq.request.recovered`、`qq.connection.state` 只传状态，不产生 QQ 文本。失败终态使用固定文案 `刚才处理失败了，请稍后再试。`。
- `qq.delivery.result` 请求 `{eventId,requestId,selfId,conversationType,targetId,seq,status,messageIds,sentAt?,activity,terminal}`；status 为 `sent`、`unknown` 或 `failed`，响应必须为 `{eventId,recorded:true}`。`failed` 仅用于明确的原生操作拒绝，超时或发送结果不明使用 `unknown`，不能据此重发动作。activity 仅在 ACK、等待、工具实际发送成功后为 true；最后正文片段、媒体、失败通知及 `completeReply:true` 的原生动作标记 terminal。正文另带 `partIndex`（从 1 开始）及 `totalParts`。已知 sent 仅补报结果，unknown 不能靠重连自动解除。

当前使用项目实际帧编码：请求 `{kind:'request',id,method,params}`，响应以 requestId 关联，通知 `{kind:'notification',type,data}`；支持纯 JSON 和以 0x02 开头的 JSON 通知。本文早期推荐帧仅说明语义，不是当前服务已支持的 API。

原生传输接口使用 `connect`、`onMessage`、`request` 和 `close`。连接断开时取消在途调用并通知适配器；重连后重新握手、绑定身份、补报已知回执，然后恢复通知。同一目标按序执行通知，其他目标不受其未知发送影响。本端原生调用不加固定截止，NapCat自身超时如实报告且不自动重发；停止后丢弃排队发送和迟到结果。输入提交前持久化未知记录，断线或重启不自动重复提交。

群名单、私聊名单、群讨论参与判断、连续输入合并、私聊无需 @、群/私聊上下文和记忆隔离、目标与预设 1:1、请求快照、真实工具调用事件、可设置的反馈间隔（默认180秒）与终态清理由后端包和核心执行适配负责；thinking/reasoning仍由核心大脑配置管理。群 @ 唤醒后，普通接话由请求内的 `qq_participation_decide` 判断 reply/wait/end；wait/end 不发送空正文。业务规则和群事实、提醒的实现入口见[QQ 模块](../../../plugins/qq/README.md)。插件只负责字段适配、身份发现、收发及发送结果保存，不持有业务副本。没有人工审批入口的QQ请求不能自动批准需要审批的工具；拒绝调用不发图标。

插件仅从 NapCat 的 `ctx.configPath` 读取 `{backendUrl,backendToken}`；没有默认真实地址或凭据。Manager 登录后生成的 QQ 连接凭据持久化在共享 `.chery/qq-connection-token.json`，运行服务启动时从同一路径读取为 `QQBOT_PLATFORM_TOKEN`；NapCat 设置页仍需在其认证页面填入同一个值。Token 不属于 Manager 登录密钥，重新生成会使旧连接失效。URL 必须为 ws/wss，不含用户名、密码、查询或片段；远程部署应使用 wss。配置修改后需要重载插件，目前不提供业务设置页面或热更新。`plugin_status(ctx)` 仅返回状态、ready 和阻断目标数，不返回凭据、QQ 号或消息。`ctx.dataPath/delivery-journal.json` 保存输入收件状态和发送结果，写入权限 0600；发送之前先写未知状态，防止卸载/崩溃后盲目重发。日志文件损坏时拒绝启动；单类记录达到 10000 时安全拒绝新增，不静默删除旧记录。未知发送没有自动解除入口，需后端与用户确认处理，不能通过删文件强行继续。

NapCat安装包内只有 `index.mjs` 和 `package.json`，运行依赖已包含在入口中；开发工具使用仓库已有依赖。经批准后才可把 ZIP 解压到 NapCat 的 `plugins/napcat-plugin-cherynyxus/`，填写受限通道配置并重载。实际安装、握手和运行地址以部署任务证据为准，不能由本协议推断。QQ后端包是另一个完整目录，不能用此ZIP替代。

### NapCat 插件安装与加载检查

插件启用与加载许可是两项不同检查，不能仅修改 JSON 后反复重启：

- **启用配置**：NapCat 的 `config/plugins.json` 使用技术包 ID 作为键，例如 `{"napcat-plugin-cherynyxus":true}`。本机持久路径为 `/home/chery/docker/napcatqq/napcat/config/plugins.json`，挂载到 `/app/napcat/config/plugins.json`。`true` 只表示请求启用，不保证加载器接受该插件。
- **加载许可**：NapCat 上游 `packages/napcat-onebot/network/plugin/loader.ts` 的 `OFFICIAL_PLUGIN_IDS` 决定哪些插件可被扫描。`scanDirectoryPlugin` 在读取启用状态之前执行 `getRejectReason`；不在名单中的插件会记录 `not in official plugin whitelist`，且不会出现在插件列表。该版本的名单位于源码，不是 `plugins.json` 中的另一个开关。升级 NapCat 时须重新核对官方实现，不假定所有版本相同。
- **本机现有插件**：部署使用 `napcat-cherynyxus:region-fork`，源码位于 `/home/chery/dev/NapCatQQ` 的 `local/deployment-region` 分支。`/home/chery/docker/napcatqq/custom/build-info.txt` 记录额外允许的 ID 为 `napcat-plugin-cherynyxus`；同目录 `Dockerfile` 将定制 NapCat 产物复制进镜像。此许可不自动覆盖其他插件 ID，也不代表任意诊断插件可加载。定制产物不是推荐的源码修改入口；后续调整应依据对应版本的官方源码与获准构建流程，不直接修改打包代码。

安装、升级或临时诊断前按以下顺序检查：

1. 核对插件包 `package.json.name`、部署目录、`plugins.json` 启用键和加载许可使用相同 ID；保留其他插件、登录、凭据及业务配置。
2. 先检查所用镜像及其构建记录是否允许该 ID。仅缺启用项时修改对应 JSON；遇到白名单拒绝时停止重启尝试，不关闭全部限制、不冒用已有插件 ID。
3. 新增允许 ID 或修改现有业务插件须明确操作范围；只有文件或包摘要确有变化才构建、安装。不要为一个未获许可的临时插件直接重建在线镜像。
4. 获准加载后，通过认证的 `GET /api/Plugin/List` 确认目标为 `active`，并检查其初始化日志。文件存在、JSON 为 `true` 或容器运行均不能代替加载成功。
5. 涉及 QQ 查询的诊断另设单次执行、明确目标、最小字段与不自动重试限制；插件初始化只注册入口，不自动查询、发送消息或触发恢复。测试结束卸载诊断插件，移除仅本测试新增的启用项，并核对原业务插件及 QQ 在线状态。

验证入口：[原生插件适配测试](../../../apps/backend/test/service/qqPluginWire.test.ts)和[共享协议契约测试](../../../apps/backend/test/service/qqProtocolContract.test.ts)。在仓库根目录执行 `pnpm --dir platform/napcat-plugin typecheck && pnpm --dir platform/napcat-plugin build && pnpm qq-ingress:test`。测试使用回环随机端口、合成 NapCat Action、共享 schema 和离线 mock provider，不连接真实 NapCat、QQ 或模型；安装包的独立检查仍以获准部署任务为准。

## 传输

使用 WebSocket RPC。连接建立后依次执行 `hello`、认证、版本与能力握手；双方发送 `ping`/`pong` 保活。请求有唯一 `requestId`，事件有唯一 `eventId`，插件重连后不得重复提交已经确认的 `eventId`。后端必须为重复事件返回同一处理结论或明确的已处理状态。

推荐帧形状：

```json
{"kind":"request","requestId":"...","method":"qq.event.submit","params":{}}
{"kind":"response","requestId":"...","success":true,"data":{}}
{"kind":"notification","event":"qq.message.ack","data":{}}
```

具体编码可采用项目现有 WebSocket transport，但业务字段必须保持本文语义。未知事件和未知后端事件不能让插件崩溃；插件对未知工具 icon 使用安全回退图标。

## 插件到后端

文件消息使用有序 `parts`（文字段或附件序号），`attachments` 保留类型、名称、MIME 和 HTTPS 下载地址；缺少可用下载地址时保留明确的不可读取说明，不读取任意本地路径。只有附件的输入也可提交。后端仅在渠道名单与预设验证通过后下载、保存和加入模型输入；下载拒绝私网地址，不把第三方 URL 直接当成已保存资产。

通用文件结果使用 `qq.reply.file`，携带固定 `assetId`、`assetVersionId`、名称、MIME、字节数和 SHA-256。原生适配器通过已认证 `qq.file.read` 按 256 KiB 读取，只能读取该条待发送通知对应的资产；核对长度和摘要后交给 NapCat 原生发送。图片/音频/视频发送原生消息段，其他文件使用原生上传。临时文件不是公开链接，完成或失败后删除；不支持或不确定发送时按既有回执规则报告，不能把本地保存成功当作 QQ 发送成功。`qq.reply.file` 仅在 `completeReply:true` 时为末条发送。

文件上传回执中的 `fileIds` 与原生消息回执的 `messageIds` 分开；文件 ID 不要求是数字，不能塞入消息 ID。原生上传明确返回成功但没有文件 ID 时可回空 `fileIds`，同时以 `fileUploaded:true` 记录上传确认；没有明确成功响应且无标识时仍为未知。依据 [群文件](https://napcat.apifox.cn/226658753e0.md)和[私聊文件](https://napcat.apifox.cn/226658883e0.md)接口，上传返回的 `file_id` 可为空。

文件传输在读取每段、调用原生发送前和记录回执前核对适配器当前连接；停止或重新建立连接后，旧传输不得继续发送或记录新回执。已经交给原生接口的发送不能保证撤回，重启后按未知发送处理，不自动重发。

只有文件、没有正文的成功结果由最后一条待发文件通知承担 `completeReply:true`，不追加“没有内容”之类相反说明；只有文件确认发送后才完成请求。

`qq.event.submit` 至少包含：`eventId`、`selfId`、`conversationType`、`targetId`、`senderId`、`senderName`、`messageId`、`content`、`mentionedBot`、`occurredAt`。群目标使用 `conversationType=group` 和群号；私聊使用 `conversationType=private` 和用户号，私聊不得携带群号。

后端先校验插件连接、`selfId`、发送者和目标，再决定是否接受。插件不得在本地复制群名单、私聊名单、预设、记忆或队列规则。拒绝也要返回稳定错误码，不返回内部诊断。

后端成功接受后发送 `qq.message.ack`，数据含 `eventId`、`requestId`、`state` 和可选 `queuePosition`。插件将群聊确认转换为原消息上的表情回应，私聊仍发送“收到”。群聊表情失败静默跳过，不发送失败提示，不阻断正文发送；确认处理回报允许空 messageIds，activity 在群聊表情操作成功或私聊“收到”发送成功时为 true；群聊表情从用户指定的列表随机选取，并随输出记录持久化，重放不重新选取。公开正文可随周期反馈发送；执行结束后只对尚未确认送达的剩余正文拆分发送，不在 NapCat 暂存。

群聊确认的 1.5–5 秒延迟保存为发送记录的 `notBefore`，先登记再等待，重启继续使用同一条记录与原顺序。离线通信测试须覆盖这段实际等待时间，不用小于正常最大延迟的等待上限判断失败。

## 对话和声音设置

QQ 配置使用 voiceMode=off/requested/auto 和 voiceDefaultCharacter，默认仅用户要求时使用。模型语音工具不接受 character，由业务端固定声音；原生通知仍带 character 供 NapCat 发送。每轮最多一次语音，纯情绪反馈不授权语音或戳人。实际动作状态与声音随近期上下文提供，不能把排队当发送。

受保护的模块 GET /api/modules/qq/voices?groupId=群号 只查询当前允许群的声音目录，返回 items[{id,name,card?}]；通过现有 qq.lookup.request/result 使用 get_ai_characters，不发送QQ消息、不保存伪造列表。离线、超时或群未允许时明确失败。Manager仅展示查询和选择，不成为实时消息依赖。

## 后端到插件

标准事件包括：

- `qq.message.ack`：收到或排队确认。
- `qq.waiting`：后端计时产生的等待提示，带策略版本和序号。
- `qq.tool.icon`：一次真实工具调用一个事件，含调用序号、工具名安全标签和 icon；未调用不发送。
- `qq.reply.part`：回复拆分后的一个正文片段，含顺序和总数。
- `qq.reply.video` / `qq.reply.images`：受限媒体文件名；通用下载视频携带`mediaScope=group-群号/user-QQ号`，必须与本条目标匹配，映射共享媒体根的`scoped/<mediaScope>/`目录，由原生适配器发送并报告结果；当 `qq.reply.video` 携带 `uploadAsFile:true`（例如视频体积超过气泡安全上限 200 MB 但在 1 GiB 硬限制内）时，原生适配器切换为 `upload_group_file` / `upload_private_file` 上传并以 `fileUploaded:true` 回报确认。
- `qq.reply.action`：原生 mention/reaction/poke/voice/quote 动作；引用与成员身份须来自当前群背景，`completeReply` 表示是否结束正文回复。
- `qq.lookup.request`：查询当前群成员或声音目录，原生适配器通过 `qq.lookup.result` 返回实际目录或明确失败，不生成目录数据。该辅助请求不表示 QQ 消息投递。
- `qq.information.request`：当前可信任务发起的只读查询，data.information 使用固定 kind、count（1–100）与可选资源ID，目标由任务决定。NapCat 通过 `qq.information.result` 返回 `{selfId,lookupId,targetId,success,result}`，result 为最多60000字符的JSON；只接受当前连接和待处理ID对应的目标。不作为发送事件、不记录投递ACK、不重放查询。断开或30秒无结果明确失败。
- `qq.reply.completed`：本次回复结束。
- `qq.request.failed`：失败、取消或超时，使用固定用户可见文案。
- `qq.request.recovered`：断线恢复后重新可观察的请求状态。
- `qq.connection.state`：后端视角的连接状态变化。

### 持续运行与周期反馈

任务不设置固定运行截止时间；仅真实执行完成、明确执行失败或用户取消改变执行状态。QQ 断线、反馈发送失败和单次原生发送超时不能结束仍在运行的任务。服务停止仍属于实际执行中断，必须明确记录，不宣称无条件恢复任意外部程序。

反馈默认每180秒（3分钟）一个周期，按请求快照的 `waitIntervalSeconds` 执行。周期内按事件顺序收集真实工具图标及已有公开正文，多轮输出合并为同一条qq.waiting；没有正文仅发送图标，无新内容则发送等待提示。只携带公开正文，不包含思考、参数或工具结果。已确认送达的正文不在最终回复中重复，未确认不记为已送达。同一图标可在不同周期再次出现。周期总是重新安排，不能等待上一条反馈的成功回执才能继续。未投递的旧周期反馈合并为最新一条，避免断线堆积后刷屏；执行结束清除尚未投递的反馈。

执行遵循「主动停止只有一种情况：用户发起要求」。模型请求、内部文本处理、信息/目录/撤回查询、媒体下载与转码、外部文件导入与文件服务操作均不设置主动时钟截止；内外层工具循环不按固定轮数主动结束；子任务不以长时间无输出判定失败。已授权执行的身份与传输连接分离：断线不撤销既有执行授权，插件禁用或权限撤销仍必须生效；新输入与发送继续验证当前连接。本端不以固定秒数把在途发送改成失败或未知；原生调用返回什么就记录什么，迟到回执仍有效。未知结果不自动重放，用户明确重试是新的发送授权。反馈与正文分开调度，反馈异常不改写任务执行状态。计算已完成而发送未确认时，保留计算完成与独立的未知投递记录，不将计算改成失败，也不永久占用下一请求的执行位置。工具执行外层与内部脚本不创建主动时钟截止，但并发排队、输出大小、文件大小上限（如150MiB）、权限与各外部服务的明确失败仍分别生效。

### 反馈投递与执行状态

反馈周期由任务状态驱动，不依赖成功回执重新启动；等待提示和工具图标使用相同周期。

执行完成、真实失败或取消后停止周期反馈；QQ发送结果独立记录。请求快照固定等待策略。

正文按顺序发送，反馈走独立通道。未知结果不自动重发，不建立群级永久锁；明确重试创建新事件。

## 状态和快照

后端为每次接受的消息生成 `requestSnapshot`，至少记录目标、预设、大脑、感官组、运行策略版本和创建时间。后续保存不能改变该快照。工具事件顺序以实际后端调用顺序为准，不允许插件根据文本猜测工具调用。

请求终态只有 `completed`、`failed`、`cancelled`、`timeout` 或 `paused`。ACK、等待事件和工具 icon 都不是终态。恢复时插件先报告连接，再读取后端请求状态，不盲目重复提交。

## 版本和能力

握手必须协商协议主版本、插件版本、后端版本和能力集合。能力不匹配时后端拒绝处理消息并给出稳定错误；升级不允许静默降级到旧的配置或权限语义。连接凭据只用于插件通道，不能用于管理页面登录。

## 日志和隐私

协议日志只能记录脱敏的 requestId、eventId、目标类型、状态和时间。禁止记录 Key、密码、Cookie、Session、OIDC token、完整消息正文、昵称或个人记忆。故障详情在服务端诊断日志中也必须按同一规则脱敏。

## 自动验证

使用 wire/mock 插件和合成目标验证：握手、重复 eventId、身份拒绝、群/私聊字段边界、ACK、等待计时、工具 icon 数量与顺序、回复拆分、失败/恢复、发送确认丢失和重连。自动验证不能连接真实 QQ 或真实模型。

后端正式入口为 `pnpm qq-ingress:build && pnpm qq-ingress:test`；[`qqPluginWire.test.ts`](../../../apps/backend/test/service/qqPluginWire.test.ts) 连接真实 WebSocket 和原生 `Adapter/BackendWire`，注入合成 QQ Action，并通过核心离线 mock provider 验证 QQ 与普通 Web 输入；[`qqProtocolContract.test.ts`](../../../apps/backend/test/service/qqProtocolContract.test.ts) 验证共享 DTO 对握手、身份、恢复、事件和 delivery 边界的拒绝规则；[`qqReviewBoundaries.test.ts`](../../../apps/backend/test/service/qqReviewBoundaries.test.ts) 验证记忆隔离和宿主启停状态；[`qqRequest.test.ts`](../../../apps/backend/test/agent/middleware/qqRequest.test.ts) 验证请求内工具、记忆隔离与审批拒绝。

发送通知先持久化，再交给连接；正文与进度各保留一个在途调用，不以固定时间结束等待。进程重启仍将未知投递保留为unknown、实际中断执行标paused，不盲目重放。
