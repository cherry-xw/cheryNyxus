# 流程测试规约（Flow Test Spec）

> 把「主子 agent 对话 / 审批 / 工具卡 / 刷新重连 / resume」的需求逐条落成**可执行的流程测试**。本文是流程测试的**规约**（doc-first）：每个交互场景给出**步骤序列 + 检查信息 + 功能点 + 覆盖分支**，并证明原始需求的每种分支情况都被某个场景覆盖。
>
> 状态：覆盖 [test.md](./test.md) 的「test 模块推迟」约定——流程测试是**例外**（新建、独立、全绿），不计入预存失败基线。**S1–S17 全部落地**（Tier 1 S1–S7 + Tier 2 S8–S17），公共流程已统一迁移到 canonical command/session plane。

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
| A5 不限时 + 30min 自动释放 | `approval_timeout=0` + `approval_hard_timeout` 到点 → runtime paused；同一持久待办仍可直接处理并续跑 | S6 |

### FP-B 流式与多轮 loop

| 分支 | 语义 | 覆盖场景 |
|------|------|----------|
| B1 流式正文（打字机） | `stream` delta ×N → `content_end` | S1/S2 |
| B2 多轮 loop（sense 后再跑 LLM） | sense_end → loop 续跑 → 末条 assistant 无 senseCalls → ended | S2 |
| B3 todo list 显示 | `update_todo` 的 `sense_end.arguments.todos` 结构化 | S7 |

### FP-C 刷新重连（3 分支 + 态恢复）

| 分支 | 语义 | 覆盖场景 |
|------|------|----------|
| C1 断连不终止 canonical run | `chat.input.submit` ACK 后运行与 RPC 脱钩；WS close 不立即 park | S8/S9 |
| C2 重连 → 原子订阅 + 瞬态恢复 | `chat.open` 原子建立订阅并恢复 `run/activeTurns/pendingApproval` → 续跑 | S8/S9/S12/S17 |
| C3 审批资源上限 → 释放 → resume | 无限审批达到 `approval_hard_timeout` → paused → `canResume=true` | S10 |
| C4 流式中断刷新续跑（打字机续） | 流式 close → 重连回放 stream chunk → 续 | S8 |
| C5 审批中断刷新续跑（**原 approvalId 命中**） | 审批挂起 close → canonical run/interaction 存活 → 用原 id 决策命中 | S9 |
| C6 刷新态恢复 | `currentState`{pendingApproval/runningTools/currentTodo} 快照权威 | S12 |

### FP-D canonical 时间线与原子打开

| 分支 | 语义 | 覆盖场景 |
|------|------|----------|
| D1 冷刷新权威时间线 | `chat.timeline.get` 从持久 messages 返回完整 canonical timeline | S11 |
| D2 留存独立 | 清空 `chat_events` 后 canonical messages 与 revision 仍不变 | S11 |
| D3 已知 revision 稳定 | 携 `knownRevision` 重读仍返回同一 revision 与消息身份 | S11 |
| D4 原子打开边界 | `chat.open` 同时建立 subscription、捕获 `eventSeq` 并 hydration；边界后事件单调递增 | S17 |

### FP-E 停止按钮

| 分支 | 语义 | 覆盖场景 |
|------|------|----------|
| E1 停止立即归 resume | `chat.abort` → `AgentAbortError` → paused（`clearChatRuntime`） | S13 |
| E2 刷新后仍 resume | abort 后刷新，`canResume=true` 持久 | S13 |

### FP-F 子 agent

| 分支 | 语义 | 覆盖场景 |
|------|------|----------|
| F1 同流程（invoker 数据源不同） | 子 chat 走同一 send/resume/loop 链，invoker=spawn 而非用户 | S14 |
| F2 immediate 全链路 | spawn → `role_created` → 后端 eager 子 done → `role_reply` → 主 canonical resume | S14 |
| F3 deferred/barrier 暂存唤主 | 多子 deferred，中途 silent 不推 role_reply，全完成兜底唤主 | S15 |
| F4 子 agent 刷新重连（继承机制） | 子 running → `chat.open(子)` → 续跑 | S16 |

---

## 2. 统一断言维度

每个场景的每个任务节点须沿四维断言（场景表只列该场景特有的，共性在此）：

