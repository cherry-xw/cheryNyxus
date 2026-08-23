# 工作台 Lite 极简 UI（交互设计）

> **状态：定稿 v0.2（T31 评审通过；W1-W5 契约修正已落盘，5 个遗漏场景与 A-E 定案由本版补全）**。实现状态：**L0 已实现（implemented，T33）；L1 进行中（in_progress，T34）**。目标：在 Web 工作台模式中，基于已实现的 lite profile API（P0+P1）增加一套全新的极简 UI，顶层一键切换，突出展示「极少量流量即可完成完整交互」这一方案核心优势。
> 本文件是**交互设计定稿**，按 doc-first 规范可进入 L0 实现；后续变更须先改本文并标注状态。

## 修订记录

| 版本 | 变更 |
|---|---|
| v0.2（定稿） | T31 评审通过。吸收评审结论：①补 5 个遗漏场景（§4.8 断线重连状态、§4.9 审批超时倒计时、§4.10 错误码六码 UI 分支、§4.3 多选题/自由文本、§4.1 子任务状态行展开）；②A-E 定案写入正文（A turn.delta 默认关+标题栏流式开关=重连切换；B 停止 chat.abort/继续 chat.resume+canResume；C 流量计数只计应用层帧 payload；D 审批截断值+truncations 引用+node.get 全文链路与 id 映射；E 仅当前会话）；③新增 §5.1 与现有 UI 共存的操作约束；④验收标准补断线重连/超时态/错误码分支（§6） |
| v0.1（草案） | 初版交互草案；T31 评审 3 处契约错误（W1-W3）与 W4/W5 措辞已直接修正落盘 |

---

## 1. 目标与定位

**一句话**：在工作台窗口内，用一条 ?profile=lite&v=1&maxFrameBytes=2048 的独立 WS 连接，渲染一套纯文本、极低流量、可完整交互的对话 UI，与现有富 UI（节点树/拓扑/角色编制/消息气泡）互为可切换的「双子界面」。

**核心叙事（展示优势）**：
- **极少量流量**：默认只显示「用户消息 + LLM 最终回复」（lean 投影），中间过程节点只在运行中显示状态行、不传内容；事件全部 ≤512B/帧、单帧 ≤2048B（maxFrameBytes 声明），整个会话的刷新 ≤16KB（分页+nodeCount+hasMore）。
- **操作交互便捷**：极简但完整——发送 / 审批 / 提问 / 停止 / 查看详情，全部可在 lite 视图内完成。
- **按需详情**：中间节点默认折叠为状态行，点按才通过 chat.timeline.node.get 按需拉全文。

**与现有 UI 的关系**：并列不替代。同一工作台窗，标题栏切换「完整视图 ⇄ lite 极简视图」。两视图各自维护独立连接与状态，切换互不干扰。**范围（E 定案）：仅当前会话**——lite 视图不提供会话切换与历史回看（单 root 最简，D19 建议 ≤1-2 root），历史回看从完整视图进入（双子界面分工：lite=当前会话极低流量，完整视图=全功能）；chat.list 已在 hydration 链第一步，未来扩展成本为零。

---

## 2. 切换入口与布局

### 2.1 切换位置（用户已拍板）
- **工作台窗口标题栏**加一个切换钮（图标建议 ⚡，tooltip「切换极简 lite 视图」）。
- 每个工作台窗独立（windowId=presetId 维度），互不影响。
- 切换状态**按窗口持久化**（localStorage，沿用 useWorkbenchWindow 的 per-window key 模式），刷新后保持。
- 不提供全局默认值开关（保持每个窗口独立，符合工作台「每预设一窗」模型）。

### 2.2 lite 视图布局（自上而下）
- 标题栏（原样 + ⚡ 切换钮）
- 状态条（连接状态 / 会话信息 / 流量计数）
- 对话流（可滚动）
  - [用户] 消息 A（用户消息全文）
  - ⟳ 运行中…（中间节点=状态行，无内容）
  - [agent] 最终回复摘要
- 审批/提问行（交互时出现）
- 输入区（单行输入 + 发送，Ctrl+Enter）
- 底栏（分页/更多 / 节点详情抽屉入口）

---

## 3. 数据流（独立 lite 连接）

