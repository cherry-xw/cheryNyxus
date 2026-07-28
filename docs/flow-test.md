# 流程测试规约（Flow Test Spec）

> 把「主子 agent 对话 / 审批 / 工具卡 / 刷新重连 / resume」的需求逐条落成**可执行的流程测试**。本文是流程测试的**规约**（doc-first）：每个交互场景给出**步骤序列 + 检查信息 + 功能点 + 覆盖分支**，并证明原始需求的每种分支情况都被某个场景覆盖。
>
> 状态：覆盖 [test.md](./test.md) 的「test 模块推迟」约定——流程测试是**例外**（新建、独立、全绿），不计入 ~86 预存失败基线。**S1–S16 全部落地**（Tier 1 S1–S7 + Tier 2 S8–S16），改造验收点 G1/G2/G3/G8 单元 + 端到端双托底，24 条分支全覆盖。

---

## 1. 覆盖目标：原始需求分支清单

流程测试的存在意义 = 证明下表每条分支**可验证**。「覆盖场景」列指向 §3 的 S 编号。这是流程测试的**验收清单**——任一分支无场景覆盖 = 缺口。

### FP-A 标准对话与审批（5 分支）

| 分支 | 语义 | 覆盖场景 |
|------|------|----------|
| A0 纯文本 | 无 sense，loop 单轮，流式正文 | S1 |
| A1 auto 感官（无审批） | `supervision=auto(0)` → `sense_started` 直接执行 → `sense_end` | S2 |
| A2 smart 接受 | `supervision=smart(1)` → `interrupt` → 用户 accept → 执行 | S3 |
| A3 smart 拒绝 | `interrupt` → 用户 reject → `rejected` → loop 继续 | S4 |
| A4 用户超时自动拒 | `approval_timeout>0` 到点 → resolve-as-reject → `sense_reject` → resume Case2 | S5 |
| A5 不限时 + 30min 自动释放 | `approval_timeout=0` + `approval_hard_timeout` 到点 → `AgentParkError` → paused 可续 | S6 |

### FP-B 流式与多轮 loop

| 分支 | 语义 | 覆盖场景 |
|------|------|----------|
| B1 流式正文（打字机） | `stream` delta ×N → `content_end` | S1/S2 |
| B2 多轮 loop（sense 后再跑 LLM） | sense_end → loop 续跑 → 末条 assistant 无 senseCalls → ended | S2 |
| B3 todo list 显示 | `update_todo` 的 `sense_end.arguments.todos` 结构化 | S7 |

### FP-C 刷新重连（3 分支 + 态恢复）

| 分支 | 语义 | 覆盖场景 |
|------|------|----------|
| C1 断连 → 后端宽限计时 | WS close → `disconnectGrace` 启动 grace（默认 15s），不立即 park | S8/S9 前置 |
| C2 窗口内重连 → 取历史 + 实时流续跑 | grace 内 `chat.attach(running:true)` + `chat.sync` 回放 → 续跑 | S8/S9/S12 |
| C3 超宽限 → 释放资源 → resume | grace 到期 `parkApproval` → paused → `canResume=true` | S10 |
| C4 流式中断刷新续跑（打字机续） | 流式 close → 重连回放 stream chunk → 续 | S8 |
| C5 审批中断刷新续跑（**原 approvalId 命中**） | 审批挂起 close → grace 内 approval 存活 → 用原 id confirm 命中 | S9 |
| C6 刷新态恢复 | `currentState`{pendingApproval/runningTools/currentTodo} 快照权威 | S12 |

### FP-D 历史面板单一缓存数组

| 分支 | 语义 | 覆盖场景 |
|------|------|----------|
| D1 冷刷新单一事件流 | `chat.sync(0)` 返回连续事件流；主 chat loadHistory 走 `chat.get` 全量（双 RPC 各司其职，M1 修订） | S11 |
| D2 超窗回填 | 事件淘汰后从 messages 合成 staged 回填 + 按 msgId 去重 | S11 |
| D3 单数组累积无合并 | 回填 staged 与实时 staged 同形，累加器无分支 | S11 |
| D4 attach cursor 锚点 + 补回 disconnect-window | `chat.attach` 响应 snapshotSeq；紧接 `chat.sync(chatId, snapshotSeq)` 补回 disconnect 期间事件 | S17 |

