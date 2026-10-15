# QQ 插件协议

本文是 NapCat 插件与 Docker 后端之间的消息协议说明。QQ 原始事件格式属于插件内部适配，不直接成为后端业务契约；身份来源和 selfId 拒绝规则以 [NapCat 身份来源与 selfId 验证](./qq-identity.md) 为准。

## 原生入口与实现状态

原生后端通道方法（包括 `qq.identity.bind` 和目录回传 `qq.lookup.result`）由 `cheryNyxus-extension-host` 加载的 `cherynyxus-qq-module`（源目录 `plugins/qq/`）提供，显式安装、启用并由 `cheryNyxus-runtime` 启动后注册；它不是独立服务。未安装或禁用时不提供业务处理器。生命周期与管理接口见[统一宿主](../architecture/ingress-plugins.md)。插件接口为宿主API版本2，QQ/NapCat 传输 protocolVersion 仍为1；版本与身份句柄以宿主owner为准；不提供旧格式迁移。真实发送与媒体的用户验收结论及已知限制统一见[QQ 模块说明](../../../plugins/qq/README.md#当前限制与验证边界)，不能用合成测试推断其他生产场景已验收。

原生入口为 `platform/napcat-plugin/src/index.ts`，NapCat 技术插件 ID固定为 `napcat-plugin-cherynyxus`，用户可见名称为 `NapCat Plugin Chery Nyxus`；其逻辑职责名称为 `cheryNyxus-qq-adapter-napcat`。构建入口为目录内 `pnpm build`，生成 `dist/index.mjs`、`dist/package.json` 和 ZIP 安装包。NapCat 调用 `plugin_init`、`plugin_onmessage`、`plugin_cleanup`；QQ Action 使用官方四参数调用，不另建 OneBot 连接。新的安装、重载和真实发送操作仍需用户授权，不因已有验收而自动操作真实账号。

共享请求/响应类型和运行校验集中于 [`packages/protocol/src/qq.ts`](../../../packages/protocol/src/qq.ts) 的 `QQRequestSchemas`、`QQResponseSchemas` 与 `QQNotificationSchema`；Method、方法类型和后端两份schema表同时引用这些定义。`QQPlugin.start` 通过公共宿主注册受限处理器，router固定使用共享QQ schema，禁止覆盖核心方法。WebSocket在持久RPC缓存之前检查连接权限；QQ业务自身保存输入收件与发送结果，不复用普通聊天RPC重放。`qqbot.config.loaded` 是旧配置通知，不作为能力证据。

以下是已实现的后端与原生消费端契约。插件先验证握手，失败时不提交消息、不发送 QQ，也不退回旧 Chat RPC 或 relay：

- `qq.plugin.hello` 请求 `{protocolVersion:1,pluginVersion,selfId,capabilities}`；响应必须包含 `{protocolVersion:1,backendVersion,selfId,authenticated:true,capabilities}`。必需能力为 `qq.event.submit`、`qq.delivery.result`、`qq.request.recover` 及下文全部标准事件名；后端必须把连接凭据绑定到 selfId。
- `qq.identity.bind` 紧接握手执行，只接受插件从 NapCat 原生 Action 验证得到的 `{selfId,sourceType:'napcat-action',validation:'accepted',verifiedAt,sourceVersion}`。后端持久化首次绑定，重复绑定必须保持同一 selfId；身份变化、过期来源、配置身份不一致或绑定缺失均拒绝业务激活，不回退到 hello、连接自报或旧配置猜测。
- `qq.event.submit` 成功响应为 `{eventId,accepted:boolean}`，只表示收件结论，不等待模型结束。超时或断线后该输入处于未知状态，插件不自动重交。
- `qq.request.recover` 请求 `{selfId}`，响应 `{events:[]}`；events 使用下文通知形状。后端须在返回后恢复该连接的实时通知，并保证回放与实时通知的 eventId 和每目标 seq 顺序一致。插件先补报已经知道的发送结果，再调用恢复；恢复完成前拒绝新输入。
- 每条 QQ 输出通知的 data 至少有 `{eventId,requestId,selfId,conversationType,targetId,seq}`。seq 是每个 selfId/目标跨请求连续递增的发送序号，首条为 1；状态类不发送事件不占该序号。ACK 另有原消息 `messageId` 和 QQ 表情编号 `emojiId`；群聊不发送“收到”文字，尝试添加原消息表情回应，私聊仍发送“收到”，等待/正文/失败另有 `text`，工具另有 `icon`。`qq.reply.completed`、`qq.request.recovered`、`qq.connection.state` 只传状态，不产生 QQ 文本。失败终态使用固定文案 `刚才处理失败了，请稍后再试。`。
- `qq.delivery.result` 请求 `{eventId,requestId,selfId,conversationType,targetId,seq,status,messageIds,sentAt?,activity,terminal}`；status 为 `sent`、`unknown` 或 `failed`，响应必须为 `{eventId,recorded:true}`。`failed` 仅用于明确的原生操作拒绝，超时或发送结果不明使用 `unknown`，不能据此重发动作。activity 仅在 ACK、等待、工具实际发送成功后为 true；最后正文片段、媒体、失败通知及 `completeReply:true` 的原生动作标记 terminal。正文另带 `partIndex`（从 1 开始）及 `totalParts`。已知 sent 仅补报结果，unknown 不能靠重连自动解除。

当前使用项目实际帧编码：请求 `{kind:'request',id,method,params}`，响应以 requestId 关联，通知 `{kind:'notification',type,data}`；支持纯 JSON 和以 0x02 开头的 JSON 通知。本文早期推荐帧仅说明语义，不是当前服务已支持的 API。

群名单、私聊名单、群讨论参与判断、连续输入合并、私聊无需 @、群/私聊上下文和记忆隔离、目标与预设 1:1、请求快照、真实工具调用事件、可设置的等待间隔（默认60秒）与终态清理由后端包和核心执行适配负责；thinking/reasoning仍由核心大脑配置管理。群 @ 唤醒后，普通接话由请求内的 `qq_participation_decide` 判断 reply/wait/end；wait/end 不发送空正文。业务规则和群事实、提醒的实现入口见[QQ 模块](../../../plugins/qq/README.md)。插件只负责字段适配、身份发现、收发及发送结果保存，不持有业务副本。没有人工审批入口的QQ请求不能自动批准需要审批的工具；拒绝调用不发图标。

插件仅从 NapCat 的 `ctx.configPath` 读取 `{backendUrl,backendToken}`；没有默认真实地址或凭据。Manager 登录后生成的 QQ 连接凭据持久化在共享 `.chery/qq-connection-token.json`，运行服务启动时从同一路径读取为 `QQBOT_PLATFORM_TOKEN`；NapCat 设置页仍需在其认证页面填入同一个值。Token 不属于 Manager 登录密钥，重新生成会使旧连接失效。URL 必须为 ws/wss，不含用户名、密码、查询或片段；远程部署应使用 wss。配置修改后需要重载插件，目前不提供业务设置页面或热更新。`plugin_status(ctx)` 仅返回状态、ready 和阻断目标数，不返回凭据、QQ 号或消息。`ctx.dataPath/delivery-journal.json` 保存输入收件状态和发送结果，写入权限 0600；发送之前先写未知状态，防止卸载/崩溃后盲目重发。日志文件损坏时拒绝启动；单类记录达到 10000 时安全拒绝新增，不静默删除旧记录。未知发送没有自动解除入口，需后端与用户确认处理，不能通过删文件强行继续。

NapCat安装包内只有 `index.mjs` 和 `package.json`，运行依赖已包含在入口中；开发工具使用仓库已有依赖。经批准后才可把 ZIP 解压到 NapCat 的 `plugins/napcat-plugin-cherynyxus/`，填写受限通道配置并重载。实际安装、握手和运行地址以部署任务证据为准，不能由本协议推断。QQ后端包是另一个完整目录，不能用此ZIP替代。

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

`qq.event.submit` 至少包含：`eventId`、`selfId`、`conversationType`、`targetId`、`senderId`、`senderName`、`messageId`、`content`、`mentionedBot`、`occurredAt`。群目标使用 `conversationType=group` 和群号；私聊使用 `conversationType=private` 和用户号，私聊不得携带群号。

后端先校验插件连接、`selfId`、发送者和目标，再决定是否接受。插件不得在本地复制群名单、私聊名单、预设、记忆或队列规则。拒绝也要返回稳定错误码，不返回内部诊断。

后端成功接受后发送 `qq.message.ack`，数据含 `eventId`、`requestId`、`state` 和可选 `queuePosition`。插件将群聊确认转换为原消息上的表情回应，私聊仍发送“收到”。群聊表情失败静默跳过，不发送失败提示，不阻断正文发送；确认处理回报允许空 messageIds，activity 在群聊表情操作成功或私聊“收到”发送成功时为 true；群聊表情从用户指定的列表随机选取，并随输出记录持久化，重放不重新选取。正文仍在 Backend 累积到执行结束后按长度拆分发送，不在 NapCat 暂存。

## 后端到插件

标准事件包括：

- `qq.message.ack`：收到或排队确认。
- `qq.waiting`：后端计时产生的等待提示，带策略版本和序号。
- `qq.tool.icon`：一次真实工具调用一个事件，含调用序号、工具名安全标签和 icon；未调用不发送。
- `qq.reply.part`：回复拆分后的一个正文片段，含顺序和总数。
- `qq.reply.video` / `qq.reply.images`：受限媒体文件名，由原生适配器发送并报告结果。
- `qq.reply.action`：原生 mention/reaction/poke/voice/quote 动作；引用与成员身份须来自当前群背景，`completeReply` 表示是否结束正文回复。
- `qq.lookup.request`：查询当前群成员或声音目录，原生适配器通过 `qq.lookup.result` 返回实际目录或明确失败，不生成目录数据。该辅助请求不表示 QQ 消息投递。
- `qq.information.request`：当前可信任务发起的只读查询，data.information 使用固定 kind、count（1–100）与可选资源ID，目标由任务决定。NapCat 通过 `qq.information.result` 返回 `{selfId,lookupId,targetId,success,result}`，result 为最多60000字符的JSON；只接受当前连接和待处理ID对应的目标。不作为发送事件、不记录投递ACK、不重放查询。断开或30秒无结果明确失败。
- `qq.reply.completed`：本次回复结束。
- `qq.request.failed`：失败、取消或超时，使用固定用户可见文案。
- `qq.request.recovered`：断线恢复后重新可观察的请求状态。
- `qq.connection.state`：后端视角的连接状态变化。

### 运行中活动计时器

`qq.tool.icon` 与其他明确的运行中进度消息共享同一个“最近一次实际发送”时间。插件只有在对应 QQ 会话实际发送运行中消息后，才向后端回报该活动；后端据此重置本次请求的 配置的等待间隔（默认 60 秒）倒计时。若连续 配置的等待间隔（默认 60 秒）没有任何运行中消息，后端发送一条预设中的俏皮等待提示，插件发送后回报活动并开始下一个 配置的等待间隔（默认 60 秒）周期。近 配置的等待间隔（默认 60 秒）已经发送工具 icon 或其他运行中消息时，不再发送等待提示。

最终回复、失败、取消或超时等终态事件与运行中进度消息严格分开。终态发送完成后停止并清理计时器；计时器不能因为自己的等待事件无限触发同一周期。请求快照固定本次使用的等待消息列表和策略版本。重连、事件重放和重复发送确认不能再次发送已确认的 icon 或等待消息。

插件按顺序把正文片段发送到正确的 QQ 目标，并把 NapCat 的发送结果回报为 `qq.delivery.result`。发送确认丢失时，插件必须停止该目标的继续发送并报告未知状态，不能自行重发；其他目标继续运行。

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

发送通知先持久化，再交给连接；每目标同时只有一条在途输出。15秒未收到结果停止该目标推进，不能假定已发送；同进程重连可回放同一eventId/seq，由NapCat日志避免重复。进程重启把在途输出标unknown，运行任务标paused，不回放未知输出、不重新调用模型。恢复仍返回暂停状态通知；解除未知发送没有自动入口，需明确核对，不可删日志强行继续。活动倒计时使用后端收到有效sent确认的本机时间，不相信客户端sentAt来推进时间。