| 维度 | 断言内容 |
|------|----------|
| **事件** | chunk/notification 类型 + 顺序 + 关键字段（`approvalId`/`msgId`/`seq`/`senseName`/`waitTime`/`createdAt`） |
| **DB 状态** | messages（完整 role/content/sense_calls/revoked/runtime）、chat metadata（finished/wake/resumePending）、chat_events（仅结构/终态，seq 单调；不含 stream/turn.delta） |
| **运行时态** | `isChatRunning`、`approvalManager.approvals`（含/不含 id）、`computeCanResume`、`waitedChildren` |
| **交互功能** | canonical RPC（`chat.input.submit`/`chat.run.resume`/`chat.abort`/`chat.open`/`chat.timeline.get`/`interaction.approval.decide`）是否按预期触发；ACK 与异步 session 事件是否正确解耦 |

**canResume 权威语义**（[canResume.ts](../src/service/chat/canResume.ts) `computeCanResume`）：
- `ended`（`canResume=false`）= 末条 visible assistant 且无 sense_calls（loop 自然完成）。
- `paused`（`canResume=true`）= 末条 sense/user/role/subagent，或 assistant 带 sense_calls；abort/park/AI 报错/审批硬期限释放皆归此。

---

## 3. 流程场景矩阵（S1–S17）

分层：**Tier 1**（中间件级，`agentHarness`+`chunkAssert`，无 WS/DB）= S1–S7；**Tier 2**（service+WS 级，真实服务+`rpcClient`+DB）= S8–S17。G1/G2/G3/G8 改造验收点 = S6/S9/S11/S12。

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
- **步骤**：`sense_end` → `interrupt`{waitTime,createdAt,supervisionLevel:1} → `[interaction.approval.decide accept]` → `accept` → stream → `done`
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
- **检查**：pending sense content NULL；`canResume=true`（paused）；hard=park（可续）**非** reject；全局待办保留同一稳定 interactionId，直接处理后自动恢复
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
- **步骤**：`ws.close()` → 重连 → `chat.open` 原子恢复 `state.run/state.activeTurns` 与订阅 → 续跑 → `done`
- **检查**：canonical detached run 不因 close 而 park；`isChatRunning=true`；`chat.open` 建立新 subscription；跨断连 stream 内容可重建
- **功能点**：FP-C1 / FP-C2 / FP-C4
- **覆盖**：C1、C2、C4

#### S9 审批中断刷新续跑原 id（**G1 验收点**）
- **前置**：S3 审批挂起 → `ws.close()`
- **步骤**：重连 → `chat.open.state.pendingApproval` 恢复原 id → `[interaction.approval.decide **原 approvalId**]` → `accept` → 续跑 → `done`
- **检查**：close 后 canonical run 与持久 interaction 仍存活；原 id 决策命中，且 `chat.open` 快照与实时 accept 同源
- **功能点**：FP-C5（断「原 approvalId 不失效」= 改造C 验收核心）
- **覆盖**：C5
- **已落地测试**：[flowRefresh.test.ts](../test/flows/service/flowRefresh.test.ts) 验 canonical 端到端原 id 决策；[disconnectGrace.test.ts](../test/service/websocket/disconnectGrace.test.ts) 独立覆盖仍由传输请求拥有的 grace/rebind 机制

#### S10 canonical detached 审批硬期限释放
- **前置**：`approval_timeout=0`、测试态 `approval_hard_timeout=400ms`；S3 审批挂起后断连
- **步骤**：hard deadline → `AgentParkError` → run paused → 重连查询 catalog/open
- **检查**：运行注册表释放；metadata 无 finished；末条 sense → `canResume=true`；`chat.open.state.run` 为空
- **功能点**：FP-C3
- **覆盖**：C3
- **已落地测试**：[flowGraceExpire.test.ts](../test/flows/service/flowGraceExpire.test.ts)（真实短 hard deadline + 完整 canonical input/observer 链：挂起审批→断连→agent.paused kind=park→重连 `chat.list canResume=true` / `chat.open` idle）

#### S11 canonical 持久时间线（**G3 验收点**）
- **前置**：真实 input 链生成包含 `update_todo` 的完整历史
- **步骤**：`chat.timeline.get` → 记录 messages/revision → 清空 `chat_events` → 再次读取；另以 `knownRevision` 重读
- **检查**：messages 来自持久消息存储，不依赖事件留存；消息 id、sense call 状态与 revision 稳定
- **功能点**：FP-D1 / FP-D2 / FP-D3
- **覆盖**：D1、D2、D3
- **已落地测试**：[flowTimeline.test.ts](../test/flows/service/flowTimeline.test.ts) Tier 2 端到端 2 项（留存独立 + known revision 稳定）；底层历史转换仍由 [flowSync.test.ts](../test/service/chat/flowSync.test.ts) 覆盖