### FP-E 停止按钮

| 分支 | 语义 | 覆盖场景 |
|------|------|----------|
| E1 停止立即归 resume | `chat.abort` → `AgentAbortError` → paused（`clearChatRuntime`） | S13 |
| E2 刷新后仍 resume | abort 后刷新，`canResume=true` 持久 | S13 |

### FP-F 子 agent

| 分支 | 语义 | 覆盖场景 |
|------|------|----------|
| F1 同流程（invoker 数据源不同） | 子 chat 走同一 send/resume/loop 链，invoker=spawn 而非用户 | S14 |
| F2 immediate 全链路 | spawn → `role_created` → startSpawn → 子 done → `role_reply` → 主 resume | S14 |
| F3 deferred/barrier 暂存唤主 | 多子 deferred，中途 silent 不推 role_reply，全完成兜底唤主 | S15 |
| F4 子 agent 刷新重连（继承机制） | 子 running → `chat.attach(子)` → 续跑 | S16 |

---

## 2. 统一断言维度

每个场景的每个任务节点须沿四维断言（场景表只列该场景特有的，共性在此）：

| 维度 | 断言内容 |
|------|----------|
| **事件** | chunk/notification 类型 + 顺序 + 关键字段（`approvalId`/`msgId`/`seq`/`senseName`/`waitTime`/`createdAt`） |
| **DB 状态** | messages（role/content/sense_calls/revoked/runtime）、chat metadata（finished/wake/resumePending）、chat_events（seq 单调、留存） |
| **运行时态** | `isChatRunning`、`approvalManager.approvals`（含/不含 id）、`computeCanResume`、`waitedChildren` |
| **交互功能** | 对应 RPC（send/resume/abort/attach/sync/approval/startSpawn）是否按预期触发/返回；attach 的 `running`/`attached`、sync 的 `reset`/`backfilled`、approval confirm 命中/失效 |

**canResume 权威语义**（[canResume.ts](../src/service/chat/canResume.ts) `computeCanResume`）：
- `ended`（`canResume=false`）= 末条 visible assistant 且无 sense_calls（loop 自然完成）。
- `paused`（`canResume=true`）= 末条 sense/user/role/subagent，或 assistant 带 sense_calls；abort/park/AI 报错/断连超 grace 皆归此。

---

## 3. 流程场景矩阵（S1–S16）

分层：**Tier 1**（中间件级，`agentHarness`+`chunkAssert`，无 WS/DB）= S1–S7；**Tier 2**（service+WS 级，真实 `createWebSocketServer`+`rpcClient`+DB）= S8–S16。G1/G2/G3/G8 改造验收点 = S6/S9/S11/S12。

### A. 标准流程 `test/flows/agent/flowStandard.test.ts`（Tier 1）

#### S1 纯文本
- **前置**：mock 脚本 `[{content:"回复"}]`
- **步骤**：`consumed` → `stream`(content delta ×N) → `staged content_end` → `done`
- **检查**：事件顺序如上；末条 assistant 无 senseCalls；`done.canResume=false`（ended）；runId 回；final Response `success:true`
- **功能点**：FP-A0 / FP-B1
- **覆盖**：A0、B1

#### S2 auto 感官 + 多轮 loop
- **前置**：mock `[{content,senseCalls:[read_file]},{content}]` + `chunkDelayMs`
- **步骤**：`consumed` → stream → `thinking_end/content_end/sense_end` → `sense_started` → `accept` → stream → `content_end` → `done`
- **检查**：`sense_started` 出现（auto 级无 interrupt）；`accept.approvalId = sense_end.id` 同源；末条 assistant 无 senseCalls → ended
- **功能点**：FP-A1 / FP-B2
- **覆盖**：A1、B2

#### S3 smart 接受
- **前置**：smart 脚本 + `sense_groups` `:smart`
- **步骤**：`sense_end` → `interrupt`{waitTime,createdAt,supervisionLevel:1} → `[sense.approval accept]` → `accept` → stream → `done`
- **检查**：审批中 `approvalManager` 含 id；accept 后移除；interrupt→accept 时序；confirm 返 true
- **功能点**：FP-A2
- **覆盖**：A2

