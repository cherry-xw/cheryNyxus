# 前端重构执行手册（handoff）

> **用途**：后端协议改造（G1–G8 + 流程测试 S1–S16）已全绿交付，本手册是**前端重构（F1–F5）的执行入口**，供新会话直接上手，不依赖任何前置对话上下文。
>
> **性质**：执行手册（transient），F1–F5 落地后归档或并入 [docs/web/](./) 永久架构文档。

---

## 0. 一句话目标

让前端历史面板成为「**单一缓存数组**」：刷新重连后，`chat.get`（loadHistory）+ `chat.sync`（replay/attach 补回 disconnect-window）双 RPC 各司其职 + 一个 `currentState` 快照定实时态，消除当前「双路合并 + 事件推导实时态 + 5 源 6 层去重 ≈ 470 行」的复杂度。原始需求明示「釜底抽薪、完全重构、不考虑现有实现」。

> M1+M2+M9 修复注：F4 实施时把主 chat 历史统一走 `chat.sync(0)`，但因 sync(afterSeq) 增量语义、`afterSeq=wsClient.getLastSeq()` 永不 0、且 chat_events retention 边界不稳，导致刷新后主 chat 历史空白。本期改回**双 RPC 语义对齐**：`chat.get` = 全量历史（loadHistory / messages 表 retention-independent），`chat.sync` = 增量回放（attach 后补回 / 启动批 replay / chat_events seq>afterSeq）。详见 §3 F4 修订。

---

## 1. 背景：后端已就绪的契约（前端要消费的新协议）

后端阶段已完成（[plan §1–3](../../../home/chery/.claude/plans/virtual-splashing-yao.md) + [docs/flow-test.md](../flow-test.md) S1–S16 全绿）。前端需消费三项：

