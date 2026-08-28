# MCU 精简 API 设计方案（lite profile）

> **文档状态：定稿（T10 终审通过，D1–D19 全部落定，用户已拍板 D13/D14）；P0 implemented；P1 实现中（in_progress，含 turn.delta 可选订阅/分页游标/折叠调优/参考固件），P2 保持 planned**。任何条目落地前必须遵循 doc-first 规范：先更新 [multi-agent-canonical-timeline.md](multi-agent-canonical-timeline.md)（权威；本文的精简投影契约已收录为其 [§3.6 精简投影（lite profile）](multi-agent-canonical-timeline.md)）与 [protocol.md](protocol.md)（方法/字段/通知协议面已由 T11 补录）并标注 `planned/in_progress/implemented`，再写代码。

## 修订记录

| 版本 | 变更 |
|---|---|
| v3.3（执行计时） | 增加真实工具执行边界与可选时间字段、`chat.open.executionStepLimit`、可重建的 `state.executionSteps`；lite 默认 16 步并与 `maxFrameBytes` 联合收缩，活动步骤优先且严格受数量上限约束。 |
| v3.2（P0 落地回写） | P0 全部落地并回写状态：①T15 连接级投影（prepareSessionEvent profile 分支 + interaction.changed/Response 两旁路 + 事件白名单 + 信封最小化 + state lean 集）；②T16 数据面（chat.timeline.node.get 新 RPC、interaction.list serverNow/maxItems≤20+hasMore+payload 截断引用、utils/boundedContent.ts 共用截断工具）；③T20 D13 六错误码注册与抛出（error.code 并列字段，router 透传）。wire 层事实已补录 protocol.md「lite profile 连接级投影」节。P1/P2 维持 planned |
| v3.1（定稿） | T10 终审通过。用户拍板：D13=完整实施 6 码（error.code 并列字段，枚举随 v1 冻结）、D14=完整版本化 v1（未知版本握手期 close 拒绝）。终审三处收尾：子 chat done 锁定纯抑制、pendingInputs content 不对称补设计理由、D3/D8 标注「评审裁定（用户可推翻）」 |
| v3（本版） | 合并 T4 对抗评审（5 前置修正+细则）、T6 设备复核（6 条件）、T7 事实核验（3 修正+2 建议）、captain 最终清单 C/D 组。核心变更：D3 改字段级智能截断；新增子 chat 事件路由语义与 role_reply 抑制；node.get 提前 P0；state 快照 lean 定义；§3.7 有界负载扩展覆盖 RPC 响应帧+默认分页；截断参数全部改字节定义（summary ≤180B）+扣 256B 信封开销；G6 措辞消除缓冲矛盾；新增低档交互降级节；D13 错误码 6 码+error.code 并列载体；未知 v 握手期拒绝；决策点扩至 D1–D19；收口点表述修正（interaction.changed/Response 为旁路）；run.updated/input.updated 体积实测修正 |
| v2 | 吸收 T5 字段级 schema 12 条精化（deadlineAt 倒计时/messageId 预分配/过期 decide 成功响应/interaction.changed 无 seq/两层幂等/run.updated 唯一权威信号等）+ 新增 D13（错误表达）/D14（版本策略） |
| v1 | T3 初版（方案 A/B/C 对比+推荐 A+详细设计） |

> 事实基础：T1 协议审计 + T2 MCU 约束 + T5 字段级 schema + T6 设备复核（实测字节）+ T7 事实核验（源码对照）。本文「红线 F1–F12」指 T1 报告 F 节 12 条架构红线；「原则」指团队核心设计原则（默认只展示用户消息+最终回复；中间过程只报运行状态；节点信息精简到工具名级别；审批节点全量下发；保留按需获取完整详情的能力）。

## 0. 结论速览

**推荐方案 A：连接级 lite profile 投影**——单片机复用现有 WebSocket RPC（binary 帧），连接时声明 `?profile=lite&v=1`，服务端在发送端按白名单事件 + 精简字段集 + 文本截断做**设备投影**；命令面直接复用 `chat.input.submit` / `interaction.approval.decide` / `interaction.question.answer`；历史面复用 `chat.timeline.get` conversation view + `knownRevision` 短路 + generations 窗口，节点投影为 LeanTimelineNode；详情按需拉取（node.get，P0）。

不引入 MQTT/轮询/SSE/独立二进制协议（方案 B/C 见 §2）。核心判断依据：

1. **能力已经存在**：MCU 需要的「状态+命令+收件箱+按需」四类能力全部已在 WS RPC 面，缺的只是「连接级裁剪开关」与「精简节点形态」。
2. **MCU 生态结论**：T2 传输选型确认 WS RPC 二进制帧生态最成熟（esp_websocket_client/libwebsockets），断线恢复原生依赖后端已有的 seq/revision 自愈链路。
3. **架构红线契合**：lite 是同一后端的投影（红线 F3/F10），不是第二套协议。
4. **发送端裁剪有先例**（T7 核验）：`mutedRootsByConnection` + `backgroundControlEvent`（connection.ts）已实现「按连接裁剪事件」——lite 投影机制非凭空发明。但收口现状须准确表述：**chat 路由类事件经 prepareSessionEvent 已统一收口（9 处调用点）；interaction.changed 广播（events.ts 直发 ws.send）与 RPC Response 帧是两个旁路，lite 投影需单独覆盖**（见 §3.1）。

## 1. 设计目标与硬约束

### 1.1 目标（从团队原则导出）