### 3.1 连接
- 独立 wsClient 实例（WsClient 类加可选 query 参数 + `new WsClient()` 新实例）。**必须独立实例，严禁复用主 UI 单例**（architect 预研）：lite 连接的信封最小化会剥掉 subscriptionId/eventSeq 等字段——主 UI 的 gap-buffer/replay fence 依赖这些字段，复用将破坏其重放协议；且主 UI 会丢失 stream chunk（lite 抑制 0x01 通道），致命。URL：?profile=lite&v=1&maxFrameBytes=2048&token=...（token 沿用现有注入，profile 参数与 token 共存）。
- 握手期未知版本会被服务端 close(4001, {supportedVersions}) → UI 显示「版本不兼容」并禁用切换（提示升级）。
- 心跳沿用现有机制；断线自动重连（复用 ws.ts 的 shouldReconnect/scheduleReconnect）。

### 3.2 会话数据（hydration 链，与固件一致）
1. chat.list({stage}) → 拿到会话摘要。**注意（T31 核验）**：chat.list 响应**不做 lite 投影**（applyLiteResponse 只投影 rootTimeline 形态的响应）——lean 目录依赖 scope:'stage' 省略 preview 的既有行为，非 profile 裁剪。
2. chat.open(rootChatId, {knownTimelineRevision}) → state 快照（lean 集：activeTurns/questionBatches/runningTools/roles）+ rootTimeline（LeanTimelineNode[]，分页 + nodeCount + hasMore）。
3. interaction.list({maxItems: 20}) → 待处理审批/提问（serverNow 校准本地钟）。
4. 实时增量：run.updated（唯一权威工作态信号）+ turn.started/completed + interaction.changed（失效信号）+ timeline.patch（lean upsert）+ turn.delta（若 turnDelta 可选开，默认关）。
5. 每轮免费时钟校准：interaction.list 响应带 serverNow；done 投影也带 serverNow（T28 修复）。

### 3.3 视图数据模型（前端 lean store）
- 维护 leanTimeline: LeanTimelineNode[]（按 orderKey 排序），runningState: {turnId, status, startedAt}，pendingInteractions: InteractionRecord[]。
- 事件 → UI 映射表（见 §4）。

### 3.4 流量预算（前端侧展示/统计）
- 状态条右侧常驻小字显示「本会话流量 ≈ X KB」（C 定案口径：**只统计应用层 WS 帧 payload 字节**，即 ws.onmessage 累计收到的 message 字节总和；**不含 TCP/WS 握手与心跳**——连接管理开销富 UI 同样存在，计入会稀释业务流量对比的公平性）。
- 对照：默认视图（完整 UI）首刷会拉全量 timeline（数 KB~数十 KB）；lite 首刷 ≤16KB 且事件 ≤512B/帧。

---

## 4. 对话流渲染与交互

### 4.1 默认显示（§3.2 契约——只有用户消息 + 最终回复）
- **用户消息**：actorKind='user' 的节点 → 全文显示 summary（用户消息短，通常不截断）。
- **最终回复（T31 修正）**：主 agent 的最终回复权威通道 = **done.finalMessage（即时终态）+ timeline.patch upsert 的 agent-to-user message lean 节点（历史权威）**，同 id upsert 去重（F2）——显示该节点的 summary（≤180B）+「详情 >」按钮。return 节点（direction=child-to-parent）是**子 agent** 回传的投影，用于子任务状态行展开，不是主回复信号。
- **中间节点**（工具/子任务/思考）：**只显示运行状态行**（⟳ 正在… / ✓ 完成），不显示内容；toolNames 可选显示（如 📎 read_file, write_file）。点击状态行 → node.get 按需拉全文（§4.4）。
- **子任务状态行展开（v0.2 补）**：子 agent 按 T26 折叠规则显示为「⟳ 子任务运行中 / ✓ 子任务完成」状态行；点击展开显示该子 agent 的 lean 节点维度——`direction='parent-to-child'`（派发）与 `direction='child-to-parent'`（回传/return）的 lean 节点列表（各自 summary+orderKey），展开数据来自本地 leanTimeline 过滤（不新发请求）；return 节点的「详情 >」走 node.get。子 agent 的 lean 节点不进入主对话流（仅展开区），主回复信号不变（仍为 done.finalMessage + agent-to-user 节点，见上条）。