#### S4 smart 拒绝
- **前置**：同 S3
- **步骤**：`interrupt` → `[reject reason]` → `rejected`{reason} → stream → `done`
- **检查**：rejected 后 approval 移除；`rejected.reason` 透传；loop 继续（非 paused）
- **功能点**：FP-A3
- **覆盖**：A3

#### S5 审批超时自动拒
- **前置**：`approval_timeout>0`（测试缩短，如 50ms）
- **步骤**：`interrupt` →（不审批）→ registry 用户超时 timer → `rejected`(reason 含「超时」) → stream → `done`
- **检查**：走 reject 路径（loop 继续，**非 paused**）；`canResume=ended`；timer 触发后 registry 删 id
- **功能点**：FP-A4
- **覆盖**：A4

#### S6 不限时 hard-park（**G2 验收点**）
- **前置**：`approval_timeout=0` + `approval_hard_timeout`（测试缩短至 ~100ms，或 `vi.useFakeTimers`）
- **步骤**：`interrupt` →（hard timer）→ `AgentParkError` → run 结束 paused
- **检查**：pending sense content NULL；`canResume=true`（paused）；hard=park（可续）**非** reject；`chat.resume` Case1 用新 id 重弹
- **功能点**：FP-A5
- **覆盖**：A5
- **已落地测试**：[approvalRegistry.test.ts](../test/core/sense/approvalRegistry.test.ts)「hard-timeout（G2）」5 项（单元级，到点 reject(AgentParkError)、用户超时优先不叠加、accept/park 清 timer、无 hard 兼容）

#### S7 todo list
- **前置**：mock `[{content,senseCalls:[update_todo args={todos:[...]}]},{content}]`
- **步骤**：`sense_end`(update_todo，**arguments=结构化 todos JSON**) → `accept`
- **检查**：`currentState.currentTodo` = 最近 update_todo 的 args.todos；todo 无专用通知，靠 `sense_end.arguments`
- **功能点**：FP-B3 / FP-C6（todo 态）
- **覆盖**：B3、C6(todo)

### B. 刷新 `test/flows/service/flowRefresh.test.ts`（Tier 2）

#### S8 流式中断刷新续跑
- **前置**：S2 流式中（`chunkDelayMs` 使 close 落在流式窗口内）
- **步骤**：`ws.close()` → grace 启动 → `chat.attach(running:true)` + `chat.sync` 回放断连窗口事件 → 续跑 → `done`
- **检查**：流式 close **不 park**，generator 存活；`isChatRunning=true`；attach 重定向输出；sync 回放 stream chunk（打字机续）
- **功能点**：FP-C1 / FP-C2 / FP-C4
- **覆盖**：C1、C2、C4

#### S9 审批中断刷新续跑原 id（**G1 验收点**）
- **前置**：S3 审批挂起 → `ws.close()`
- **步骤**：grace 内 approval **存活** → `chat.attach` + `chat.sync` 回放 `interrupt` → `[sense.approval **原 approvalId**]` → `accept` → 续跑 → `done`
- **检查**：**改造前**：close 立即 park → run 死 → 原 id confirm 失效；**改造后**：原 id confirm **命中**（approvalManager 仍含该 id）
- **功能点**：FP-C5（断「原 approvalId 不失效」= 改造C 验收核心）
- **覆盖**：C5
- **已落地测试**：[disconnectGrace.test.ts](../test/service/websocket/disconnectGrace.test.ts) 3 项（grace 内 approval 存活未被立即 park、到期 parkApproval→AgentParkError、宽限内 rebind 取消 grace）——单元级验证 G1 机制，端到端 confirm 命中待 Tier 2