| # | 目标 | 可验证形态 |
|---|---|---|
| G1 | 默认只展示用户消息 + 最终回复 | 逐 token/thinking/staged 全文默认不推；最终回复由 done 精简投影 + timeline patch lean 节点权威下发 |
| G2 | 中间过程只报运行状态（起始时间/时长） | run.updated（唯一权威工作态信号，先于首 token）/ turn.started/cancelled/completed / input.updated / interaction.changed / sense_started(工具名级) |
| G3 | 节点信息精简到核心（工具名级别） | LeanTimelineNode：kind/actor/direction/orderKey/时间戳/摘要 + toolNames[] |
| G4 | 审批节点全量下发供交互 | interrupt 与 question_batch_requested 全量（受 §3.7 有界负载约束）；interaction.list 收件箱兜底 |
| G5 | 保留按需获取完整详情 | chat.timeline.node.get（P0，按需+分段）+ chat.timeline.generation.get（已有）|
| G6 | 设备分档兼容 | 以 ESP32-C3（150–250KB 可用堆）为最小公约数；**接收缓冲 = maxFrameBytes**（C3 默认 4KB，堆内可承受；设备也可声明 maxFrameBytes=2048 换取服务端更狠截断）——与「单事件 ≤4KB」自洽（T6 条件⑤，消除 v1 的 2KB/4KB 矛盾） |

### 1.2 硬约束（T2 输入 + T6 实测校准，服务端保证、不指望客户端防御）

| 约束 | 值 | 说明 |
|---|---|---|
| 状态事件单条 | ≤512B（T6 实测热点事件 144–251B，全部达标） | 信封+类型+关键 id+seq |
| 单事件硬上限 | ≤4KB（= maxFrameBytes） | 超出由服务端截断并附按需拉取引用 |
| 精简会话首刷 | 目标 ≤8–16KB，分页（默认 20 条/页） | T6 实测 20 节点页（summary 60 字符）7.6KB 达标 |
| 审批/提问批次 | ≤2KB；题干 ≤500B、选项标签 ≤60B | 双层约束（D8）：上游软提示、投影层硬保证 |
| RPC 响应帧 | 同受有界约束（T6 条件③） | timeline.get/open 默认分页；interaction.list maxItems≤20+hasMore；详见 §3.7 |
| 详情按需拉取 | 单条 ≤32KB，超出分段 | 用户主动行为 |
| JSON 嵌套深度 | ≤4 层 | T6 实测 lean 形态最深 4 层，满足 |
| 倒计时 | 绝对时间戳（deadlineAt 单一源 + serverNow 校准），设备本地渲染 | 服务端禁止逐秒推送；interrupt 投影剔除 waitTime/createdAt（C5） |
| 应答上行 | ≤200B/条 | {questionId, optionId/selectedLabels, text?} |
| 截断阈值 | 按 **maxFrameBytes − 256B** 计算有效载荷上限（T6 条件④：信封+JSON 结构开销实测 ~256B，done 3.6KB content 全帧 3825B 贴边） | finalMessage 截 3.75KB（4KB 档）、interrupt arguments 同理 |

### 1.3 设备侧持久化规范（C2）

messageId / commandId 必须持久化在设备非易失存储（NVS/littlefs），**发送成功确认前不清除**——掉电重启后同 commandId 重发可安全幂等去重（request_journal 指纹重放）；messageId 是客户端预分配的持久节点 id（与最终 timeline node 复用同 id，树不删重建，T5），须 UUID 级全局唯一。

## 2. 候选方案对比

### 方案 A：连接级 lite profile 投影（WS RPC 复用 + 发送端裁剪）【推荐】

设备用普通 WS 客户端连接（binary 帧格式不变），连接 URL 声明 `?profile=lite&v=1`；服务端在该连接的所有发送点按 lite 白名单与字段投影裁剪。

- **MCU 侧成本**：中等——WS 客户端 + jsmn/ArduinoJson filter 增量解析；帧格式与现有完全一致（0x02 JSON 帧为主，stream 0x01 通道关闭）。
- **服务端成本**：中——见 §3.1 投影插入点（含两个旁路单独覆盖）。
- **实时性**：优（状态推送即时到达）。
- **断线恢复**：原生——重连 `chat.open({rootChatId, knownTimelineRevision})` + `interaction.list`；revision 落后走 timeline.get 全量自愈（红线 F9）；审批遗漏由收件箱兜底（红线 F8）。

### 方案 B：HTTP-only 轮询面（/api/lite/* REST）【备选，本期不做】

新增 REST 端点镜像非流式 handler。T1/T5 证实可行性：chat.input.submit 与 interaction.* 均为非流式 Promise handler 可直接 HTTP 化；HTTP 侧 handleRequest 单函数手写路由，扩展点明确，鉴权可复用。