### 4.2 运行中状态
- run.updated 且 chatId==rootChatId 是唯一权威工作态信号（T26 规则）：running → 状态条显示「运行中…」，对话流显示 ⟳ 行。
- 子 agent 事件（chatId≠rootChatId）只驱动子任务状态行，不污染主视图（T26 折叠规则）。
- turn.delta **默认关闭**（A 定案：G1 原则「默认只展示最终回复」+lite 叙事纯度）；标题栏提供「流式」开关——turnDelta 是**连接级参数**，开关的实现 = 断开当前 lite 连接并以 turnDelta=1 重连（**不能热切换**，切换后重跑 hydration 链）；开关 tooltip/确认文案须预告「切换将断开并重连 lite 连接（约 1-2 秒）」；开启时增量文字按 ≤512B/帧分片渲染（T24）。

### 4.3 审批 / 提问交互（G4 全量下发，交互必须）
- interrupt（审批）：**全量下发**（approvalId/senseName/arguments + supervisionLevel/security?；超长单字段服务端已按 maxFrameBytes 字段级截断并附 truncations:[{field,contentLength,contentHash}]，键名结构与短字段完整）→ 弹出审批行：显示工具名 + 参数键值表（短字段全文、超长字段截断值 +「查看全文」），按钮【批准】【拒绝】。
  - 批准 → interaction.approval.decide({interactionId, action:'accept', expectedRevision, commandId})；拒绝 → action:'reject'（T31 修正：字段为 interactionId+action 枚举，非 approvalId/accept 布尔；interactionId=approvalId 同值）。
  - 结果经 interaction.changed（含 presetId）+ accept/rejected 事件反馈。
  - **id 映射（D 定案补充）**：interrupt 的 interactionId = 该 sense call id = 对应消息节点 toolCalls 中该 toolCall 的 call id——「查看全文」的完整链路为 node.get({rootChatId, nodeId=所属消息节点, sections:['toolCalls']}) 后在 toolCalls 数组内按 call id 定位该项，参数与结果一次拉取覆盖。
- question_batch_requested（提问）：**全量下发**（题干 ≤500B、选项标签 ≤60B）→ 渲染选择题，提交 → interaction.question.answer。
  - **多选题（v0.2 补）**：wire 的 question 字段含 `multiSelect` 标志——单选渲染为 radio 选项组，多选渲染为 checkbox 选项组（提交时 selectedLabels 数组去重，服务端白名单校验）；多选题数上限以服务端校验为准，UI 不自行限制。
  - **自由文本题（v0.2 补）**：无 options 的题渲染为单行/多行文本框（freeText 提交）；Web 端可直接作答（低档 cancelled 降级仅面向 MCU 无键盘设备，Web 不适用）。
- 审批/提问交互结果在 lite 内闭环，不需要切到完整视图。

### 4.4 按需详情（node.get，G5）
- 点击任意节点状态行 / 摘要 → 面板抽屉：chat.timeline.node.get({rootChatId, nodeId, sections:['content','thinking','toolCalls'], offset, limit})。
- 单响应 ≤32KB 分段；超长字段附 contentHash 引用 → 前端展示截断 + 「加载更多」续拉。
- 详情抽屉内可查看 toolCalls（工具名+参数摘要）、thinking（可选开关）。

### 4.5 发送
- 单行输入框 + 发送（Ctrl+Enter / 按钮）。chat.input.submit（命令面：立即 ack + 幂等 commandId + 客户端预分配 messageId）。
- 发送后：本地立即回显用户消息（messageId 预分配）→ input.updated 确认（去 content，设备本地已有文本）→ run.updated 开始运行。
- 输入队列满（INPUT_QUEUE_FULL 码）→ 提示「正在处理上一条，稍候」。

### 4.6 停止 / 继续
- 状态条运行中时显示【停止】→ `chat.abort {chatId, runId?, commandId?}`（T31+architect 预研一致确认：schemas.ts:464 仅 chatId 必填、commandId 幂等、递归停止全部后代、先 rejectApproval 再中断；终态经 timeline.patch+run.updated 下发均在 lite 白名单内，非流式 Promise handler lite 直接可用）。继续 → `chat.resume`（canResume=true 时显示【继续】按钮）。固件未实现停止——Web lite UI 属新增能力，无固件一致性问题。
- run 中断（error / child_abandoned）→ 折叠为子任务失败状态行 + 主视图可继续（canResume）。

### 4.7 分页 / 更多
- 对话流顶部「加载更早」→ chat.timeline.get({rootChatId, before: orderKey, limit})（P1 游标）分页续拉；hasMore 控制按钮显隐。
- 节点数提示（nodeCount）在状态条显示。