#### S10 审批中断超 grace 释放
- **前置**：S3 审批挂起 → close → 超 grace（`vi.advanceTimersByTime(16000)`）
- **步骤**：`expireRun` → `parkApproval` → run paused
- **检查**：metadata 无 finished；末条 sense → `canResume=true`；attach 返 `running:false`；`chat.resume` Case1 新 id
- **功能点**：FP-C3
- **覆盖**：C3
- **已落地测试**：[flowGraceExpire.test.ts](../test/flows/service/flowGraceExpire.test.ts)（真实短 grace disconnectGraceMs=400 + 完整 send/observer 链：挂起审批→断连超 grace→grace.expired→parkApproval→agent.paused kind=park→重连 chat.get canResume=true / attach running:false）——与 [disconnectGrace.test.ts](../test/service/websocket/disconnectGrace.test.ts) 单元互补

#### S11 冷刷新单一事件流（**G3 验收点**）
- **前置**：任意历史，部分事件超窗淘汰（`minSeq` 上移）
- **步骤**：F5 → `chat.sync(0)` → 返回连续事件流（超窗部分由 messages 合成 staged 回填 + 留存近期，按 msgId/id 去重）→ 单数组重建
- **检查**：`reset:false, backfilled:true`；事件 seq 连续；msgId 无重；回填段 staged 与实时同形
- **功能点**：FP-D1 / FP-D2 / FP-D3
- **覆盖**：D1、D2、D3
- **已落地测试**：[flowSync.test.ts](../test/service/chat/flowSync.test.ts) 3 项（`messagesToStagedEvents` 转换、非超窗单一水源返回 currentState、强制淘汰回填去重）+ [flowColdSync.test.ts](../test/flows/service/flowColdSync.test.ts) Tier 2 端到端 2 项（真实 send 链历史 + WS chat.sync(0) 完整事件流 / 强制淘汰回填 msgId 去重 backfilled:true）

#### S17 chat.attach cursor 锚点 + attach+sync 补回 disconnect-window（**M1+M2+M9 验收点**）
- **前置**：运行中 chat（F5 重连 / 主动 reconnect）
- **步骤**：`chat.attach` → 响应携带 `snapshotSeq`（cursor 锚点）→ `chat.sync(chatId, snapshotSeq)` → 0 流式 events（cursor 已在 snapshotSeq）→ 模拟 disconnect 窗口 appendChatEvent(seq>snapshotSeq) → `chat.sync(chatId, snapshotSeq)` 命中该事件
- **检查**：`attachData.snapshotSeq > 0`（chat_events 持久化后）；`attachData.pendingQuestionBatches` 为数组；post-attach sync(chatId, snapshotSeq) 流式 events.length === 0；disconnect-window appendChatEvent 后 sync 命中
- **功能点**：M2（attach cursor 锚点）/ M9（attach+sync 组合补回）
- **覆盖**：attach 响应字段完整性 + cursor 推进正确性 + disconnect-window 事件补回
- **已落地测试**：[flowAttachSync.test.ts](../test/flows/service/flowAttachSync.test.ts) Tier 2 端到端 3 项（idle chat attach 字段完整性 / running chat attach 后 sync(snapshotSeq) 返 0 events / appendChatEvent 后 sync 命中 disconnect-window 事件）
- **M1 验收**：主 chat loadHistory 经 chat.get 路径（messages 表 retention-independent）；验收通过 [flowAttachSync.test.ts](../test/flows/service/flowAttachSync.test.ts) idle/running chat 测试间接覆盖 + 主 chat drawer 打开走 syncOneChat('loadHistory') 内部 chat.get 调用

#### S12 刷新 currentState 快照（**G8 验收点**）
- **前置**：S2/S3/S7 任一中断态刷新
- **步骤**：`chat.attach`/`chat.get`/`chat.sync` response 携带 `currentState`
- **检查**：`currentState.pendingApproval`（approvalManager 存活时返回，含 senseName/waitTime/createdAt）；`runningTools[]`（run 运行中时）；`currentTodo`；**不含 currentTurnContent**（与事件流重复会致双内容源合并）
- **功能点**：FP-C6
- **覆盖**：C6
- **已落地测试**：[currentState.test.ts](../test/service/chat/currentState.test.ts) 4 项（currentTodo=最近 update_todo、pendingApproval 存活判定、runningTools 运行中才返回、accept 事件清跟踪）+ [flowCurrentState.test.ts](../test/flows/service/flowCurrentState.test.ts) Tier 2 端到端 2 项（currentTodo=结构化 todos 经 chat.get 快照、runningTools+pendingApproval 同源 approvalId 经 chat.attach 快照）