#### S17 `chat.open` 原子订阅边界（**M1+M2+M9 验收点**）
- **前置**：idle chat、审批运行中 chat，以及 open 后再提交输入三类状态
- **步骤**：`chat.open` 原子注册 subscription → 捕获 `eventSeq` → hydration `state` → 释放边界后事件
- **检查**：idle state 为空；running state 含 run/activeTurns/pendingApproval/runningTools；后续事件携同一 subscriptionId 且 eventSeq 严格大于打开边界并单调递增
- **功能点**：原子 subscription boundary，消除旧 attach+sync 两调用间竞态
- **覆盖**：idle hydration + running hydration + boundary 后事件顺序
- **已落地测试**：[flowOpenBoundary.test.ts](../test/flows/service/flowOpenBoundary.test.ts) Tier 2 端到端 3 项

#### S12 刷新 currentState 快照（**G8 验收点**）
- **前置**：S2/S3/S7 任一中断态刷新
- **步骤**：`chat.open.state` 权威恢复瞬态；已完成 todo 从 `chat.timeline.get` 的 canonical senseCalls 恢复
- **检查**：`state.pendingApproval`、`state.runningTools[]`、`state.run/activeTurns`；timeline 保留结构化 todo；**不持久化瞬态 Delta 作为第二水源**
- **功能点**：FP-C6
- **覆盖**：C6
- **已落地测试**：[currentState.test.ts](../test/service/chat/currentState.test.ts) 4 项 + [flowCurrentState.test.ts](../test/flows/service/flowCurrentState.test.ts) Tier 2 端到端 2 项（todo 经 timeline，runningTools/pendingApproval 经 open）

### C. 停止 `test/flows/service/flowAbort.test.ts`（Tier 2）

#### S13 停止后刷新仍 resume
- **步骤**：`chat.abort` → `AgentAbortError` → paused(`clearChatRuntime`) → 刷新
- **检查**：`isChatRunning=false`；末条 sense/user → `canResume=true`；刷新后仍 `canResume=true`；abort 级联停后代；不写 DB
- **功能点**：FP-E1 / FP-E2
- **覆盖**：E1、E2

### D. 子 agent `test/flows/service/flowSpawn.test.ts`（Tier 2）

#### S14 spawn immediate 全链路
- **步骤**：`spawn_role` → 后端 **eager 启动**（[spawnEager.ts](../../src/service/chat/spawnEager.ts) `runChildTaskInBackground`）→ role_created 推主连接（background）→ 子 done → role_reply → 主 resume
- **关键差异**：`spawn_role` 成功后由后端唯一负责 eager 启动，客户端只消费角色生命周期事件
- **检查**：role_created 到达 background（按 parentChatId 过滤）→ 主 yieldTurn → done；wakeScheduler immediate shouldWake → role_reply；`chat.run.resume` ACK 后按全局 journal 的 chatId 验完整输出
- **功能点**：FP-F1 / FP-F2
- **覆盖**：F1、F2

#### S15 spawn deferred/barrier 暂存唤主
- **前置**：先创建慢流式子、再创建快子，保证调度器可观察完整子集合
- **步骤**：spawn_role 派发 2 子 deferred → 2 条 role_created → 快子完成 silent → 慢子完成兜底唤主 → role_reply 总数=1 → 主 canonical resume
- **检查**：`roleEventCount(role_reply) === 1`；语义：「仅 1 条 role_reply」（deferred 全完成兜底唤主，非按子计数）
- **功能点**：FP-F3
- **覆盖**：F3

#### S16 子 agent 刷新重连
- **前置**：子 running → 首个 stream chunk 已到达
- **步骤**：父 canonical input → spawn_role(reviewer_stream) → role_created → client.close/reconnect → `chat.open(child)` 恢复 running/activeTurns → 等子 done
- **关键差异**：eager 子 chunks 通过 session journal（按 childChatId 过滤）到达，不存在客户端 startSpawn RPC
- **检查**：`open.state.run.state=running`、`activeTurns` 非空、跨断连续跑至 done
- **功能点**：FP-F4
- **覆盖**：F4

#### S14b/S16b spawn eager 启动 + live stream 推送（[flowSubAgentLive.test.ts](../../test/flows/service/flowSubAgentLive.test.ts)）

- **新增独立测试**（2026-07-23 收敛）：锁住后端 eager 启动 + WS 推送语义：
  - **T1 eager 启动**：spawn_role 后子 stream chunks 经 ws 推到 parent 连接；chunkDelayMs=2000 拉长窗口，验证 eager 启动实际 run
  - **T2 fast-finish ghost**：mock_content 子 agent 立即 done（finished:true）；eager 已跑完 → done notification 落 background
  - **T3 chunks 携带 chatId**：所有 chunk 必带 `chatId === childChatId` + `requestId`（前端 seq path 路由字段）
  - **T4 error path 隔离**：父 sense 返回路径不被异常阻塞（背景日志验证 sense.execute.end）