### 4.8 断线重连 UI 状态（v0.2 补）
- 断线期间状态条显示「重连中…（第 N 次退避）」而非空白（N=当前重试次数，沿用 ws.ts 的 scheduleReconnect 退避序列）；对话流冻结为最后已知态（不置灰、不清空）。
- 恢复后重跑 hydration 链（§3.2 完整四步：chat.list → chat.open{knownTimelineRevision} → interaction.list → 事件等待）；knownRevision 命中时 chat.open 短路返回 timelineUnchanged，本地 leanTimeline 原样可用。
- 重连判定规则（mcu-lite-api §3.6）：run 是否已结束的唯一判定 = chat.open state 快照中无该 runId 且 revision 自愈完成；**不依赖重放错过的 done/run.updated**。

### 4.9 审批超时倒计时（v0.2 补）
- 审批行显示本地渲染倒计时：`remaining = deadlineAt − (now + Δ)`，Δ = serverNow 校准偏移（interaction.list 与 done 投影每轮免费校准）。
- 到点后 UI 将审批行转为「已超时（服务端自动拒绝）」终态——**以 interaction.changed(status='expired') 为驱动信号**（服务端 deadlineAt 到点自动 reject/expire，见 protocol.md interactions 生命周期）；本地倒计时仅提示性渲染，过期 decide 的真实结果以响应 interaction.status 为准（C4：到期仍调用返回成功响应 status=expired）。
- 超时态审批行不可再操作（按钮置灰），可展开查看参数详情（node.get 链路不变）。

### 4.10 错误码 UI 分支（v0.2 补，D13 六码）
- **INTERACTION_STALE**（revision 过期）→ 审批/提问行显示「内容已变化」+【刷新后重试】按钮（重拉 interaction.list 取新 revision）。
- **INTERACTION_ALREADY_RESOLVED**（已处理）→ 该交互行置灰转「已在其他视图处理」态（以最新 interaction.status 为准渲染终态）。
- **COMMAND_CONFLICT**（commandId 冲突/处理中）→ 幂等提示「该操作正在处理中」，不自动重发（commandId 语义=同一命令同参数重发安全、不同参数报冲突；UI 确认用户意图后换新 commandId）。
- **INPUT_QUEUE_FULL** → 发送区提示「正在处理上一条，稍候」（§4.5 已有）。
- **RATE_LIMITED** → node.get 详情抽屉提示「请求过于频繁，请稍后再试」（节流预留位，触发时 UI 退避后允许手动重试）。
- **PROFILE_VERSION_UNSUPPORTED** → 握手期 close(4001) 的 UI 升级提示（§3.1 已有「版本不兼容并禁用切换」；此码作为 RPC 错误出现时同文案兜底）。
- 所有错误 message 为中文用户面文案（F11），UI 原样展示 message + 按 code 走上述分支，不得截断 [tracingId] 前缀。

---

## 5. 与现有实现的复用/差异

| 项 | 现有完整 UI | lite 极简 UI |
|---|---|---|
| 连接 | 现有 wsClient（?token=） | 独立 lite wsClient（?profile=lite&v=1&maxFrameBytes=2048&token=） |
| 数据源 | 全量 rootTimeline + 富事件 | lean 投影事件 + 按需 node.get |
| 消息渲染 | MessageBubble/MessageBranchTree/角色编制 | 纯文本行 + 状态行 + 摘要 |
| 审批 | PendingOperationsPanel | 内联审批行（参数精简展示） |
| 输入 | AgentComposer（富文本/媒体/斜杠菜单） | 单行输入 + 发送 |
| 状态 | ContextUsageBar/角色 tags | 精简状态条 + 流量计数 |

### 5.1 与现有 UI 共存的操作约束（v0.2 新增，T31 前端可行性结论）

- **同一会话同一时刻只在一个视图内操作**：lite 与完整视图共享同一后端会话，跨连接 CONFLICT 语义（同 chat 活跃时另一连接的操作会被拒）——切换视图即停止旧视图的交互（旧视图保持只读渲染，新视图获得操作权）；两视图同时显示但不同时接收用户操作。
- **commandId 幂等兜底**：若用户在两视图快速交叉操作（切换竞态），同一 commandId + 相同参数的重发会被 request_journal 幂等层去重（返回首次结果）；不同参数的同 commandId 报 COMMAND_CONFLICT（§4.10 分支处理）。UI 生成 commandId 时按「一次用户意图一个 id」分配，天然规避冲突。
- **双连接心跳**：lite+完整视图两连接各自 ping 属设计内场景（服务端 ConnectionState 独立），流量计数只计业务帧不受影响（C 定案口径）；断线重连各自独立（§4.8）。