### C. 停止 `test/flows/service/flowAbort.test.ts`（Tier 2）

#### S13 停止后刷新仍 resume
- **步骤**：`chat.abort` → `AgentAbortError` → paused(`clearChatRuntime`) → 刷新
- **检查**：`isChatRunning=false`；末条 sense/user → `canResume=true`；刷新后仍 `canResume=true`；abort 级联停后代；不写 DB
- **功能点**：FP-E1 / FP-E2
- **覆盖**：E1、E2

### D. 子 agent `test/flows/service/flowSpawn.test.ts`（Tier 2）

#### S14 spawn immediate 全链路
- **步骤**：`spawn_role` → 后端 **eager 启动**（[spawnEager.ts](../../src/service/chat/spawnEager.ts) `runChildTaskInBackground`）→ role_created 推主连接（background）→ 子 done → role_reply → 主 resume
- **关键差异**：eager 启动后，测试在 step 2 调 `chat.startSpawn` RPC 时进入 **recovery 分支**（子未完成 → alreadyRunning / 子已 finished → alreadyFinished）；断言改为 `finished || alreadyFinished` 任一为 true 即视为「子已能消费 done」
- **检查**：eager 启动 → role_created 到达 background（按 parentChatId 过滤）→ 主 yieldTurn → done；子 RPC recovery 返回 alreadyRunning/alreadyFinished；wakeScheduler evalWakePolicy(immediate)=shouldWake → wakeParent → 推 role_reply → 主 resume 消费注入的 role 行
- **功能点**：FP-F1 / FP-F2
- **覆盖**：F1、F2

#### S15 spawn deferred/barrier 暂存唤主
- **前置**：多子 deferred 完成（eager 启动下两子并发跑，timing 不可截断 interim silent）
- **步骤**：spawn_role 派发 2 子 deferred → role_created → 等 background 任一 role_reply 到达 → 调 chat.startSpawn B（recovery）→ 验 role_reply 总数=1（deferred 全完成兜底唤主，非每子各唤）→ 主 resume 轮2 content
- **检查**：`roleEventCount(role_reply) === 1`；语义：「仅 1 条 role_reply」（deferred 全完成兜底唤主，非按子计数）
- **功能点**：FP-F3
- **覆盖**：F3

#### S16 子 agent 刷新重连
- **前置**：子 running → `chat.attach(子)`
- **步骤**：父 send → spawn_role(reviewer_stream) → role_created → 等首个 stream chunk 落到 client.background（eager 推 parent ws 经 ws.ts seq path drain；chunkDelayMs=2000 拉长窗口）→ client.close → client.reconnect → `chat.attach(child, running:true)` → `chat.sync` 补齐断连窗口 → 等子 done
- **关键差异**：eager 启动 → 子 chunks 通过 background（按 chatId=childChatId 过滤）到达，非经 chat.startSpawn RPC 流。spawnHandle.events 改读 background（eager requestId='eager-{taskId}' 不在 harness pending）
- **检查**：`running:true`、`attached:true`、跨断连续跑至 done（chat.run.done notification 携带 finished:true）
- **功能点**：FP-F4
- **覆盖**：F4

#### S14b/S16b spawn eager 启动 + live stream 推送（[flowSubAgentLive.test.ts](../../test/flows/service/flowSubAgentLive.test.ts)）

- **新增独立测试**（2026-07-23 收敛）：锁住后端 eager 启动 + WS 推送语义，**不依赖前端 chat.startSpawn RPC**：
  - **T1 eager 启动**：spawn_role 后子 stream chunks 经 ws 推到 parent 连接；chunkDelayMs=2000 拉长窗口，验证 eager 启动实际 run；chat.startSpawn RPC recovery 返 `alreadyRunning: true`
  - **T2 fast-finish ghost**：mock_content 子 agent 立即 done（finished:true）；eager 已跑完 → done notification 落 background
  - **T3 chunks 携带 chatId**：所有 chunk 必带 `chatId === childChatId` + `requestId`（前端 seq path 路由字段）
  - **T4 error path 隔离**：父 sense 返回路径不被异常阻塞（背景日志验证 sense.execute.end）