- **与 S14/S15/S16 互补**：S14b 锁「eager 路径生效」，S14 锁完整角色生命周期与主会话恢复

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
| C1 断连不终止 canonical run | S8/S9 | **Tier 2 已落地** |
| C2 open 原子恢复 | S8/S9/S12/S17 | **Tier 2 已落地** |
| C3 审批硬期限释放 | S10 | **Tier 2 已落地**（hard deadline→park→canResume / open idle） |
| C4 流式刷新续 | S8 | **Tier 2 已落地** |
| C5 审批刷新原 id | S9 | **Tier 2 已落地**（端到端：open 恢复原 interaction，原 id 命中） |
| C6 刷新态恢复 | S12 | **Tier 2 已落地**（currentTodo/runningTools/pendingApproval 端到端，与 G8 单元互补） |
| D1 canonical timeline | S11 | **Tier 2 已落地**（`chat.timeline.get` 完整消息） |
| D2 留存独立 | S11 | **Tier 2 已落地**（删除 chat_events 后消息/revision 不变） |
| D3 known revision | S11 | **Tier 2 已落地**（revision 与消息身份稳定） |
| D4 open 原子边界 | S17 | **Tier 2 已落地**（subscriptionId + eventSeq 单调） |
| E1 停止归 resume | S13 | **Tier 2 已落地** |
| E2 刷新后仍 resume | S13 | **Tier 2 已落地** |
| F1 子同流程 | S14 | **Tier 2 已落地**（spawn_role→role_created→eager 子 done→role_reply→主 resume） |
| F2 immediate 全链路 | S14 | **Tier 2 已落地**（wakeScheduler immediate shouldWake→role_reply；DB 子 finished） |
| F3 deferred/barrier | S15 | **Tier 2 已落地**（2 deferred 子：首子 silent 无 role_reply，全完成仅 1 条 role_reply） |
| F4 子刷新重连 | S16 | **Tier 2 已落地**（子 running 断连→open(child)→跨断连续跑至 done） |

**结论**：当前分支均有场景覆盖 + 端到端落地，无缺口。S1–S17 全绿（Tier 1 S1–S7 + Tier 2 S8–S17）。

---

## 5. 测试分层与 harness

### Tier 1 — agent/中间件级（S1–S7）
快、确定、无 WS/DB。直驱中间件洋葱链。
- 复用 [agentHarness.ts](../test/agent/helpers/agentHarness.ts)：`createAgent`/`runSend`/`runSendWithApproval`/`runResume`/`approve`/`abortApproval`
- 复用 [chunkAssert.ts](../test/agent/helpers/chunkAssert.ts)：`collectChunks`/`stagedTypes`/`senseEnds`/`senseAccepts`/`senseRejects`/`hasDone`
- 复用 [mockScripts.ts](../test/agent/helpers/mockScripts.ts)：`addMockBrain` 动态注入脚本
- 模式参照 [tool.test.ts](../test/agent/middleware/tool.test.ts)（auto/smart accept·reject/批量审批/resume pending）、[loop.test.ts](../test/agent/middleware/loop.test.ts)（done vs firstError 失败抑制）