**前端渲染模块建议**（实现阶段）：
- web/src/features/lite/（新目录）：LiteView.vue（主视图）、LiteStore（lean 数据流）、LiteEventMapper（事件→UI 映射）、DetailDrawer.vue（node.get 详情）、TrafficMeter（流量统计）。
- 复用：ws.ts 扩展 profile 支持、connection.ts 的 token 注入、http.ts。

---

## 6. 验收标准（v0.2 按 T31 结论微调）

1. 工作台窗口标题栏切换钮存在，切换 lite/完整视图即时生效、per-window 持久化。
2. lite 视图走独立 lite WS 连接（可在服务端日志确认 profile=lite 连接建立）。
3. 默认只显示用户消息 + 最终回复；中间节点只显示状态行；点击状态行 node.get 拉全文；子任务状态行可展开 parent-to-child/child-to-parent lean 节点（§4.1）。
4. 审批（interrupt）/ 提问（question_batch）在 lite 内可完整交互并闭环；多选题（multiSelect）与自由文本题正确渲染（§4.3）。
5. 发送走 chat.input.submit，输入后立即回显 + run.updated 反映运行态。
6. 首刷 ≤16KB（分页生效）；事件帧 ≤2048B（有界负载）；状态条流量计数可见且只计应用层帧 payload（§3.4）。
7. 断线自动重连：重连期间显示「重连中…（第 N 次退避）」非空白；恢复后重跑 hydration 链 + knownTimelineRevision 短路 + serverNow 校准（§4.8）。
8. **审批超时态**：倒计时本地渲染正确；到点转「已超时（服务端自动拒绝）」且由 interaction.changed(status=expired) 驱动；超时行按钮置灰（§4.9）。
9. **错误码六码分支**：STALE 刷新重试 / ALREADY_RESOLVED 置灰 / CONFLICT 幂等提示 / QUEUE_FULL 稍候 / RATE_LIMITED 节流退避 / VERSION_UNSUPPORTED 升级提示——各码 UI 分支按 §4.10 触发验证。
10. 现有完整 UI 不受影响（两视图独立连接，切换互不干扰；同一会话同一时刻单视图操作，§5.1）。
11. type-check + 前端构建通过；服务端 lite 测试不回归。

---

## 7. 待确认项定案记录（T31 评审 A-E，v0.2 全部落定）

- **A. turn.delta**：✅ 默认关 + 标题栏「流式」开关（连接级参数，切换=重连不能热切换）——见 §4.2。
- **B. 停止/继续**：✅ chat.abort {chatId, runId?, commandId?}（commandId 幂等，重连重发安全）/ chat.resume（canResume 驱动按钮显隐）——见 §4.6。
- **C. 流量计数**：✅ 只计应用层 WS 帧 payload 字节（不含握手/心跳），状态条右侧常驻小字——见 §3.4。
- **D. 审批参数展示**：✅ 行内截断值 + truncations 引用；「查看全文」走 node.get sections:['toolCalls']（id 映射：interactionId = sense call id = toolCall id，见 §4.3）。
- **E. 多会话/历史**：✅ 仅当前会话（单 root 最简），历史回看从完整视图切换——见 §1。

---

## 8. 分期（doc-first 标注）

| 阶段 | 内容 | 依赖 |
|---|---|---|
| L0 连接与骨架 | ws.ts profile 支持 + 标题栏切换 + LiteView 骨架 + 状态条 | P0/P1 API 已就绪；**implemented（T33）** |
| L1 对话流 | lean 数据流 + 用户消息/最终回复/状态行渲染 + 分页 | L0；**in_progress（T34）** |
| L2 交互闭环 | 发送(chat.input.submit) + 审批(decide) + 提问(answer) + 停止 | L1 |
| L3 按需详情 | node.get 详情抽屉 + 截断续拉 | L1 |
| L4 收尾 | 流量计数 + 断线重连自愈 + 验收 | L0-L3 |

> 本设计文档为 v0.2 定稿（T31 评审通过），按 doc-first 规范可进入 L0 实现；后续变更先改本文并补修订记录。