| 后端契约 | 位置 | 前端用途 |
|---------|------|---------|
| `chat.sync(afterSeq)` 增量回放（attach 后补回 disconnect-window；超窗时自动 messages 合成回填 + backfilled:true） | [handler.ts:364-435](../../../src/service/chat/handler.ts#L364) | 启动批量 replay / attach 后补回 / 断连重连同步 |
| `chat.get` 全量历史（messages 表，与 chat_events retention 解耦） | [handler.ts:304-356](../../../src/service/chat/handler.ts#L304) | 抽屉打开 / 显式 reload / doLoadHistory 主 chat 路径 |
| `chat.attach` 响应携带 `snapshotSeq`（cursor 锚点）+ `currentState`（实时态快照） | [handler.ts:562-606](../../../src/service/chat/handler.ts#L562)（M2 修复补 snapshotSeq；**eager 启动** 下子 chat 走此 recovery 路径，2026-07-23 收敛，见 [agent-pet.md §5.1](../../agent-pet.md)） | 重连运行中 run：resetChatSeq + applyCurrentState + applyQuestionSnapshot + syncOneChat('replay') 补回 disconnect-window |
| `currentState{pendingApproval, runningTools, currentTodo}` 挂在 response | [handler.ts:347/432/595](../../../src/service/chat/handler.ts#L347)（chat.get/sync/attach）；计算 [currentState.ts](../../../src/service/chat/currentState.ts) | 权威给实时态，取代事件推导 |
| 断连不立即 park，重连续审批**原 approvalId**（G1） | [connection.ts:201](../../../src/service/websocket/connection.ts#L201) + disconnectGrace | 审批气泡刷新后用原 id 命中 |
| 不限时审批 30min → park paused（G2） | `approval_hard_timeout` | 审批气泡存活判定依据 |

**关键**：`currentState` 刻意**不含 `currentTurnContent`**（[currentState.ts:14-16](../../../src/service/chat/currentState.ts#L14) 注释）——打字机 content 仍由 stream delta 事件流恢复，避免双内容源。前端**不可**要求后端加 currentTurnContent。

`CurrentStateData` 类型：[src/service/message/types.ts:1029-1046](../../../src/service/message/types.ts#L1029)。

---

## 2. 前端现状（要消除的复杂度）

### 2.1 双路 hydration
- `chat.sync`（事件增量 → 重建实时态 thinking/content/runningTools/approval）+ `chat.get`（staged → 重建 `stream.history`），两路写 StreamState 不同字段；`sync` 返 `reset:true` 时 fallback `getHistory`（[index.ts:810](../../../web/src/stores/agents/index.ts#L810)）——**后端已不再发 reset，此分支死代码**。
- 两条重连路径（[App.vue:54-77](../../../web/src/App.vue#L54) 按 `prevStatus` 分流）：
  - 瞬断：`markAllStreamsDirty` + `syncChatEvents`，不 attach/get，靠 ws active-join 重定向。
  - F5/冷启动：`initFromChats` → `attachRunningChats`（[index.ts:503](../../../web/src/stores/agents/index.ts#L503)，sync 之前）→ `syncChatEvents` → 预加载 getHistory。

### 2.2 缓存数组 5 源 6 层去重 ≈ 470 行
- **5 个写入路径同写 `stream.history` 互不知情**：A `chat.get` staged / B `chat.sync` staged / C `done.finalMessage` 内联 / D `role_reply` 内联 / E `sendMessage` 乐观 push。
- **6 层去重/合并**：①staged 幂等 ②done 内联 dedup ③role_reply 内联 dedup ④`doLoadHistory` 合流([index.ts:671-688](../../../web/src/stores/agents/index.ts#L671)) ⑤`dedupHistoryByMsgId`([historyMerge.ts:7-71](../../../web/src/stores/agents/data/historyMerge.ts#L7)) ⑥`mergeChildReplyHistory` A/B 配对([historyMerge.ts:111-203](../../../web/src/stores/agents/data/historyMerge.ts#L111))。
- 一致性补丁：`historyDirty` 全栈传播 + `replayMode` 8 处守卫 + `markAllStreamsDirty` + `inFlightHistory` + WS seq 整流([ws.ts:215-228](../../../web/src/services/ws.ts#L215))。

### 2.3 实时态靠事件推导（`replayMode 'sync'/'resume'`）
- `routeNotification`/`routeChunk`（[streamRouter.ts](../../../web/src/stores/agents/ui/streamRouter.ts)）从**事件顺序**重建 `stream.approval/runningTools/thinking/content`，8 处 `if (replayMode===...)` 守卫（行 114/152/239/276/315/349/367/474/536）。

### 2.4 两口真实显示态缺口（ currentState 要补）
| 显示态 | 当前 | 缺口 |
|--------|------|------|
| 审批气泡/队列 | `interrupt` 事件回放 | park **不发 rejected** → 事件流无法判定存活 → 已 park 审批可能「复活」 |
| smart/manual 工具态 | 无独立事件，只走 approval 气泡 | F5 后 `runningTools` **不含**待审批工具 |

当前前端**零 currentState 消费**（grep 证实）。

---

## 3. 执行路径 F1–F5（低 → 高风险）

> **关键先例**：`applyQuestionSnapshot`（[index.ts:148-173](../../../web/src/stores/agents/index.ts#L148)，`pendingQuestionBatches` 来自 response 的「快照权威 replace」模式）= currentState 接线应**复用的同款模式**。

### F1 — hydration 单一水源 + 重连路径收敛（低风险）
- `syncChatEvents`([index.ts:780](../../../web/src/stores/agents/index.ts#L780))：删 `data.reset → getHistory()` fallback（死代码）。
- `chat.sync(0)` 成为唯一历史+实时水源。`getHistory` 退化为**仅子 chat 合并视图**（group layout 纯前端合并）+ 消息级回填兜底，不再 chat.get staged 重拉。
- 两条重连路径（瞬断 / F5）实时态恢复统一：均由 currentState 快照给定（F2），消除态恢复差异。

### F2 — currentState 快照消费（**核心**，复用 applyQuestionSnapshot 模式）
- [agentApi.ts](../../../web/src/services/agentApi.ts)：`syncChat`(:883)/`attachChat`(:908)/`getChat` response 类型加 `currentState: CurrentStateData`（对齐 [types.ts:1029](../../../src/service/message/types.ts#L1029)）。
- 新增 `applyCurrentState(stream, cs)`（**镜像 [applyQuestionSnapshot:148](../../../web/src/stores/agents/index.ts#L148)**）：权威 replace `stream.approval`(=pendingApproval，含 waitTime/createdAt 倒计时) / `stream.runningTools`(含 smart/manual) / currentTodo。
- sync/attach response 到达后调用 `applyCurrentState`；`routeNotification` 删 `replayMode==='resume'` 下 interrupt/sense_started/accept/rejected 的**实时态重建**分支（改由快照给定）；这些事件仅留实时运行期增量 + 副作用抑制。
- **补齐两口缺口**：审批气泡存活判定 + smart/manual 工具执行态。
- 打字机 content **保留** stream delta（不入快照，单一内容源）。

### F3 — replayMode 收敛（中风险）
- `'sync'`/`'resume'` → 单一「回放中」标记：回放期事件幂等累加进缓存数组 + 抑制副作用 RPC（startSpawn/resumeAgent）+ 抑制终态（done retainUntil / error-bubble）；实时态由 currentState 回放后 apply。
- 删 8 处 `if (replayMode===...)` 守卫（[streamRouter.ts](../../../web/src/stores/agents/ui/streamRouter.ts)）。

### F4 — 缓存数组统一 + 去重栈瘦身（高风险，~470 行 → 大幅缩减）
- 5 源演变（**修订后**）：A `chat.get staged`（loadHistory 模式） + B `chat.sync staged`（replay / attach 模式） + C·D·E（done/role_reply/sendMessage 乐观，实时路径保留，与 B **同形累加** 同 `accumulateStaged` / `pushHistoryItem`）。
- 去重栈瘦身：层①(staged 幂等)保留；层②③(done/role_reply 内联 dedup)简化；层④(doLoadHistory 合流)随主 chat 走 chat.get 独立水源而减；层⑤(dedupHistoryByMsgId)降为防御性可选。
- **M1+M2+M9 修复**（F4 上线后回归）：
  - M1：主 chat loadHistory 改回 `chat.get`（messages 表 retention-independent），放弃「chat.sync(0) 单一水源」的 F4 字面承诺。原方案因 sync(afterSeq) 增量语义 + `afterSeq=wsClient.getLastSeq()` 永不 0，触发刷新后主 chat sync 流返空。
  - M2：`chat.attach` 响应补 `snapshotSeq`（cursor 锚点）；前端 `applyCurrentState` 借此 `resetChatSeq` 推进 cursor。
  - M9：`attachRunningChats` 在 attach 后补 `applyQuestionSnapshot` + `syncOneChat(c, 'replay')`，把 disconnect-window 事件补回。
  - 新增 S17 验收测试 [flowAttachSync.test.ts](../../../test/flows/service/flowAttachSync.test.ts) 锁住 attach + sync 组合行为。
- **层⑥ `mergeChildReplyHistory` A/B 配对保留**：根因是后端 role_reply 注入主 chat 的 `role` 行 vs 子 chat `assistant` 行两条物理记录（数据模型层，非水源问题）；**本期不做**，待后端数据模型统一后再议。
- `stream.history`(已完成轮) + 实时轮 content/thinking → 单一有序数组视图（实时轮 = 末尾 in-progress 项）；[MessageBubble](../../../web/src/features/agent/chat/MessageBubble.vue)/[HistoryDrawerPanel](../../../web/src/features/agent/drawer/HistoryDrawerPanel.vue) 单源渲染。

### F5 — pet 显示态逐态验证（对应 §2.4 + plan §4.2 视角三表）
F1–F4 后逐态手验刷新恢复：审批气泡（原 id 命中 + 存活判定）/ 运行工具（含 smart/manual）/ todo（[TodoPanel.vue:19](../../../web/src/features/agent/cards/TodoPanel.vue#L19) 改读 currentTodo）/ 打字机 / role 气泡 / error·resume。F2 已补两口缺口，预期全充足；若仍缺 → 协议层补 currentState 字段。

---

## 4. 必须遵守的约定（新会话务必先读）

| 约定 | 说明 |
|------|------|
| **改码前先确认需求** | 启动 `structured-requirement-confirmation` 技能确认需求后再改 |
| **Doc-first** | 先改 [docs/web/](./)（pet/rendering/agent-integration），再改码；纯重构/格式化可豁免 |
| **前端验证交用户** | 不跑 vue-tsc/vite build/vitest，改完码即止，用户自验 |
| **封闭开发不做向下兼容** | 新字段直接 required、缺字段直接丢弃/失败；改 schema 后删 `.chery/db/` 重跑 |
| **TSC + lint 门控** | 改 [src/service/message/types.ts](../../../src/service/message/types.ts) 等后端契约 → `pnpm type-check` + `pnpm lint` |
| **预存 TSC 基线**（不计入本次） | 前端 agentApi:261、HistoryDrawer:149；后端 proxy/list.ts、db/chat.ts parseMessageRow |
| **不写左边高亮色条** | 不写 `border-left:Npx solid` 强调/警示，也不用 absolute left:0 色块；改用背景淡化/图标/文案前缀 |
| **web 默认 element-plus** | 全局已 app.use(ElementPlus)，不写原生 input/select |
| **core/agent 必跑测试** | 若触动 src/core 或 src/agent → `pnpm test`（core≥90%/agent≥70%） |
| **web 目录结构** | 每文件夹 ≤5 文件；跨 feature 用 `@/` 绝对路径 |

---

## 5. 参考资源

- **完整分析 + 路径**：`/home/chery/.claude/plans/virtual-splashing-yao.md` §4（核对表 + 三视角影响 + F1–F5 + 文件矩阵 + 验证）
- **memory**：`protocol-hydration-redesign`（后端 G1–G8 + 前端分析结论）、`frontend-verification-user-only`、`closed-dev-no-backward-compat`、`no-left-accent-bar`、`web-element-plus-default`、`web-src-folder-structure`
- **流程测试规约**：[docs/flow-test.md](../flow-test.md)（S1–S16 场景矩阵 + 24 分支覆盖，后端全绿不受前端改动影响）
- **后端 currentState 实现**：[src/service/chat/currentState.ts](../../../src/service/chat/currentState.ts)
- **前端关键文件**：[stores/agents/index.ts](../../../web/src/stores/agents/index.ts)、[ui/streamRouter.ts](../../../web/src/stores/agents/ui/streamRouter.ts)、[data/streamAccumulator.ts](../../../web/src/stores/agents/data/streamAccumulator.ts)、[data/historyMerge.ts](../../../web/src/stores/agents/data/historyMerge.ts)、[stores/agents/types.ts](../../../web/src/stores/agents/types.ts)、[services/agentApi.ts](../../../web/src/services/agentApi.ts)、[App.vue](../../../web/src/App.vue)、[services/ws.ts](../../../web/src/services/ws.ts)

> 行号随代码漂移，**以函数名/symbol 定位为准**（可辅以 codegraph）。

---

## 6. 建议起步

- **优先 F2**（currentState 消费）：收益最大、补两口真实缺口、有 applyQuestionSnapshot 先例可镜像。
- 或按 **F1 → F5** 顺序：F1 先清死代码降低噪声，F2 核心，F3/F4 逐步收敛。
- 每步遵循「doc-first → 确认需求 → 改码 → (触动后端契约则 TSC+lint) → 交用户验证」。