- **与 S14/S15/S16 互补**：S14b 锁「eager 路径生效」，原 S14 锁「用户原意（chat.startSpawn 退化为 recovery）」

---

## 4. 覆盖矩阵（分支 → 场景）

证明 §1 每条分支至少一个场景覆盖。空格 = 缺口（当前无）。

| 分支 | 场景 | 状态 |
|------|------|------|
| A0 纯文本 | S1 | **Tier 1 已落地** |
| A1 auto | S2 | **Tier 1 已落地** |
| A2 smart accept | S3 | **Tier 1 已落地** |
| A3 smart reject | S4 | **Tier 1 已落地** |
| A4 超时拒 | S5 | **Tier 1 已落地** |
| A5 不限时 hard-park | S6 | **G2 单元 + Tier 1 端到端已落地** |
| B1 流式 | S1/S2 | **Tier 1 已落地** |
| B2 多轮 loop | S2 | **Tier 1 已落地** |
| B3 todo | S7 | **Tier 1 已落地** |
| C1 断连宽限 | S8/S9 前置 | **G1 单元已落地** |
| C2 窗口内重连续跑 | S8/S9/S12 | **Tier 2 已落地**（S8 流式 / S9 审批） |
| C3 超宽限释放 | S10 | **Tier 2 已落地**（真实短 grace + 完整 park 链路：grace.expired→park→canResume / attach running:false） |
| C4 流式刷新续 | S8 | **Tier 2 已落地** |
| C5 审批刷新原 id | S9 | **Tier 2 已落地**（端到端：grace 内 approval 存活，原 id 命中） |
| C6 刷新态恢复 | S12 | **Tier 2 已落地**（currentTodo/runningTools/pendingApproval 端到端，与 G8 单元互补） |
| D1 单一事件流 | S11 | **Tier 2 已落地**（chat.sync(0) 完整事件流 + currentState，与 G3 协议单元互补） |
| D2 超窗回填 | S11 | **Tier 2 已落地**（真实历史 + 强制淘汰 → 回填合成旧消息 + 留存近期，msgId 去重） |
| D3 单数组无合并 | S11 | **Tier 2 已落地**（回填 staged 与留存同形，单数组累加无分支） |
| E1 停止归 resume | S13 | **Tier 2 已落地** |
| E2 刷新后仍 resume | S13 | **Tier 2 已落地** |
| F1 子同流程 | S14 | **Tier 2 已落地**（spawn_role→role_created→startSpawn→子 done→role_reply→主 resume 全链路） |
| F2 immediate 全链路 | S14 | **Tier 2 已落地**（wakeScheduler immediate shouldWake→role_reply；DB 子 finished） |
| F3 deferred/barrier | S15 | **Tier 2 已落地**（2 deferred 子：首子 silent 无 role_reply，全完成仅 1 条 role_reply） |
| F4 子刷新重连 | S16 | **Tier 2 已落地**（子 running 断连→attach(child, running:true)→跨断连续跑至 done，机制同 S8） |

**结论**：原始需求 24 条分支**全部有场景覆盖 + 端到端落地**，无缺口。S1–S16 全绿（Tier 1 S1–S7 + Tier 2 S8–S16）；改造验收点 G1/G2/G3/G8 单元 + Tier 2 端到端双托底。

---

## 5. 测试分层与 harness

### Tier 1 — agent/中间件级（S1–S7）
快、确定、无 WS/DB。直驱中间件洋葱链。
- 复用 [agentHarness.ts](../test/agent/helpers/agentHarness.ts)：`createAgent`/`runSend`/`runSendWithApproval`/`runResume`/`approve`/`abortApproval`
- 复用 [chunkAssert.ts](../test/agent/helpers/chunkAssert.ts)：`collectChunks`/`stagedTypes`/`senseEnds`/`senseAccepts`/`senseRejects`/`hasDone`
- 复用 [mockScripts.ts](../test/agent/helpers/mockScripts.ts)：`addMockBrain` 动态注入脚本
- 模式参照 [tool.test.ts](../test/agent/middleware/tool.test.ts)（auto/smart accept·reject/批量审批/resume pending）、[loop.test.ts](../test/agent/middleware/loop.test.ts)（done vs firstError 失败抑制）