### Tier 2 — service+WS 级（S8–S17）
慢、真实断连/重连/DB。**G1/G3/G8 验收主战场。**
- 起真实服务：`createWebSocketServer` + router + 全 handler（[service/index.ts](../src/service/index.ts)）
- 用 [serviceHarness.ts](../test/flows/helpers/serviceHarness.ts) 的 canonical helper 驱动 `chat.input.submit`、`chat.run.resume`、`chat.open`、`chat.timeline.get`、`interaction.approval.decide`；[rpcClient.ts](../test/helpers/rpcClient.ts) 保留全局接收 journal 以验收 ACK 后异步事件
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
| G3（canonical timeline + 留存独立） | **已落地** [flowTimeline.test.ts](../test/flows/service/flowTimeline.test.ts) |
| G8（currentState 快照） | **已落地** [currentState.test.ts](../test/service/chat/currentState.test.ts) |
| Mock 延迟机制 | **已落地** [mock.ts](../src/agent/provider/mock.ts) |
| S1–S7 标准流程（[flowStandard.test.ts](../test/flows/agent/flowStandard.test.ts)，Tier 1） | **已落地** 8 场景全绿 |
| Tier 2 地基（[serviceHarness](../test/flows/helpers/serviceHarness.ts) + [rpcClient](../test/helpers/rpcClient.ts) binary 帧+reconnect + [eventsAssert](../test/flows/helpers/eventsAssert.ts)） | **已落地** 真实 startService + 临时端口 + per-process DB 隔离 |
| S8 流式中断刷新续跑（[flowStream.test.ts](../test/flows/service/flowStream.test.ts)，打字机重建） | **已落地** chunkDelayMs=2000 造窗口 + liveOutput 重定向 |
| S9 审批中断刷新原 id（[flowRefresh.test.ts](../test/flows/service/flowRefresh.test.ts)） | **已落地** `chat.open` 恢复原 interaction，原 approvalId 命中续跑 |
| S13 停止后刷新仍 resume（[flowAbort.test.ts](../test/flows/service/flowAbort.test.ts)） | **已落地** abort→paused，`chat.list canResume=true` |
| abort-during-approval src gap 修复 | **已落地** [send.ts](../src/service/chat/send.ts) handleChatAbort + [disconnectGrace.getPendingApprovalId](../src/service/websocket/disconnectGrace.ts)：对 pending approval 调 approvalManager.abort（rejectApproval(AgentAbortError)）可靠中断 approval.wait（gen.throw 注入外部 pending promise 不可靠） |
| S10 canonical 审批硬期限释放（[flowGraceExpire.test.ts](../test/flows/service/flowGraceExpire.test.ts)） | **已落地** hard deadline→agent.paused(kind=park)→重连 `chat.list canResume=true` / `chat.open` idle |
| S11 canonical timeline（[flowTimeline.test.ts](../test/flows/service/flowTimeline.test.ts)） | **已落地** `chat.timeline.get` 完整历史、事件留存独立、known revision 稳定 |
| S12 currentState 快照（[flowCurrentState.test.ts](../test/flows/service/flowCurrentState.test.ts)） | **已落地** todo 经 timeline；runningTools+pendingApproval 经 open.state |
| S14 immediate 全链路（[flowSpawn.test.ts](../test/flows/service/flowSpawn.test.ts)） | **已落地** spawn_role→role_created→eager 子 done→role_reply→canonical resume；DB 断言子 finished+parent_chat_id |
| S15 deferred 静默批量唤主（[flowSpawn.test.ts](../test/flows/service/flowSpawn.test.ts)） | **已落地** 2 deferred 子：首子 silent 无 role_reply，全完成 allChildrenFinished→仅 1 条 role_reply |
| S16 子刷新重连（[flowSpawn.test.ts](../test/flows/service/flowSpawn.test.ts)） | **已落地** reviewer_stream 子 running 断连→open(child)→跨断连续跑至 done |
| S17 open 原子边界（[flowOpenBoundary.test.ts](../test/flows/service/flowOpenBoundary.test.ts)） | **已落地** idle/running hydration + subscription 边界后 eventSeq 单调 |

跑改造验收点：`npx vitest run test/core/sense/approvalRegistry.test.ts test/service/chat/currentState.test.ts test/service/chat/flowSync.test.ts test/service/websocket/disconnectGrace.test.ts`

跑 Tier 1 标准流程：`npx vitest run test/flows/agent/flowStandard.test.ts`

跑 Tier 2 刷新/停止：`npx vitest run test/flows/service/`

---

## 8. 门控

- **必绿**：S1–S17 全绿方算流程测试验收。跑 `pnpm vitest run test/flows/`
- **core/agent 覆盖**：改 `src/core`/`src/agent` 跑 `pnpm test`（core≥90%/agent≥70%）
- **协议契约**：改 types.ts/schemas.ts/config.ts 跑 `pnpm type-check`（排除 [test.md](./test.md) 基线 4 处）+ `pnpm lint`
- 流程测试独立于预存失败基线，不计入该基线
- 前端验证交用户（约定）

---

## 9. 依赖与关联

- **关联文档**：[test.md](./test.md)、[protocol.md](./protocol.md)（canonical command/session plane）、[interaction.md](./interaction.md)（`chat.open` + `chat.timeline.get` hydration）、[mock.md](./mock.md)、[service/chat.md](./service/chat.md)、[service/websocket.md](./service/websocket.md)
- **关联记忆**：[[protocol-hydration-redesign]]、[[test-module-deferred]]、[[unified-pause-semantics]]、[[test-core-agent-required]]
- **改造背景**：G1–G8 详见计划 `/home/chery/.claude/plans/virtual-splashing-yao.md` 与 [[protocol-hydration-redesign]]