- **优点**：MCU 实现最简单；无长连接占内存。**缺点**：实时性差（轮询秒级+空转耗电，T2 差评）；双入口维护成本。
- **定位**：P2 备选，仅「只允许出 HTTP/有代理」部署场景。**约束（A-4）**：/api/lite/* 一旦落地**必须复用同一 handler 与投影函数，禁止独立实现**——否则违反 F10 单一权威协议演进。

### 方案 C：独立 MCU 协议（CBOR/protobuf 全新面）【否决】

字节再省 20–40%、解析 CPU 降 3–10 倍，但两端 schema/codegen、第二套协议违背投影分层与 F10；T2 D4 前提（delta 通道 CPU 不足）在 lite 默认关 delta 下不成立。否决存档。

### 对比矩阵

| 维度 | A lite profile | B HTTP 轮询 | C 独立二进制 |
|---|---|---|---|
| MCU 实现难度 | 中 | 低 | 高 |
| RAM（明文） | 15–30KB | 每请求 5–15KB 瞬时 | 10–20KB |
| 实时性 | 优 | 差（秒级） | 优 |
| 断线恢复 | 原生（seq/revision 自愈） | 最简单（无状态） | 需自建 |
| 服务端改动 | 中（集中投影点+2 旁路） | 中（新路由组） | 高（双协议） |
| 协议一致性 | ★★★★★ 单一权威 | ★★★ 双入口 | ★★ 双协议 |
| T2 传输结论契合 | ①★★★★★ | ②★★ | —（未评） |

## 3. 推荐方案 A 详细设计

### 3.1 能力声明与投影插入点（含收口现状，T7 修正）

- **机制**：WS 连接 URL 携带 `?profile=lite&v=1`（v 为 lite 字段集版本号，见 D14——设备固件不可热更，版本化是演进安全的前置条件）。服务端在 `ConnectionState` 记录 profile，本连接全部出站帧经 lite 投影。不新增握手 RPC。
- **未知 v 拒绝（D-b）**：握手期即 `close(4xxx, reason=JSON{supportedVersions:[…]})`，设备在握手层机读判定，不进入消息循环。
- **投影插入点（T7 核验后的准确表述）**：
  1. **主收口点** `prepareSessionEvent`（connection.ts:366，9 处调用点：流式 handler/chat.input.submit ack 与分离执行/launchDetachedResume/spawnEager/broadcastChatNotification/timeline patch/subagent 等）——现状只做订阅匹配+mutedRoots 抑制+信封增强，**无字段裁剪**；lite 需在其内部加 profile 分支（纯新增）。
  2. **旁路一：interaction.changed 广播**（events.ts:17 直发 `ws.send(transport.encode(...))`，不经 prepareSessionEvent，且该通知无 chatId 路由字段）——lite 投影需在此处单独插一层。**P0 落地清单必含此项**。
  3. **旁路二：RPC Response 帧**（serializeMessage 直出，非 Chunk/Notification）——chat.open/timeline.get 等响应的 lean 投影须在 serialize 前处理。**P0 落地清单必含此项**。
- **先例**（T7 核验）：`mutedRootsByConnection`（Map<connectionId, Set<rootChatId>>）+ `backgroundControlEvent`（把 interrupt/accept/done 等压缩为 {approvalId, questionCount}+background:true）已实现「按连接裁剪」——但触发条件是**「无匹配订阅且该 root 已被显式静默」**，非全局抑制；D12 引用时须准确表述。
- **实现注**（R10）：投影在发送前先判 profile 再构建，避免全量+lean 双份序列化。
- **兼容性**：不带 profile 的连接行为不变；lite 是纯加法投影，同一后端同时服务两类前端。

### 3.2 事件面白名单（推送裁剪矩阵）

lite 连接的推送分三类：**原样透传**（已足够小）、**投影精简**（裁字段/截断）、**抑制**（不下发）。

| 事件 | lite 行为 | 投影后形态 / 抑制理由 | 依据 |
|---|---|---|---|
| `run.updated` | 原样+去重 | `{runId, status, at?, startedAt?}`。首个 running 的 `at=startedAt`，终态用 `at` 封口；lite 信封仍会去掉与外层重复的 data.runId。run.updated 是**工作态唯一权威信号**（先于首 token 发出） | G2 状态核心 |
| `input.updated` | **投影精简** | {inputId, state, queueSequence, acceptedAt}（**去 content**——T7 发现 ack 路径携带用户原始输入全文回显，实测 503B+，设备本地已有刚发送的文本，id 对齐即可） | G2；T7 修正③ |
| `interaction.changed` | 原样+加字段 | {interactionId, status, revision, **presetId**}（T7 实测 150B；加 presetId +4B 供设备判断是否需重拉，消多 agent 放大器）。设备侧 500ms 防抖后重拉 interaction.list（C5） | G2 |
| `turn.started` / `turn.cancelled` / `turn.completed` | 原样 | started `{turnId,messageId,createdAt}`；cancelled `{turnId,messageId,reason:'retry_reset',cancelledAt?}`；completed `{turnId,messageId,completedAt?}`。设备收到 cancelled 必须立即丢弃对应 turn.delta 缓冲并以取消态封口计时，不得把半截内容渲染为回复 | G2、本地推导原则 |
| `done` | 投影精简 | `{finalMessage?, canResume, finished?, contextUsage?, completedAt?, **serverNow**}`；去 contextBreakdown/used/total。**负向语义（B-9，逐条）**：① done≠必有 finalMessage（loop 结束在审批 yield 时根本不发 done；结束在 sense 循环时末条可能是 tool 结果）——无 finalMessage 的 done 只更新状态不显回复；② serverNow 每轮免费校准时钟（B-3），时钟误差容忍条款见 §3.9 | G1；§3.4 |
| `error` | 原样 | {message, canResume}。message 含前置 [tracingId] 码（error-conventions 规范），设备**原样显示不得截前缀**（那是用户报障唯一线索）、不得自行生成文案（A-2/F11 全文引用） | F11 |
| `consumed` | 投影精简 | {count, messages:[{id, role, createdAt, **msgId**}]}（去 content；附 msgId 供对齐，D10 裁定） | G1 |
| `interrupt`（审批） | **全量下发**（有界） | arguments 字段级智能截断（§3.7-2）；**投影剔除 waitTime/createdAt**——统一以 deadlineAt 为单一倒计时源（interactions 表 deadline_at；T5 精化：payload 持久侧本就不含这两个字段，防两套公式并存，C5） | G4；D3 |
| `question_batch_requested` | **全量下发**（有界） | 题干+选项全量；双层约束（D8）：上游软提示拆题、投影层硬保证（description 截断 ≤60B 或剔除、批次 ≤2KB、>20 选项分页） | G4 |
| `question_batch_completed` | 原样 | {batchId}（实测 172B） | — |
| `accept` / `rejected` | 投影精简 | `{approvalId, senseName, completedAt?, ok?}`（去 result/reason 全文；`completedAt` 封口对应工具步骤） | G1 |
| `sense_started` | 投影精简 | `{id, senseName, startedAt?}`（去 arguments）。只在 auto 或已批准工具真正调用 handler 前产生，审批等待期不产生 | G3 |
| `role_created` | 投影精简 | {taskId, childChatId, parentChatId, type, wake}（去 prompt/brain/senseGroup） | G2 子任务存在性 |
| `role_reply` | **抑制**（D15-b） | lean 下直接抑制——role_reply 与 timeline return 节点无对齐键（role_reply 无 msgId/nodeId），靠 childChatId 猜配对=变相推断归属擦 F1 边缘；子任务完成态只靠 patch 的 return lean 节点（感知延迟毫秒级可忽略，更符合 G1/G2） | F1；B-2 |
| `role_destroyed` / `child_abandoned` | 原样 | 极小，子任务终态 | — |
| `auto_compacted` | 原样 | 轻量 toast | — |
| `timeline.patch` | 投影精简 | rootPatch.operations 的 upsert node → LeanTimelineNode；edges 不下发（D7：conversation 顺序=orderKey 全序，MCU 无树视图） | G3；§3.3 |
| `replaced` | 抑制 | lean patch 的 upsert 已表达同义 | G1 |
| stream chunk（0x01 通道） | **抑制** | 逐 token 双通道之一（现状同内容双发流量翻倍，T2-C4/T5-#10） | G1 |
| `turn.delta` | 默认抑制 | turnDelta=1 才订阅；单通道替代 0x01 | G1；D4 |
| staged `thinking_end` | 抑制 | thinking 全程不下发 | G1 |
| staged `content_end` | 抑制 | 最终回复由 done.finalMessage + patch 权威下发 | G1、F2 |
| staged `sense_end` | 抑制 | interrupt（smart/manual）已全量；auto 工具靠 sense_started | G2 |
| `loaded` | 抑制 | chat.get 专用，MCU 不走 V1 历史路径 | F12 |

**设备计时交互（本地推导，不增加高频网络帧）**：

- 顶部问题卡以 root `run.updated{status:'running',startedAt}` 启动总计时，以同 run 的终态 `run.updated.at` 或 `done.completedAt` 封口；页面渲染时每秒本地刷新，不要求服务端持续推送 tick。
- 下方每个模型/工具子节点使用 `ExecutionStep.startedAt/completedAt` 独立计时。当前 `running` 节点保持展开并显示工具名或模型轮次；收到终态后冻结耗时、标记结果并收起，随后下一步骤按自己的 `startedAt` 开始。
- 多子 Agent 可同时有多个 `running` 步骤，设备按 `chatId+runId+id` 区分；同一 chat 的多个 auto 工具按真实执行次序切换。审批工具只有批准并真正开始执行后才进入工具计时，审批等待单独由 `deadlineAt` 表达。
- 断线重连不续猜本地计时：顶部总计时以 `chat.open.state.run.startedAt` 或 root `state.runs[]` 中对应项恢复，子步骤以 `state.executionSteps` 重建。终态耗时为 `completedAt-startedAt`，活动耗时为校准后的 `now-startedAt`。

**子 chat 事件路由语义（B-1，三条规则文档化）**：

1. **子 chat 的 done / staged 全部抑制**（终审裁定：二选一锁定为纯抑制，不做纯状态化投影——子完成态已由 timeline patch 的 return lean 节点权威表达，重复通道徒增歧义）——最终回复**只认 rootChatId 维度的 done**（chatId==rootChatId）；子 chat done 携 finished=true（types.ts:2269），若都按「本轮最终回复」处理即错乱（多 agent 必现）。**服务端已实现**（liteProjection：done 事件按 getRootChatId(chatId)===chatId 判定，非 root 整帧抑制；chat 已删除等异常路径按 root 透传，保守不丢数据）。
2. **子 chat 的 turn.started/cancelled/completed** 透传但设备按 `chatId ≠ rootChatId` 折叠为「子任务运行中」状态行；cancelled 同样要求丢弃对应增量缓冲——判定规则固化于此，固件实现者不得猜测。**注意（T26 实测补充）**：子事件信封无 rootChatId（streamMapper 只携 {chatId,runId}），设备判定依据 = 连接期记录的 rootChatId（chat.open 时获得）与事件 chatId 比对。
3. **role_reply 抑制**（见矩阵行）：子任务完成唯一权威 = timeline patch 的 return lean 节点（actor=子 agent、direction=child-to-parent）。
4. **子 chat 的 run.updated 语义限定（T26 补充）**：`run.updated` 的「工作态唯一权威信号」**仅指 chatId==rootChatId 的 run.updated**（驱动设备全局「运行中」指示）；子 chat 的 run.updated（信封 chatId=子）只驱动该子任务状态行的起止，**不得**据此翻转设备全局工作态——子 run 的 running/paused 与主 run 形态完全相同（{runId,status}），不分流会把子 run 结束误判为整体结束。
5. **子 chat 的 error 折叠（T26 补充）**：error 原样透传且不分根/子（F11：message 保持一行中文原样）。设备按 chatId≠rootChatId 把子 error 折叠为该子任务状态行的失败态（消息可点开看 message 原文），**不得**当主回复失败展示全局错误页。子 error 的 canResume 语义同 F4（子的 paused 可由父流程 resume，设备不单独发起）。
6. **游标分道（T26 补充）**：子事件不经订阅匹配（无 subscriptionId/eventSeq 信封），seq 为 per-chat 单调游标——设备「按序应用」的 seq 缓冲必须按 chatId 分道（T2-F2 游标顺序原则的细化），跨 chat 的 seq 不可比较。
7. **accept/rejected（子）**：按 chatId 折叠进子任务状态行；但 **interrupt（子审批）不折叠**——G4 审批全量下发不分根/子，设备必须完整呈现交互。

> staged content_end 抑制后，最终回复两条权威到达路径：done.finalMessage（即时终态）与 timeline.patch upsert（历史权威），同源同 msgId 按 id upsert 去重，不违 F2（lite 无 transient）。

### 3.3 LeanTimelineNode（精简节点形态）

`chat.timeline.get`、`chat.open` 的 rootTimeline、`timeline.patch` 的 upsert node 在 lite 连接统一投影为：

```typescript
interface LeanTimelineNode {
  id: string            // = TimelineNode.id（大多数 = sourceMessageId）
  kind: 'message' | 'return' | 'dispatch' | 'system'   // tool-batch/spawn 归并进所属节点
  actorKind: 'user' | 'agent' | 'system'               // TimelineActor.kind 扁平化
  actorRoleType?: string  // 子 agent 角色名
  direction: 'user-to-agent' | 'agent-to-user' | 'parent-to-child' | 'child-to-parent' | 'internal'
  orderKey: number        // 唯一排序/游标键（F9：只看 orderKey）
  status: 'committed' | 'revoked'
  createdAt: number
  summary: string         // content 服务端截断，**字节定义 ≤180B（≈60 中文字符，恰为 OLED 128×64 四行）**（T6①：中文 UTF-8 3B/字符，v1 按 120 字符=378B 实测单节点 578B 超标 1.7 倍，改为字节定义）
  contentLength: number   // 全文长度，「展开」入口判据
  toolNames?: string[]    // toolCalls 精简为工具名列表（G3）
  termination?: TerminationFact
}
```

- **砍掉**：content/thinking 全文、runtime、toolCalls 全量、edges、parentNodeId/causationId（legacy）、batchId/branch* 等。
- **归属语义完整保留**：actorKind+actorRoleType+direction 三元组（F1：投影只扁平化不改语义）。
- **体积预算（T6 实测校准）**：单节点 **300–500B**（summary 60 字符实测 389B）；20 节点页 7.6KB ≤ 16KB 预算达标。
- edges 不下发（D7）。

### 3.4 done 与 finalMessage 的精简字段集

```typescript
interface DoneLeanData {
  finalMessage?: { msgId: string; content: string; agentChatId?: string }  // content 截断至 maxFrameBytes−256B（T6④）
  canResume?: boolean
  finished?: boolean
  contextUsage?: number   // 单个 0-1 数
  serverNow?: number      // 每轮免费时钟校准（B-3）
}
```

- finalMessage 是 G1「最终回复」第一到达点；超限截断 + contentLength，全文经 node.get（P0 已含）。
- 统一暂停语义不变：error 归 paused、canResume 判定（F4）。

### 3.5 命令面与按需详情

| 能力 | 方法 | 状态 |
|---|---|---|
| 发送用户输入 | `chat.input.submit {chatId, commandId, clientMessageId, messageId, content}` | **已有**，原样复用（立即 ack / 幂等 / root-only 校验内置 / 队列上限 16（超限错误当前 error.code 归 INTERNAL——INPUT_QUEUE_FULL 尚未注册为协议错误码，planned 按 D13 补注册））。messageId=客户端预分配持久节点 id（UUID 级，§1.3）；运行中提交 state=queued 归并活跃 run；分离执行的最终 Response 不发客户端，run 可见性全靠通知流 |
| 审批决定 | `interaction.approval.decide {interactionId, action, expectedRevision, commandId, reason?}` | **已有**，原样复用。**设备规范（C4）**：deadlineAt 已过仍调用**不报错**——返回 {interaction: status='expired'} 成功响应并自动 detached resume；**应答后一律以返回的 interaction.status 终结本地状态机，不从 success 推导**（answer 同理）；恢复路径 claim 后轮询最多 8s，失败转 blocked 可重试 |
| 提问应答 | `interaction.question.answer {interactionId, expectedRevision, commandId, answers}` | **已有**，原样复用（原子整批恰好覆盖 pending 项，F6；selectedLabels 白名单校验+去重；cancelled:true 可逐题取消） |
| 收件箱 | `interaction.list {presetId?, includeActivity?}` | **已有**（默认仅 pending/resolving/blocked、LIMIT 500 静默截断）；lite 投影：**maxItems≤20 + hasMore 游标分页**（C1）+ payload 内审批 arguments 同样字段级截断+引用（R7）+ 响应加 **serverNow** |
| 续接/中止 | `chat.resume` / `chat.abort` | 已有，低频原样复用 |
| 历史 | `chat.timeline.get {rootChatId, view:'conversation', knownRevision?, limit?}` | 已有 + lean 投影 + **默认 limit=20 分页**（T6③） |
| 代际详情 | `chat.timeline.generation.get {rootChatId, generationIndex}` | 已有（体量有界） |
| **单节点详情** | `chat.timeline.node.get {rootChatId, nodeId, sections:[one], offset?, limit?, toolCursor?}` | **已实现**：canonical handler ≤32KB；lite 的成功与失败 RPC 帧都严格 ≤连接 `maxFrameBytes`。content/thinking 按响应 `page.nextOffset`（UTF-16）续拉；toolCalls 按 `{callIndex,field,offset}` 的 `page.nextCursor` 做数组级+字段级分页。正常 correlation 原样保留，异常超长值确定性降级为 `sha256:` 标识；基础 metadata 无法装入时返回有界失败，不伪造成功页。低频用户触发，RATE_LIMITED 码预留。 |

### 3.6 冷启动 hydration、断线重连与重连判定规则

```text
冷启动：
  1. GET /api/config → {wsPort, webPort, transport}（T7：实际另含 sessionToken/senseGroups/presets/default 可选字段，MCU 可忽略但应知晓）
  2. WS 连接 ws://host:port/?profile=lite&v=1[&token=…]（未知 v → 握手期 close(4xxx, reason=JSON{supportedVersions})）
  3. chat.list {scope:'stage'}（lean 目录，无 preview）
  4. chat.open {rootChatId, knownTimelineRevision?, executionStepLimit:16}（原子栅栏：state 快照 lean（§3.2b）+ rootTimeline lean 分页或 timelineUnchanged；响应含 nodeCount 供设备预判分批，R6/D6）
  5. interaction.list（待办全量含 deadlineAt + serverNow；maxItems 分页）
  6. 事件驱动等待

断线重连（含判定规则，B-7）：
  1. 重连（同 profile）→ chat.open {rootChatId, knownTimelineRevision, executionStepLimit:16}
       ├─ timelineUnchanged → 直接进入事件等待
       ├─ revision 落后 → timeline.get 分页全量自愈（F9：缺口靠全量拉取，不猜）后等待
       └─ state 含 activeTurns/runs → 恢复「运行中」UI
  2. interaction.list 重拉收件箱（interaction.changed 无 seq 不进事件流，重连必重拉；弱网设备可退化为 30–60s 定时轮询作保活心跳）
  3. 重连后状态机判定规则：**「错过的事件不重放、不推演」——run 是否已结束的唯一判定 = chat.open state 快照中无该 runId 且 revision 自愈完成**，不依赖重放错过的 done/run.updated
```

- 不使用 chat.get / chat.sync / chat.attach（F12）。
- **多 root 并发订阅建议 ≤1–2**（D19）：每个 root 需独立 state+timeline 缓存，内存翻倍；MCU 场景单 root 为主。
- 审批超时语义照旧：deadlineAt 到点服务端自动 reject/expire（设备离线不卡死）；断连宽限与跨连接 CONFLICT 对 MCU 适用（单连接天然规避）。

**chat.open state 快照的 lean 字段集（B-11/A5，与事件同格式投影）**：

| state 对象 | lean 字段集 |
|---|---|
| pendingInputs | {inputId, messageId, state, queueSequence, acceptedAt, content}（content 计入响应帧预算）。与 §3.2 input.updated 去 content 的不对称是**有意的**：事件是高频路径、ack 时设备本地必有刚发送的文本（去 content 零损失）；state 快照是低频拉取路径、断线/重启重连后设备本地可能已丢失队列中未消费输入的文本（NVram 只存未确认 id），保留 content 才能恢复排队消息的展示 |
| activeTurns | {chatId, turnId, messageId, createdAt}——**不带累计文本**（当前文本按需经 node.get 拉或等最终定稿） |
| run / runs | direct `{runId,state,startedAt?}`；root `[{chatId,runId,state,startedAt?}]`。`startedAt` 从持久 `run.updated` 重建，供重连恢复顶部总计时 |
| questionBatches | {batchId, interactionId}——**不带题干**（详情走收件箱 interaction.list） |
| runningTools | {id, senseName}（工具名级） |
| executionSteps | `{id,runId,chatId,kind,name,status,startedAt,completedAt?}[]`。`kind ∈ model\|tool`，`status ∈ running\|completed\|failed\|rejected\|cancelled`；名称最多 96 UTF-8 bytes。省略 `executionStepLimit` 时 lite 默认 16；活动步骤优先但数组总数严格不超过 limit，活动超限时保留最新项，再由最新终态步骤填满剩余额度。该数组从持久事件重建，是重连恢复计时的权威输入 |
| roles | {taskId, chatId, parentChatId, type, state} |

### 3.7 有界负载与服务端保证（扩展覆盖全部出站帧，T6③）

**范围**：lite 连接的**全部出站帧**——推送事件（Notification/Chunk）**与 RPC 响应帧（Response）**（v1 只管事件是缺口；T6 实测 chat.open 20 节点单帧 7.6–11.4KB、interaction.list 3.6KB+ 直击设备缓冲）。

1. **响应帧分页默认值**：`chat.timeline.get`/`chat.open` rootTimeline **默认 limit=20 分页 + 响应附 nodeCount**（窗口内节点总数，设备预判分批，D6 双做：分页+预告）；**limit 受 maxFrameBytes 自动收缩（T30，P1）**：页大小 = min(请求 limit, maxFrameBytes−512B 可容纳 lean 节点数)，从最新端按 lean 实际字节数装箱、至少 1 节点，hasMore/nextCursor 续拉补齐——chat.open 首页天然有界；`interaction.list` lite 投影 **maxItems≤20 + hasMore**（C1：现状 LIMIT 500 静默截断无 hasMore，必须消除）。
2. **执行步骤双重限制**：`executionStepLimit`（1..500，lite 缺省 16）严格控制计时步骤总数，`maxFrameBytes` 控制最终序列化帧。服务端先取最新活动步骤（不超过 limit）、用最新终态填满数量预算；若全帧仍超预算，依次移除最旧终态步骤和最旧 timeline 节点，但至少保留一个 timeline 节点，并把 `nextCursor` 更新为保留页最小 `orderKey`；如果仍然超预算，继续淘汰最旧活动步骤，至少保留最新活动项供设备显示当前工具。标准 Web/Electron 连接省略该参数时不裁剪当前 run 的步骤窗口。
3. **审批 arguments 字段级智能截断（A1/D3 最终方案）**：投影层**保留全部键名与短字段全文，仅对超长单字段截断并附 `{field, contentLength, contentHash}` 引用**——决策结构完整，仅体量受限。v2 的「头部截断」废弃（头部截断使 write_file/apply_patch 类 {path 短, content 长} 工具的参数被盲批——用户看到文件名看不到内容就被要求批准写入，安全级错误）。收件箱 payload 内 arguments 同策略（R7）。
4. **question batch 双层约束（D8 最终方案）**：上游 ask_user_question **软约束**（超限提示 agent 拆题，不硬拒——硬拒上游会卡死既有合法长题对话，属隐蔽回归）；lite 投影层**硬保证**（批次 ≤2KB、题干 ≤500B、选项标签 ≤60B、description 截断 ≤60B 或剔除（推荐剔除——tooltip 用，低档无 hover）、>20 选项分页）。
5. **finalMessage**：截断至 maxFrameBytes−256B。
6. **turn.delta（可选订阅时）**：delta 本体 ≤512B/帧；offset 保留（丢帧自愈）。
7. **截断先例**（T7 建议，doc-first 论证增强）：项目内已有成熟服务端截断先例——chat.list preview ≤40 字符（db/chat.ts:676）、generations summary 回退截断 500 字符（generations.ts:41）、gitClone stderr 400 字符、media 上传上限；「服务端截断责任」非新发明。
8. **node.get 失败帧**：详情成功页与 `success:false` 响应统一按完整序列化信封精确装箱。错误正文按剩余预算收缩；异常超长/高转义 `id/requestId` 以原值 SHA-256 确定性降级，避免 correlation 本身挤爆最小帧。若 section 的基础 metadata 已超预算，直接返回有界失败，客户端不得推进详情游标。

### 3.8 帧格式与信封

- 帧格式维持现状（binary 0x01/0x02；lite 实际只收 0x02 JSON 帧）。
- **信封最小化**（T2-F5；T6 实测收益：293B → 99B，省 194B/帧）：lite Notification 保留 `type / chatId / runId? / seq`，省略 `requestId / subscriptionId / eventSeq / rootEventSeq / sourceEventSeq`；data.runId 与信封 runId 去重。
- 嵌套 ≤4 层（T6 实测达标）。

### 3.9 低档交互降级与时钟规范（T6⑥ + B-3 条款化）

**低档（无键盘）交互降级**：
- freeText 题显示题干+选项，用 `answer.cancelled=true` 逐题取消或**转交 PC/手机端**应答（answers 结构已支持 cancelled，T5 核验）；
- `chat.list` 的 pendingQuestionCount 供设备识别「有待办可转交」，提示用户到其他前端处理；
- 编码器+按键可走完 选项单选/多选+确认+取消 全流程（T6 闭环判定）。

**时钟与倒计时规范**（B-3 条款化）：
- 倒计时**单一源 = deadlineAt**（interactions 表；interrupt 投影已剔 waitTime/createdAt，C5）；本地渲染 `remaining = deadlineAt − (now + Δ)`，Δ = serverNow 校准偏移；
- serverNow 到达点：interaction.list 响应 + done 投影（每轮至少一次免费校准）；
- **误差容忍（规范性条款）**：视觉容忍 ≤5s；审批 deadline 判定以服务端为准（设备渲染仅为提示，过期 decide 以返回 interaction.status 为准，见 §3.5 C4）。

## 4. 与架构红线（F1–F12）对照表

| 红线 | lite 设计的遵从方式 |
|---|---|
| F1 归属不推断 | LeanTimelineNode 保留 actor/direction 三元组；role_reply 抑制正是为消除「无对齐键猜配对」的推断风险（D15） |
| F2 canonical 权威 | 历史只认 timeline snapshot/patch（lean 投影）；lite 无 transient；最终回复 done+patch 同 id 去重 |
| F3 不用连接 ID 关联 | 信封省 requestId；按 chatId/runId 路由；seq 只做游标 |
| F4 终态语义 | done/error 业务事件 + canResume 判定；input.submit 立即 ack 即 Response；错误归 paused |
| F5 root-only 输入 | chat.input.submit 的 controlRootChatId 校验原样生效（WS schema 剥离 → 子 chat 恒拒，T5/T7 双核验） |
| F6 原子批应答 | interaction.question.answer 整批 + 乐观锁复用；先答后 resume |
| F7 重放分类 | MCU 不走事件重放（收件箱+revision 自愈替代）；重连判定=state 快照+revision，不重放（§3.6） |
| F8 先持久化再推送 | 不改写路径；interactions 表跨重启；设备不依赖服务端内存态 |
| F9 代际/revision | knownRevision 短路、orderKey 全序、缺口全量自愈复用 |
| F10 doc-first | 落地顺序条款化（A-3/D-i）：**T5 schema → protocol.md 补录 interaction.* → lite 文档定稿 → 任何代码**；本文即前置设计 |
| F11 错误规范 | message 含 [tracingId] 前置码原样显示不截、不自行生成文案；机读分支走 error.code 并列字段不进 message（D-a，不违 F11） |
| F12 老接口 | hydration 纯 V2 链路，零依赖 chat.get/sync/attach |

## 5. 落地分期（planned）

| 期 | 内容 | 备注 |
|---|---|---|
| **P0 前置（doc-first，先于任何代码）** | ① T5 schema 定稿 → protocol.md 补录（已由 T11 落盘）d/turn.*/interaction.changed（补全部欠账）；② canonical-timeline.md 增 lean 投影章节；③ 本文按评审裁定定稿 | A-3 顺序条款化 |
| **P0 最小可用**【implemented】 | ① `?profile=lite&v=1` + ConnectionState.profile + 未知 v 握手期 close(4xxx)；② 投影插入：prepareSessionEvent 内 profile 分支 + **interaction.changed 广播旁路** + **Response 帧旁路**（T7 修正：三个插入点缺一不可）；③ 事件白名单过滤（关 0x01 通道/thinking/staged/role_reply/子 chat done；input.updated 去 content）；④ LeanTimelineNode 投影（timeline.get/open/patch/state 快照共用）；⑤ done/consumed/accept/interaction.list 精简字段集 + serverNow；⑥ 有界负载检查覆盖全部出站帧（§3.7 含响应帧分页/maxItems/字段级截断）；⑦ **chat.timeline.node.get（P0 必含，G5 原则级）**；⑧ 错误码最小集（D13 六码，error.code 并列字段） | T6 固件评估：C3 单人 2 周可交付 |
| **P1 体验补全**【in_progress】 | ① turn.delta 可选订阅（turnDelta=1）；② 分页参数细化（before/limit 游标形态统一）；③ role_reply/子 chat 折叠策略实测调优；④ MCU 参考固件（ESP32-C3 档验证 ≤4KB 缓冲解析） | node.get 已入 P0 |
| **P2 可选** | ① HTTP lite 面（方案 B，出现纯 HTTP 部署需求才做，须复用同一 handler 与投影函数）；② 热点事件短键名（D9 维持不做）；③ maxFrameBytes 协商细化 | 全部按需 |