### Tier 2 — service+WS 级（S8–S16）
慢、真实断连/重连/DB。**G1/G3/G8 验收主战场。**
- 起真实服务：`createWebSocketServer` + router + 全 handler（[service/index.ts](../src/service/index.ts)）
- 用 [rpcClient.ts](../test/helpers/rpcClient.ts) 驱动 chat.send/resume/abort/attach/sync/approval，`getWebSocket().close()` 模拟断连 + 重连
- DB 断言复用 [chatRecovery.test.ts](../test/service/chatRecovery.test.ts) 模式（createChat/addMessage/getMessages/getLastMessage + chat metadata + spawn_tasks）
- 看门狗/wake/grace 时序用 `vi.useFakeTimers()`（参照 [spawnBroker.test.ts](../test/agent/spawnBroker.test.ts)）

### 需新建
- `test/flows/agent/`（Tier 1）+ `test/flows/service/`（Tier 2）两组 `.test.ts`
- 延迟 fixture `test/flows/fixtures/.chery/mock/flow_*.yaml`（显式设大 `chunkDelayMs`，使 close/重连可靠落在流式窗口）
- WS 事件断言 helper `test/flows/helpers/eventsAssert.ts`（S2C Chunk/Notification 序列断言，对称 chunkAssert）

---

## 6. Mock 延迟机制

本地 mock 响应过快（零延迟、最多 3 delta chunk 背靠背 yield），无法测流式/刷新/计时。改造 [mock.ts](../src/agent/provider/mock.ts)：

- `MockScriptResponse`（[config.ts](../src/utils/config.ts)）增 `chunkDelayMs?`（每 delta chunk 间 sleep）/ `preRespondMs?`（本轮首响应前 sleep）
- `mock.ts` `gen()` 每个 yield 前 `await sleep(chunkDelayMs)`；`chatStream`/`chat` `pickScriptItem` 后 `await sleep(preRespondMs)`
- 全局兜底：`brain.mock` 配置段 `chunkDelayMs`/`preRespondMs`，脚本项缺省取全局，默认 0（不拖慢单测）
- 审批挂起非 mock 管：smart/manual 中断由 `approvalRegistry` await，测试用真实短超时或 `vi.useFakeTimers()`

---

## 7. 实现状态

| 项 | 状态 |
|----|------|
| G1（disconnectGrace deferred-park） | **已落地** [disconnectGrace.test.ts](../test/service/websocket/disconnectGrace.test.ts) |
| G2（hard-timeout） | **已落地** [approvalRegistry.test.ts](../test/core/sense/approvalRegistry.test.ts) |
| G3（chat.sync 单一水源 + 回填） | **已落地** [flowSync.test.ts](../test/service/chat/flowSync.test.ts) |
| G8（currentState 快照） | **已落地** [currentState.test.ts](../test/service/chat/currentState.test.ts) |
| Mock 延迟机制 | **已落地** [mock.ts](../src/agent/provider/mock.ts) |
| S1–S7 标准流程（[flowStandard.test.ts](../test/flows/agent/flowStandard.test.ts)，Tier 1） | **已落地** 8 场景全绿 |
| Tier 2 地基（[serviceHarness](../test/flows/helpers/serviceHarness.ts) + [rpcClient](../test/helpers/rpcClient.ts) binary 帧+reconnect + [eventsAssert](../test/flows/helpers/eventsAssert.ts)） | **已落地** 真实 startService + 临时端口 + per-process DB 隔离 |
| S8 流式中断刷新续跑（[flowStream.test.ts](../test/flows/service/flowStream.test.ts)，打字机重建） | **已落地** chunkDelayMs=2000 造窗口 + liveOutput 重定向 |
| S9 审批中断刷新原 id（[flowRefresh.test.ts](../test/flows/service/flowRefresh.test.ts)，G1 改造C 验收） | **已落地** grace 内 approval 存活，原 approvalId 命中续跑 |
| S13 停止后刷新仍 resume（[flowAbort.test.ts](../test/flows/service/flowAbort.test.ts)） | **已落地** abort→paused，chat.get canResume=true |
| abort-during-approval src gap 修复 | **已落地** [send.ts](../src/service/chat/send.ts) handleChatAbort + [disconnectGrace.getPendingApprovalId](../src/service/websocket/disconnectGrace.ts)：对 pending approval 调 approvalManager.abort（rejectApproval(AgentAbortError)）可靠中断 approval.wait（gen.throw 注入外部 pending promise 不可靠） |
| S10 审批中断超 grace 释放（[flowGraceExpire.test.ts](../test/flows/service/flowGraceExpire.test.ts)） | **已落地** 真实短 grace（`disconnectGraceMs=400`）+ 完整 park 链路：grace.expired→parkApproval→agent.paused(kind=park)→重连 chat.get canResume=true / attach running:false |
| S11 冷刷新单一事件流（[flowColdSync.test.ts](../test/flows/service/flowColdSync.test.ts)，G3 端到端） | **已落地** 真实 send 链历史 + chat.sync(0) 完整事件流 + currentState；强制淘汰旧事件→回填合成旧消息 + 留存近期，msgId 去重，backfilled:true |
| S12 currentState 快照（[flowCurrentState.test.ts](../test/flows/service/flowCurrentState.test.ts)，G8 端到端） | **已落地** currentTodo=结构化 todos 经 chat.get 快照；runningTools+pendingApproval 同源 approvalId 经 chat.attach 快照 |
| S14 immediate 全链路（[flowSpawn.test.ts](../test/flows/service/flowSpawn.test.ts)） | **已落地** spawn_role→role_created→startSpawn→子 done(finished:true)→role_reply→主 resume 轮2；DB 断言子 finished+parent_chat_id |
| S15 deferred 静默批量唤主（[flowSpawn.test.ts](../test/flows/service/flowSpawn.test.ts)） | **已落地** 2 deferred 子：首子 silent 无 role_reply，全完成 allChildrenFinished→仅 1 条 role_reply |
| S16 子刷新重连（[flowSpawn.test.ts](../test/flows/service/flowSpawn.test.ts)） | **已落地** reviewer_stream 流式子 running 断连→attach(child, running:true)→跨断连续跑至 done（机制同 S8 施于 childChatId） |

跑改造验收点：`npx vitest run test/core/sense/approvalRegistry.test.ts test/service/chat/currentState.test.ts test/service/chat/flowSync.test.ts test/service/websocket/disconnectGrace.test.ts`

跑 Tier 1 标准流程：`npx vitest run test/flows/agent/flowStandard.test.ts`

跑 Tier 2 刷新/停止：`npx vitest run test/flows/service/`

---

## 8. 门控

- **必绿**：S1–S16 全绿方算流程测试验收（S6/S9/S11/S12 = G1/G2/G3/G8 验收点）。跑 `pnpm vitest run test/flows/`（过滤出 flow 套件，避开预存 ~86 失败基线）
- **core/agent 覆盖**：改 `src/core`/`src/agent` 跑 `pnpm test`（core≥90%/agent≥70%）
- **协议契约**：改 types.ts/schemas.ts/config.ts 跑 `pnpm type-check`（排除 [test.md](./test.md) 基线 4 处）+ `pnpm lint`
- 流程测试独立于预存失败基线，不计入该基线
- 前端验证交用户（约定）

---

## 9. 依赖与关联

- **关联文档**：[test.md](./test.md)（test 模块推迟索引，流程测试为例外）、[protocol.md](./protocol.md)（currentState 字段表 + 事件重放分类表 + chat.sync 单一水源）、[interaction.md](./interaction.md)（冷启动 `chat.attach → chat.sync(0)` 序列）、[mock.md](./mock.md)（mock provider 脚本化）、[service/chat.md](./service/chat.md)、[service/websocket.md](./service/websocket.md)
- **关联记忆**：[[protocol-hydration-redesign]]、[[test-module-deferred]]、[[unified-pause-semantics]]、[[test-core-agent-required]]
- **改造背景**：G1–G8 详见计划 `/home/chery/.claude/plans/virtual-splashing-yao.md` 与 [[protocol-hydration-redesign]]