## 6. 待决策点清单（D1–D19，含裁定状态）

| # | 决策点 | 推荐/裁定 | 备选与张力 |
|---|---|---|---|
| D1 | profile 声明位置 | **裁定：URL query**（连接级全覆盖，零新 RPC） | — |
| D2 | finalMessage 超限 | **裁定：maxFrameBytes 协商**（C3 默认 4KB 截断+按需，S3 档可放大） | — |
| D3 | 审批 arguments 超限 | **评审裁定（用户可推翻）：字段级智能截断+{field,contentLength,contentHash} 引用**；头部截断废弃（安全级盲批风险） | T4 否决 v2 方案 |
| D4 | turn.delta 默认 | **裁定：默认关**（G1） | — |
| D5 | summary 截断 | **裁定（T6①）：字节定义 ≤180B（≈60 中文字符），参数化** | v2 的 120 字符定义废弃 |
| D6 | root 分页 | **裁定：双做**——P0 默认 limit=20 分页 + nodeCount 预告（T6③+T4 折中合并） | — |
| D7 | lean 下 edges | **裁定：不下发** | — |
| D8 | question batch 约束 | **评审裁定（用户可推翻）：双层**——上游软提示不硬拒 + 投影层硬保证（description 剔除推荐） | — |
| D9 | 热点短键名 | **裁定：不做**（T6 实测 144–251B 达标、信封省 194B/帧、有效载荷 >60%） | — |
| D10 | consumed/input.updated content | **裁定：均去 content，consumed 附 msgId**（T7 修正③ 扩展至 input.updated） | — |
| D11 | chat.list scope=stage | **裁定：够用**（pendingApproval/pendingQuestionCount 恒带，支撑转交识别） | — |
| D12 | mutedRoots 抑制 | **裁定：沿用**；触发条件写准（T7）：仅「无匹配订阅且该 root 已显式静默」生效，非全局抑制 | — |
| D13 | 错误表达 | **已确认（用户拍板）**：完整实施六码集 INTERACTION_STALE / INTERACTION_ALREADY_RESOLVED / COMMAND_CONFLICT / INPUT_QUEUE_FULL（注：错误类已存在但当前未注册为协议错误码、现归 INTERNAL——protocol.md 版本定位节已注明，落地时按 D13 补注册）/ **PROFILE_VERSION_UNSUPPORTED**（C3）/ **RATE_LIMITED**（C3 预留）；载体=**error.code 并列字段**（不进 message 不违 F11，D-a）；枚举纳入 v1 冻结（D14 联动）；未知 code 设备行为=unknown 处理+原样展示 message | F11 张力已解（message 用户面/code 设备面并存） |
| D14 | 版本策略 | **已确认（用户拍板）**：完整版本化 `?profile=lite&v=1`；v1 字段集冻结只增不改；未知 v 握手期 close(4xxx, reason=JSON{supportedVersions})（D-b）；错误码枚举一并入 v1 冻结 | — |
| D15 | 子 chat 事件处理 | **推荐（T4-a）**：子 done 抑制/纯状态化 + 子 turn 折叠为「子任务运行中」+ 路由规则文档化（已写入 §3.2） | 备选：全部抑制只留 role_created/return |
| D16 | role_reply 处理 | **推荐（T4-b）**：lean 下抑制 role_reply，完成态靠 return lean 节点（已写入 §3.2 矩阵） | 备选：投影附 msgId 保留事件 |
| D17 | state 快照 lean 定义 | **已设计（§3.6 表）**：activeTurns 不带累计文本、questionBatches 不带题干 | — |
| D18 | interaction.changed 加 presetId | **推荐**：加（+4B 消重拉放大，已写入 §3.2） | — |
| D19 | 多 root 并发订阅 | **推荐**：文档建议值 ≤1–2（已写入 §3.6） | — |

> D1–D19 全部落定：D13/D14 用户已拍板（完整实施），D3/D8 为评审裁定（用户可推翻），其余已裁定或设计中直接落定。

## 7. 开放问题与风险（v3 闭环后余留）

1. **大代际窗口首刷**：已由 D6 双做缓解（P0 分页+nodeCount）——余留：实测超大代际下的分页性能验证（P1 固件阶段）。
2. **chat.open state 快照体量**：已由 state lean 定义（§3.6）+响应帧预算覆盖——闭环。
3. **审批等待期设备重启**：收件箱兜底成立；时钟校准误差已条款化（§3.9 ≤5s 视觉容忍、deadline 以服务端为准）——闭环。
4. **interaction.* 未入 protocol.md 欠账**：P0 前置步骤① 专项解决——闭环（时序约束已条款化）。
5. **P0 无 node.get 详情缺口**：node.get 已移入 P0——闭环。
6. ~~设备工作态判定~~：run.updated 唯一权威已写入 §3.2——闭环。
7. ~~两层幂等~~：NVS 持久化规范已写入 §1.3——闭环。
8. **新余留**：lite 投影成为发送热路径的性能验证（R10：先判 profile 再构建，避免双份序列化——实现期验证）。
