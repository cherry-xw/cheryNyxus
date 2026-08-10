# 前端组件 ↔ 后端 API 字段绑定手册

> **用途**：锁定每个前端组件**消费**哪些后端 API 字段、**字段如何流入组件、组件在什么场景调什么 RPC**。同时给出**多 agent 场景下的调整策略**——哪些组件需要按 chat 类型（主 / 子 / 孙）切换渲染或交互逻辑。
>
> **不是**：协议字段定义（见 [docs/protocol.md](../protocol.md)）、交互序列样例（见 [docs/interaction.md](../interaction.md)）、R4 重构执行细节（见 [docs/web/frontend-refactor-handoff.md](frontend-refactor-handoff.md)）。
>
> **目标读者**：
> 1. **新会话接手前端** —— 按功能点定位「这个组件该读 store 哪个字段、缺数据时调哪个 RPC」。
> 2. **后端改协议** —— 按组件反查「哪些 API 字段是哪些组件的依赖」，评估改字段的影响面。
> 3. **多 agent 场景扩展** —— 已有组件是否要按 chat 类型分叉 / 新增独立组件 / 复用现有。

> **V2 当前实现覆盖**：前端新增 `web/src/stores/chats` ChatSession 数据层与 root timeline 缓存。
> `agentApi.getRootTimeline({ rootChatId, view })` 消费后端 `chat.timeline.get` 的
> `RootTimelineSnapshot`；HistoryDrawer 的 group 视图从 `TimelineNode.actor/target/direction`
> 映射头像和主→子/子→主样式，工具结果由后端归并。本文后续 `StreamState` / `chat.sync` 表格是
> 兼容期组件的现状，不应覆盖 [multi-agent-canonical-timeline.md](../multi-agent-canonical-timeline.md) 的 V2 契约。

---

## 0. 三层模型

```
后端 API 字段 ──wire (ws.ts) ──▶ store 字段 ──▶ 组件 props / computed
                  ▲                                          │
                  │                                          │
                  └──── store 编排 (agents.index.ts) ────────┘
```

- **wire**：RPC 编解码 + envelope 排序（[`web/src/services/ws.ts`](../../web/src/services/ws.ts)）+ RPC 高层封装（[`web/src/services/agentApi.ts`](../../web/src/services/agentApi.ts)）
- **store**：[`web/src/stores/agents/`](../../web/src/stores/agents/) —— `useAgentsStore` + `StreamState` + `HistoryItem` + `PetInstance`
- **组件**：[`web/src/features/agent/`](../../web/src/features/agent/) + [`web/src/features/pets/`](../../web/src/features/pets/)

**组件不直连 wsClient / 直读 agentApi**，只调 store 上暴露的编排方法（`store.sendMessage` / `store.abort` / `store.getHistory` ...） + 读 store ref/computed。

Nyxus 节点树进一步收紧该边界：`MessageBranchTree` 只读取消息层提供的 root render state，
并 emit 输入、审批和节点交互意图；它不负责打开、关闭或恢复 root subscription。当前被观察的
root 由对话容器通知 `ChatSessionsStore`，消息层保证该 root 只有一个订阅，所有 timeline view
共享该订阅。切换 root 关闭的是观察订阅，不会调用 `chat.abort`，后台 Agent 继续运行。

---

## 1. 核心 store 字段（消费组件的输入源）

### 1.1 `useAgentsStore` 顶层 ref

| ref | 类型 | 来源 RPC | 主要消费组件 |
|-----|------|---------|------------|
| `pets` | `PetInstance[]` | `chat.list` → `initFromChats` + `role_created` push | `PetStage` / `PetSprite` / `PetBubbles` / `PetIcons` / `PetToolbar` |
| `streams` | `Record<chatId, StreamState>` | chunk/notification 路由 + `chat.get`/`chat.sync` staged 累加 | 所有 chat 级视图组件 |
| `allChatsCache` | `ChatSummary[]` | `chat.list`（每次 `doLoadHistory` 刷新） | `HistoryDrawerPanel` 找子 chat / `PetToolbar` 检查 wait-子 |
| `historyList` | `ChatSummary[]` | `chat.list({includePreview:true})` → `fetchHistoryList` | `SessionList`（CP8 会话列表） |
| `senseTools` | `SenseToolInfo[]` | `sense.tools` → `loadSenseMeta` | `RunningTools`（icon）/ `SensesTab`（下拉建议）/ `EquipmentPicker` |
| `senseGroupsResolved` | `{name,senses}[]` | `sense.list` → `loadSenseMeta` | `TodoPanel` 能力判定 / `EquipmentPicker` 能力显示 |

### 1.2 `StreamState` 字段（按组件读取）

完整类型：[`web/src/stores/agents/types.ts:147-215`](../../web/src/stores/agents/types.ts#L147)

| 字段 | 类型 | 写入路径 | 主要消费组件 |
|------|------|---------|------------|
| `thinking` / `content` | string | `routeChunk` stream 累积 / `sendMessage` reset | `PetBubbles`（双气泡打字机） |
| `isWorking` | boolean | `routeChunk` / `routeNotification(done/error)` / `sendMessage`/`resumeAgent`/`startSpawn` 设 true | `PetSprite`（chatting action）/`PetToolbar`（按钮可用性）/`PetIcons`（approval 列） |
| `activeRunId` | string | `sendMessage`/`resumeAgent`/`startSpawn` 设；`done` 清 | `abort(chatId, activeRunId)`（条件 abort） |
| `history` | `HistoryItem[]` | `accumulateStaged` + `pushHistoryItem` + `done.finalMessage` | `HistoryDrawerPanel` / `MessageBubble` / `MessageAvatar` |
| `historyLoaded` | boolean | `loaded` notification 到达 | `HistoryDrawerPanel`（骨架切换） |
| `historyDirty` | boolean | 写动作后设 true；`loaded`/`syncOneChat('loadHistory')` 完 清 false | `getHistory` 缓存守卫（`!dirty && loaded → 零 RPC`） |
| `retainUntil` | number | `done` (+20s) / `error` (+30s) | `PetBubbles`（气泡保留期） |
| `approval` / `approvalQueue` | `ApprovalState` / `[]` | `interrupt` 设 / `accept`/`rejected` 清 / `sendMessage` 移 queue | `ApprovalCard` / `PetIcons` |
| `questionBatches` | `QuestionBatchState[]` | `question_batch_requested` upsert / `completed` 移除 / `applyQuestionSnapshot` replace | `QuestionCard` / `PetIcons`（问号 chip） |
| `runningTools` | `RunningTool[]` | `sense_started` push / `accept` filter / `done` 清 / `applyCurrentState` replace | `RunningTools`（pet bar 右侧 icon） |
| `currentTodo` | unknown[] | `applyCurrentState`（来自 `currentState.currentTodo`） | `TodoPanel`（F5 收口后改读） |
| `error` | string | `routeNotification(error)` / `sendMessage`/`resumeAgent` 终态 | `PetSprite`（error-bubble） |
| `replaying` | boolean | `syncOneChat('replay')` 期间 | 路由层副作用抑制（UI 不读） |

### 1.3 `PetInstance` 字段（按组件读取）

完整类型：[`web/src/features/pets/types/types.ts`](../../web/src/features/pets/types/types.ts)

| 字段 | 类型 | 来源 RPC 字段 | 主要消费组件 |
|------|------|--------------|------------|
| `chatId` | string | `chats.id` / `role_created.data.chatId` | 全局 lookup 锚点 |
| `parentChatId` | string | `chats.parent_chat_id` / `role_created.data.parentChatId` | `HistoryDrawerPanel`（layout=group/direct 切换）/ `PetToolbar`（hasWaitedChild 检测） |
| `isMaster` | boolean | `parentChatId===null` 时为 true | `turnChildIntoGhost`（finished 时排除 master） |
| `name` | string | `chats.metadata.runtime` / `role_created.data.type` | `MessageAvatar.masterText` / `MessageBubble.masterPetName` |
| `face` | emoji | `applyRoleAvatar(generatePet(), role_created.data.avatar)` | `MessageBubble.subPetFace` / `PetSprite` 渲染 |
| `runtime` | `{brain, senseGroup, mcpServers}` | `runtime.set` / `chat.list.metadata.runtime` / `session.runtime.set` | `AgentDialog`（编制选择器预选）/ `MessageAvatar.hover` 详情面板 |
| `isWorking` | boolean | `routeChunk` 设 true / `done` 设 false / `setWorking()` | `PetSprite` / `PetToolbar` |
| `isGhost` | boolean | `turnChildIntoGhost` (finished=true / role_reply) | `PetSprite`（灵魂态 emoji）/`MessageAvatar.subFace` 兜底 |
| `contextUsage` / `contextUsed` / `contextTotal` | number | `done.data.*` / `chat.contextUsage` / `chat.list.includePreview` | `ContextBar` |
| `contextBreakdown` | 6 段 | `done.data.*` / `chat.contextUsage` | `ContextBreakdownTip` |
| `commandConfig` | `CommandConfigDataDto` | `chat.contextUsage.data.commandConfig` | `PetToolbar`（compact 按钮阈值） |
| `canResume` | boolean | `done.data.canResume`（`computeCanResume` 派生）/ `chat.list.canResume` | `PetToolbar`（继续按钮） |
| `workspace` / `workspaceValid` | string / boolean | `chat.list.includePreview` / `chat.get` / `chat.create` | `AgentDialog`（📁 图标）|

---

## 2. 组件 ↔ API 字段绑定表

按功能域分组，每组列出**组件 / 读取的字段 / 写入的字段 / 调用的 RPC**。

### 2.1 启动装配（`App.vue`）

| 组件 | 读取 | 写入 | 调用 RPC |
|------|------|------|---------|
| `App.vue` | `wsClient.status` | — | 启动时 `/api/auth/me` 鉴权；`wsClient.connect()`；通过 `onChunk`/`onNotification` 注入 `agents.routeChunk`/`routeNotification`；`onStatus='connected'` 触发 `agents.initFromChats()`（首次/F5）或 `agents.syncChatEvents()`（瞬断重连） |

### 2.2 创建会话（`AgentFab`）

| 组件 | 读取字段 | 写入字段 | 调用 RPC |
|------|---------|---------|---------|
| `AgentFab` | `connection.status`（门控：仅 `connected` 可点）/ `/api/config` → `presets[]` / `default` | — | `agentApi.createAgent({preset?, brain?, senseGroup?, mcpServers?})` → 创建成功后 `lifecycle.buildMasterAndChildren` → `setWorking(pet, true)` |

**关键字段对照**（[agentApi.ts:842-869](../../web/src/services/agentApi.ts#L842)）：
- `CreateAgentOptions.preset` → 后端 `chat.create({preset})` → `resolvePresetSelection` 解析 `config.roles[leader]` 为 `RuntimeSelection` + `systemPromptFile` + `spawnTypes` + `skillFilter`，全部入 `metadata.runtime`
- `CreateAgentOptions.brain/senseGroup/mcpServers` → 后端 `parseRuntimeSelection` 校验后落 `metadata.runtime`
- 响应 `CreateAgentResult`：`chatId` + 实际生效 `brain/senseGroup/mcpServers/workspace/workspaceValid` → 写 `pet.runtime`

### 2.3 发消息 + 运行时切换（`AgentDialog`）

| 组件 | 读取字段 | 写入字段 | 调用 RPC |
|------|---------|---------|---------|
| `AgentDialog.vue` | `ui.activeDialogChatId` / `pet.runtime` / `pet.contextUsage`/Usage/Total / `pet.contextBreakdown` / `pet.workspace`/`workspaceValid` | `text` ref / `attachments[]` ref | `agents.sendMessage(chatId, text, attachments, runtime?)`（内部：diff → `agentApi.setRuntime` → `agentApi.sendMessage`）|
| `useAgentDialogOptions.ts` | `store.brains` / `store.senseGroups` / `pet.runtime` | 角色卡勾选 → `runtime: RuntimeSelection` | `agents.sendMessage` |
| `RoleConfigPopover.vue` | `brains[]` / `senseGroups[]` / 当前 `selection` | — | 通过 store 暴露的 `setSessionRuntime` 临时调整；持久化走 `sendMessage` 内 `setRuntime` |
| `ContextBreakdownTip.vue` | `contextBreakdown` 6 段 + `commandConfig` | — | — |
| `MediaPreviewBar.vue` | `uploadedMedia[]` | — | `agentApi.uploadMedia`（HTTP）→ 把 `UploadedMediaAsset` 附到 `attachments` |

**关键字段对照**（[agents.index.ts:243-327](../../web/src/stores/agents/index.ts#L243) `sendMessage`）：
- 入参 `runtime?: RuntimeSelection`（仅当与当前 `pet.runtime` 不同才发 `runtime.set`）→ 后端 `runtime.set` → `parseRuntimeSelection` → `configureRuntime`
- 入参 `text` + `attachments: ChatSendAttachment[]` → `chat.send({chatId, prompt, attachments?})` 流式起流
- 响应 `done` promise resolve → `data.userMsgId` 用于替换 stream.history 中的 `tempMsgId` 占位
- 响应 `data.queued: true` → 仅入队，不持有独立事件流，释放 requestMap

**RuntimeSelection 字段来源**：[agentApi.ts:132-137](../../web/src/services/agentApi.ts#L132)
- `brain`: 来自 `brain.list`（`BrainInfo.name`）
- `senseGroup`: 来自 `sense.list`（组名）
- `mcpServers?`: 来自 `brain.list.data.mcpServers`（已连 server 名）+ `runtime.set` / `chat.create` 时校验「必须 connected」

### 2.4 历史抽屉（`HistoryDrawer` / `HistoryDrawerPanel` / `MessageBubble` / `MessageAvatar`）

| 组件 | 读取字段 | 写入字段 | 调用 RPC |
|------|---------|---------|---------|
| `HistoryDrawer.vue` | `manager.stack` | — | `manager.closeTop()`（点遮罩 / ESC）|
| `HistoryDrawerPanel.vue` | `stream.history` / `stream.historyLoaded` / `stream.historyDirty` / `pet.parentChatId`（layout=group/direct 切换）/ `allChatsCache`（找父/子 pet）/ `agents.subagentDisplay`（show/collapse/round 三态） | — | `agents.getHistory(chatId)`（drawer 打开时）→ 内部 `syncOneChat('loadHistory')` + 并行拉所有子 chat |
| `MessageBubble.vue` | `item.role`（5 种）/ `item.thinking` / `item.content` / `item.senseCalls` / `item.senseCalls[].result` / `item.runtime` / `item.msgId` / `item.createdAt` / `item.contextCompaction` / `item.spawnSenseCallId` / `masterPetName` / `subPetName/Face/Type`（从 pets 查） | `showThinking` ref | — |
| `MessageAvatar.vue` | `item.role` / `item.runtime`（hover 详情面板 brain/senseGroup/mcpServers）/ `item.petName`（注入式 role fallback）/ `item.spawnSenseCallId` | — | `@click` 触发 `emit('jumpToSpawn')` → 上抛到 drawer |

**关键字段对照**（HistoryItem role 分流 → MessageBubble 渲染）：
- `role=user` → 真人发言，头像右、气泡左（`row-reverse`），无 hover，无 senseCalls，content 走 `splitCommandPrompt` 拆分
- `role=assistant` → 主 pet 回复，头像左、气泡右，markdown 渲染 content，双气泡（thinking 折叠 + content），senseCalls 渲染
- `role=master` → 主 pet 发给子 pet（合并自子 chat 的 user），头像左、双头像（主 pet 大 + 子 pet 小徽章）
- `role=role` → 子 pet 回复，分两种：
  - 合并式：来自子 chat 的 assistant→role 改写，**带 `subPetChatId` + `callerSubPetChatId`**，UI 据此查 pet face/name
  - 注入式：来自 `role_reply` notification，**无 `subPetChatId`**，但带 `petName=agentType` + `msgId`
- `role=subagent` → 仅旧历史兼容

**`agentChatId` 反向溯源**（[types.ts:87](../../web/src/stores/agents/types.ts#L87)）：
- `history.filter(item => item.agentChatId === X)` 取某 agent 完整 history
- user/assistant = 当前 chatId；role reply = childChatId；**这是组件做子视图的官方字段**

**`msgId` 幂等**（[streamAccumulator.ts:218-247](../../web/src/stores/agents/data/streamAccumulator.ts#L218)）：
- 三源（chat.get staged / 实时 staged / done.finalMessage）按 msgId 命中即就地补字段，不重复 push
- `mergeChildReplyHistory` 按 (createdAt, agentChatId) 配对，不按 msgId（主 chat role:role 行 vs 子 chat assistant→role 改写行 msgId 不重复）

### 2.5 工具栏 + Pet Icons（`PetToolbar` / `PetIcons` / `RunningTools` / `ApprovalCard` / `QuestionCard` / `TodoPanel`）

| 组件 | 读取字段 | 写入字段 | 调用 RPC |
|------|---------|---------|---------|
| `PetToolbar.vue` | `pet.isWorking` / `pet.canResume` / `pet.contextUsed`/`Total` / `pet.commandConfig` / `allChatsCache`（hasWaitedChild 检测） | — | emit `history`/`abort`/`destroy`/`compact`/`resume` → 父组件处理 |
| `PetIcons.vue` | `stream.approval` / `stream.approvalQueue` / `stream.questionBatches` / `stream.activeQuestionId` / `stream.runningTools` | — | 点击 approval → `agents.dismissApproval`；点击 question → `agents.selectQuestion` |
| `RunningTools.vue` | `stream.runningTools` / `stream.questionBatches`（props 传入）/ `chatId`（用于 selectQuestion） | — | 点击 question icon → `agents.selectQuestion(chatId, questionId)` |
| `ApprovalCard.vue` | `props.approval: ApprovalState` / `props.chatId` | — | `agentApi.approval(approvalId, 'accept'\|'reject')`；`agents.dismissApproval`（点 ✕ 移到 queue）|
| `QuestionCard.vue` | `props.question: QuestionItemState` / `props.chatId` / `props.batchInfo`（批次进度） | `selectedLabels` / `otherText` / `pending`（UI 防 race）| `agents.advanceQuestion(chatId, questionId, draft)` / `agents.cancelQuestion` / `agents.backQuestion` |
| `TodoPanel.vue` | `pet.chatId` → `stream.history`（walk back 找 update_todo senseCall 的 args.todos） / `stream.runningTools`（update_todo 是否在跑） | — | — |

**关键字段对照**：

**ApprovalCard**（[types.ts:96-104](../../web/src/stores/agents/types.ts#L96) `ApprovalState`）：
- `approvalId` ← `interrupt.data.approvalId` → `sense.approval({approvalId, action})`
- `waitTime` ← `interrupt.data.waitTime`（= `global.approval_timeout`，0=不限时不显倒计时）
- `createdAt` ← `interrupt.data.createdAt` → 倒计时 = `waitTime - (now - createdAt)`
- `args` ← `interrupt.data.arguments`（JSON 字符串）→ `ParsedArgs` 渲染

**QuestionCard**（[types.ts:113-128](../../web/src/stores/agents/types.ts#L113) `QuestionItemState`）：
- `options: {label, description?}[]` ← `question_batch_requested.data.questions[].options`
- `multiSelect` ← `question_batch_requested.data.questions[].multiSelect`
- `localStatus: 'pending'\|'ready'` ← 前端草稿状态；提交时 `agents.advanceQuestion` 把当前题 `pending→ready`
- `draftAnswer?: {selectedLabels, freeText?, cancelled?}` ← 前端草稿，每次勾选触发 `agents.updateQuestionDraft`
- 整批原子提交 → `agentApi.answerQuestionBatch({chatId, batchId, answers})` → 响应 `shouldResume` → 必要时 `agents.resumeAgent(chatId)`

**RunningTools**（[types.ts:33-36](../../web/src/stores/agents/types.ts#L33) `RunningTool`）：
- `id` ← `sense_started.data.id`（= sense call id）→ `accept.data.approvalId` 命中即 filter 移除
- `name` ← `sense_started.data.senseName` → `agents.iconForTool(name)`（查 `senseTools[]`，fallback ⚙）

**TodoPanel**（[renderers/types.ts:14-32](../../web/src/features/agent/renderers/types.ts#L14)）：
- 当前实现走 `walk back history` 找最近一次 `update_todo` senseCall 的 `args.todos`（[TodoPanel.vue:19-39](../../web/src/features/agent/cards/TodoPanel.vue#L19)）
- **F5 收口后**改读 `stream.currentTodo`（来自 `applyCurrentState` 的 `currentState.currentTodo`）
- 后端 sense `update_todo` 的 schema 在 `src/agent/sense/`，前端类型**手动同步**（[renderers/types.ts:1-10](../../web/src/features/agent/renderers/types.ts#L1) 注释强调）

### 2.6 工具渲染器（`SenseCallBox` + `renderers/`）

完整目录：[`web/src/features/agent/renderers/`](../../web/src/features/agent/renderers/)

| 渲染器 | 工具名 | 参数类型 | 后端 schema |
|--------|-------|---------|-------------|
| `FileReadRenderer.vue` | `read_file` | `ReadFileArgs{path,limit?,offset?,compression?}` | `src/agent/sense/readFile.ts` |
| `FileWriteRenderer.vue` | `write_file` | `WriteFileArgs{path,content,offset?,limit?}` | `src/agent/sense/writeFile.ts` |
| `ExecuteCommandRenderer` | `execute_command` | `ExecuteCommandArgs{command,description}` + `ExecuteCommandResult` | `src/agent/sense/bash.ts` |
| `TodoRenderer.vue` | `update_todo` | `UpdateTodoArgs{todos: TodoItem[]}` | `src/agent/sense/updateTodo.ts` |
| `MediaRenderer.vue` | `generate_image`/`generate_video`/`generate_audio` | `GenerateMediaArgs{prompt}` | `src/agent/sense/generate*.ts` |
| `SearchRenderer.vue` | `search_codebase` | `SearchCodebaseArgs{mode?,path,query,regex?,maxResults?,contextLines?}` | `src/agent/sense/searchCodebase.ts` |
| `SpawnRenderer.vue` | `spawn_role` | `SpawnRoleArgs{type,prompt,wake?}` | `src/agent/sense/spawn.ts` |
| `SkillRenderer.vue` | `skill` | `SkillArgs{name}` | `src/agent/sense/skill.ts` |
| `QuestionRenderer.vue` | `ask_user_question` | （旧协议，已被 question_batch 替代） | `src/agent/sense/ask.ts` |

**关键字段**（[renderers/types.ts:164-171](../../web/src/features/agent/renderers/types.ts#L164) `RendererProps`）：
- `call: SenseCallRecord` ← `accumulateStaged` + `accept` 写入的 `args` + `result`
- `parsedArgs?` ← 渲染器分发器预处理（[registry.ts](../../web/src/features/agent/renderers/registry.ts)）
- 渲染器**只渲染，不发 RPC、不改 store**（types.ts 注释硬约束）

### 2.7 续跑 + 中止 + 压缩（`PetToolbar` → store）

| 操作 | 触发组件 | store 编排 | RPC |
|------|---------|-----------|-----|
| 继续 | `PetToolbar` emit `resume` → 上抛到父 | `agents.resumeAgent(chatId)` → `agentApi.resumeChat(chatId)` | `chat.resume`（流式，无 prompt）|
| 中止 | `PetToolbar` emit `abort` → `agents.abort(chatId)` | `agentApi.abortAgent(chatId, stream.activeRunId)` → 手动清工作态 + 级联清后代 | `chat.abort` |
| 隐藏 | `PetToolbar` emit `destroy` → `agents.hide(chatId)` | `removePetsOnly` + 关闭 drawer 栈 | —（前端 hide，非 chat.delete） |
| 真删 | `SessionList` ✕ → `agents.deleteSession(chatId)` | `removePetsAndStreams` + `agentApi.destroyAgent(chatId)`（后端级联子 chat）| `chat.delete` |
| 压缩 | `PetToolbar` emit `compact` → `agents.compactHistory(chatId)` | 发 `[[command:/compact]]` 走 `chat.send` | `chat.send`（特殊 prompt）|

**PetToolbar 按钮显示门控**（[PetToolbar.vue:97-104](../../web/src/features/agent/toolbar/PetToolbar.vue#L97)）：
- `showResume`：非 working + `canResume=true` + **无未完成子**（`allChatsCache.some(c => c.parentChatId === pet.chatId && c.finished !== true)`）
- `showCompact`：`compactAvailable`（`contextTotal ≥ commandConfig.minContextLimit`）+ `contextUsage ≥ warn`
- `compactUrgent`：`contextUsage ≥ auto`（高亮脉冲；后端此时自动压缩）

### 2.8 会话列表（`SessionList`）

| 组件 | 读取字段 | 写入字段 | 调用 RPC |
|------|---------|---------|---------|
| `SessionList.vue` | `historyList`（已 includePreview）/ `ui.historyListOpen` | — | `agents.fetchHistoryList()`（打开时）→ `agentApi.listChats(true)` |
| `SessionListItem.vue`（内含）| `ChatSummary.{preview, turnCount, contextUsage, contextBreakdown, parentChatId, finished, canResume, workspace}` | — | 点 ✕ → `agents.deleteSession(chatId)` → `agentApi.destroyAgent` |

### 2.9 设置面板（`SettingsDialog` + 10 个 tab）

| 组件 | 读取字段 | 写入字段 | 调用 RPC |
|------|---------|---------|---------|
| `SettingsDialog.vue` | `agents.settingsOpen` | local `draft: ConfigDto` / `workspaceWarnings` / `hooksTabRef.draft` | `agentApi.getConfig()` / `agentApi.saveConfig(draft)` / `agentApi.saveHooks(handlers)` / `agentApi.openConfigDir()` |
| `BrainsTab.vue` | `llm.brain` / `default.brain` / `envVars`（密钥下拉） / `utils.thinkingLevels()` | — | `agentApi.testConnection()` / `agentApi.fetchModels()` |
| `SensesTab.vue` | `senseGroups` / `senseTools` / 内置工具元信息 | — | `agentApi.listSenseTools()`（已 cache）/ `agentApi.listSenseGroups()` |
| `RolesTab.vue` | `roles.*` / `presets.*` / `plugins` / `skillNames` | — | `agentApi.listPlugins()` / `agentApi.listSkillNames()` |
| `PresetsTab.vue` | `presets` / `workspaceWarnings` | — | `agentApi.validateWorkspace(workspace)`（每次输入即时校验，seq 守卫） |
| `SkillsTab.vue` | `skills` / `skillSources` | — | `agentApi.listSkills` / `listSkillSources` / `checkSource` / `checkAllSources` / `resyncSource` / `resyncAllSources` / `preImportSkillUrl` / `importSkillUrl` / `commitSkillImport` / `deleteSkill` / `deleteSkillSource` / `importSkillZip`（HTTP）|
| `PluginsTab.vue` | `plugins` | — | `agentApi.listPlugins` / `preImportPluginUrl` / `importPluginUrl` / `commitPlugin` / `checkPluginUpdate` / `checkAllPluginsUpdate` / `updatePlugin` / `uninstallPlugin` |
| `McpTab.vue` | `mcp_servers`（config 内）/ `mcp.list` 实时状态 | — | `agentApi.listMcp` / `getMcp` / `connectMcp` / `disconnectMcp` / `reloadMcp` |
| `GlobalTab.vue` | `global.*`（thinking/supervision/stream/approval_timeout/watcher/command/logger） | — | — |
| `CommandsTab.vue` | `command.list` | — | `agentApi.listCommands` |
| `HooksTab.vue` | `hooks.get` | local `draft: Record<event, HooksHandlerDTO[]>` | `agentApi.getHooks` / `agentApi.getHookEvents` / `agentApi.saveHooks(draft)` |

### 2.10 子 agent 视图（`SpawnRenderer` / `PetIcons` 的 ghost icon）

| 组件 | 读取字段 | 写入字段 | 调用 RPC |
|------|---------|---------|---------|
| `SpawnRenderer.vue`（在 `SenseCallBox` 内）| `senseCalls[].args.type/prompt/wake` + `args.roleReply`（如已注入）/ `pet.parentChatId`（找父）/ `allChatsCache`（找子） | — | 点击「详情」→ `manager.push(chatId)` 打开子 chat 自身 drawer（layout=direct） |
| `PetIcons.vue` 的 ghost 列 | `pet.isGhost` / `pet.parentChatId` | — | 点击 ghost icon → drawer 打开 |

**关键字段对照**（`role_created` 触发路径）：
- 后端 `role_created.data: {taskId, chatId:child, parentChatId, type, prompt, brain, senseGroup, wake}` → `streamRouter.routeNotification` → `pets.value.push(createPetInstance(...))` + `allChatsCache.push({chatId:child, parentChatId})`
- `wake ∈ 'immediate' \| 'deferred' \| 'barrier'`：UI 全部走「子 pet 显示在主 pet 旁边」同一渲染；区别在后端 wakeScheduler 决定何时 role_reply
- 子 agent **eager 已启动**（后端 spawn_role sense 内 fire-and-forget），前端 role_created 到达时 chunks 可能在路上：若 `subStream.isWorking \|\| subStream.thinking/content 非空` → 跳过 `chat.startSpawn` RPC（防止覆盖累积）

---

## 3. 多 agent 场景下的组件调整策略

> 目标：评估「涉及多 agent」的新功能点时，**哪些组件需要按 chat 类型分叉**，哪些**复用现有组件 + 加 layout 参数**，哪些**必须新增独立组件**。

### 3.1 chat 类型分类（决定组件是否分叉）

| 类型 | 判定 | 特点 |
|------|------|------|
| **主 chat** | `pet.parentChatId === null` | 持久化、`chat.list` 排序、ContextBar 显示、可 hide 可真删 |
| **子 chat（直接）** | `pet.parentChatId === thisChat` | 由 `role_created` 创建；finished 后转 ghost；drawer 直接打开自身（layout=direct）|
| **孙 chat（间接）** | `pet.parentChatId` 至少 2 层 | 罕见但支持（A→B→C）；显示路径需递归查 caller |

### 3.2 现有组件的 chat 类型敏感性矩阵

| 组件 | 主 chat | 子 chat | 孙 chat | 调整策略 |
|------|---------|---------|---------|---------|
| `PetSprite` / `PetBody` | ✅ 完整功能 | ✅ 完整功能 | ✅ 完整功能 | **不分叉** — 共用渲染，按 `isMaster` 决定 ghost 排除 |
| `PetToolbar` | ✅ 全部按钮 | ⚠️ **无继续按钮**（showResume 要求 `canResume=true` 且无 wait-子；子 chat 通常 finished=true 故不显） | ⚠️ 同子 | **不分叉** — computed 自动门控 |
| `PetIcons` approval 列 | ✅ | ⚠️ 子 chat 通常无 pending 审批（spawn_role sense 内直接 eager 跑）| 同 | **不分叉** |
| `HistoryDrawerPanel` layout | `group` | `direct` | `direct` | **不分叉** — `pet.parentChatId` 驱动 layout computed（[HistoryDrawerPanel.vue:89](../../web/src/features/agent/drawer/HistoryDrawerPanel.vue#L89)）|
| `MessageBubble` 双头像 | `masterPetName` 来自当前 pet | `subPetName` 来自 `item.subPetChatId` 查 pets | 同子 + `callerPetName` | **不分叉** — props 透传即可，合并式/注入式 role 共用同一渲染（[MessageBubble.vue:23-44](../../web/src/features/agent/chat/MessageBubble.vue#L23)）|
| `MessageAvatar` hover 面板 | `masterPetName` + 当前 pet runtime | `subPetName` + caller pet（来自 `item.callerSubPetChatId`）| 同子 | **不分叉** — props 透传 |
| `AgentDialog` 编制 | ✅ 主 pet runtime | ❌ **不渲染**（子 pet 无 drawer 入口）| ❌ | **不渲染** — `AgentDialog` 仅 `activeDialogChatId` 为主 chat 时 mount |
| `ApprovalCard` | ✅ | ⚠️ | ⚠️ | **不分叉** — `PetBubbles` 按 `stream.approval` 自动渲染 |
| `QuestionCard` | ✅ | ⚠️ | ⚠️ | **不分叉** |
| `RunningTools` | ✅ | ✅（含 update_todo）| ✅ | **不分叉** |
| `TodoPanel` | ✅ 主 pet todo | ✅ 子 pet todo（独立 senseCall）| ✅ | **不分叉** — 各自 chat 的 update_todo 独立累积 |
| `ContextBar` | ✅ | ❌ **不渲染**（子 pet 无 contextUsage 字段，类型兜底 0）| ❌ | **不渲染** — 仅主 pet ContextBar 显（[petLifecycle](../../web/src/stores/agents/data/petLifecycle.ts) `buildMasterAndChildren` 不给子 pet 赋 contextUsage）|
| `SessionList` | ✅ | ⚠️ 仅显主 chat（按 `parentChatId===null` 过滤）| ⚠️ | **不渲染** — 子 chat 在主 chat 抽屉合并视图，不进 SessionList |
| `SettingsDialog` | ❌ 与 chat 无关 | ❌ | ❌ | — |

**结论**：当前**几乎没有组件需要按 chat 类型分叉** —— 现有 props 透传 + computed 门控 + drawer 栈布局 已覆盖多 agent 渲染差异。**新功能点要扩多 agent 时，优先考虑「加 props / 加 computed 门控」而非「拆组件」**。

### 3.3 多级 spawn（A→B→C）的特殊处理点

[A→B→C] 场景在 [types.ts:60-63](../../web/src/stores/agents/types.ts#L60) `callerSubPetChatId` 已支持：

| 场景 | 行为 |
|------|------|
| B 完成 role_reply 注入主 chat | `pushHistoryItem({role:'role', subPetChatId: B, callerSubPetChatId: A, ...})` |
| 主 chat drawer 渲染 | group layout，B 头像左、A 小徽章右；hover 面板 name=A（caller 优先于 sub）|
| B 自身 drawer（layout=direct）| 仅显 B 的 own history（chat.get + remapChildHistory 不递归）；A 的存在仅 metadata.spawnSenseCallId |
| C 完成回 B | B 的 history 中有 `role:'role'` 行，`subPetChatId=C, callerSubPetChatId=B`，由 `mergeChildReplyHistory` 把 C 的 history 按 createdAt 合流到 B 主视图 |

**新功能点扩展注意**：
- 新增「孙 chat 单独 drawer 入口」：复用 `SpawnRenderer`（已在子 chat 的 spawn_role 卡内可下钻），无需新组件
- 新增「多级 call graph 视图」：**必须新增独立组件**（无现有等价物），依赖 `subPetChatId`/`callerSubPetChatId` 递归

### 3.4 子 agent finished/ghost 的视觉一致性

| 状态 | 视觉 | 切换触发 |
|------|------|---------|
| Running（working=true）| PetSprite chatting action + pet bar 右侧 RunningTools icon | `routeChunk` 设 `pet.isWorking=true` |
| Finished（finished=true）| PetSprite 灵魂态（ghost emoji + 半透明）| `done.data.finished===true` → `turnChildIntoGhost(pet)` |
| Ghost from role_reply | 同上（兜底修复 finished 缺失历史） | `routeNotification(role_reply)` → `turnChildIntoGhost(subPetChatId)` |

**`isGhost` 跨 chat 一致**：`turnChildIntoGhost` 按 pet 内存引用更新；刷新后靠 `chat.list.finished` 重建（[petLifecycle](../../web/src/stores/agents/data/petLifecycle.ts)）。

### 3.5 多 agent 数据合流的语义层

**F4 单一缓存数组不变式**：[types.ts:153-161](../../web/src/stores/agents/types.ts#L153)
- 主 chat drawer（group）：合并主 + 所有后代 chat 的 history（按 createdAt 排序 + msgId 去重）
- 子 chat drawer（direct）：仅该 chat 的 own history（**不递归合流**）
- 孙 chat drawer（direct）：仅该 chat 的 own history（**不递归合流 C 的子 D**）

**`mergeChildReplyHistory` 合并规则**（[historyMerge.ts](../../web/src/stores/agents/data/historyMerge.ts)）：
- 按 `(createdAt, agentChatId)` 配对，把子 chat 的 assistant→role 改写行插入主 chat 时间线
- **不**按 msgId（主 chat 的 role:role 行 vs 子 chat 的 assistant→role 改写行 msgId 不同）
- 仅 layout=group 触发

### 3.6 新功能点的多 agent 评估清单（模板）

> 加新功能时按此清单逐项评估，影响 > 1 项 → 拆链接 / 派 subagent。

| 检查项 | 影响范围 |
|--------|---------|
| 字段读：是否需要读子 chat 字段？ | 如 `agentChatId === X` 过滤；无需新组件 |
| 字段读：是否需要读孙 chat 字段？ | 需 `collectDescendantChatIds` 递归；评估要不要新增 `descendantsOf(chatId)` getter |
| RPC 调：是否要主动向子 chat 发 RPC？ | 如 `runtime.set(子)` → 用 `agentApi.setRuntime(childChatId, ...)`；无需新组件 |
| RPC 调：是否要主动向孙 chat 发 RPC？ | 同上 |
| 渲染：是否要单独显示子 chat 视图？ | 现有 `HistoryDrawerPanel` (layout=direct) 已支持；无需新组件 |
| 渲染：是否要单独显示孙 chat 视图？ | 同上 |
| 渲染：是否要 call graph 视图（A→B→C）？ | **必须新增组件**，无现有等价物 |
| 视觉：子 pet 是否需要新 idle/working/finished 状态？ | `turnChildIntoGhost` 已支持 finished→ghost；如要加新状态改 `PetSprite` + 调 `setWorking` 语义 |
| 数据：是否要合并多 chat 的某字段（如合并孙 chat 的 todo）？ | **新增 stream getter**（如 `mergedTodosOf(chatId)`），不要在组件内 walk history |
| 跨 agent 通信：是否要 A→B→C 链式传消息？ | 后端 wakeScheduler 已支持 deferred/barrier；前端 `role_reply.notification` 已路由；**不新增前端组件** |

---

## 4. 实现功能点时的信息完备性核查清单

> 加新功能时按此清单**逐项核对**，避免「字段未读到」「RPC 未调」「多 agent 分叉遗漏」导致的返工。

### 4.1 数据源完备性

| 问 | 答案写在 |
|----|---------|
| 需要读后端哪些字段？ | 标到本手册 §1 + §2 的字段表 |
| 字段当前是否已经到前端 store？ | 查 §1 StreamState/PetInstance 表 |
| 若未到，是否需要新 RPC？ | 查后端 handler 是否暴露，必要时扩 `agentApi` |
| 字段类型在前端是 union 还是 enum？ | 查 [agentApi.ts types](../../web/src/services/agentApi.ts) 与 [types.ts](../../web/src/stores/agents/types.ts) |

### 4.2 多 agent 完备性

| 问 | 答案写在 |
|----|---------|
| 此功能是否对主/子/孙 chat 行为不同？ | 查 §3.2 矩阵；若 3 行都 ✅ → 不分叉；若有 ⚠️/❌ → 按表内策略处理 |
| 是否需要读子 chat 字段？ | 用 `stream[childChatId]` / `allChatsCache.find` / `pets.find` |
| 是否需要向子 chat 发 RPC？ | `agentApi.xxx(childChatId, ...)` |
| 是否需要合并多 chat 数据？ | 用 `collectDescendantChatIds` + 现有合并函数，或新增 `mergedXxxOf` |
| 子 chat finished 后行为是否要变？ | 走 `isGhost` / `stream.finished` 分支 |
| 多级 spawn (A→B→C) 是否要考虑？ | 查 `callerSubPetChatId` 字段是否需要读写 |

### 4.3 渲染完备性

| 问 | 答案写在 |
|----|---------|
| 组件读哪些 store 字段？ | 列 props/computed |
| 组件发哪些 store 动作？ | 列 emits + 内部调用 |
| 组件是否要发 RPC？ | 一般**不**（仅 store 编排）；如要发必查权限/门控 |
| 组件是否要调 drawer 栈？ | 用 `useHistoryDrawerManager()` 的 `push(chatId)` / `closeTop()` |
| 组件是否要门控（working/dirty/loaded）？ | 查同类组件已有 computed（如 `compactAvailable`/`showResume`）|

### 4.4 测试完备性

| 问 | 答案写在 |
|----|---------|
| 后端契约是否需要 vitest 流程测试？ | 加 `test/flows/service/flowXxx.test.ts`（见 [docs/flow-test.md](../flow-test.md)）|
| 前端 store 字段是否需要单测？ | `web/test/agents/` 已有 streamAccumulator/approvalQueue/historyRendering；新增字段按同模式加 |
| 前端组件是否需要测？ | 当前无组件层测试；仅 store 单测覆盖 |
| 多 agent 场景是否有专门 case？ | 子 chat finished 状态、子 chat resume 主唤起、孙 chat 路径 |

---

## 5. 关键文件速查

| 文件 | 用途 |
|------|------|
| [`web/src/App.vue`](../../web/src/App.vue) | 装配入口：wsClient 订阅 → agents.routeChunk/routeNotification → onStatus 触发 init/sync |
| [`web/src/services/ws.ts`](../../web/src/services/ws.ts) | WS client：rpc / rpcTrack / onChunk / onNotification / chatSeq 单调游标 |
| [`web/src/services/agentApi.ts`](../../web/src/services/agentApi.ts) | RPC 高层封装 + 类型（ChatSummary / CurrentStateData / RuntimeSelection / ChatSendAttachment ...）|
| [`web/src/stores/agents/index.ts`](../../web/src/stores/agents/index.ts) | Pinia store 主入口：sendMessage / resumeAgent / startSpawn / getHistory / abort / applyCurrentState / applyQuestionSnapshot |
| [`web/src/stores/agents/ui/streamRouter.ts`](../../web/src/stores/agents/ui/streamRouter.ts) | chunk/notification 路由 + replaying 抑制 |
| [`web/src/stores/agents/data/streamAccumulator.ts`](../../web/src/stores/agents/data/streamAccumulator.ts) | `accumulateStaged` / `pushHistoryItem`（msgId 幂等去重轴）|
| [`web/src/stores/agents/data/historyMerge.ts`](../../web/src/stores/agents/data/historyMerge.ts) | `mergeChildReplyHistory`（按 createdAt+agentChatId 配对）/ `collectDescendantChatIds` |
| [`web/src/stores/agents/actions/questionBatch.ts`](../../web/src/stores/agents/actions/questionBatch.ts) | `replaceQuestionBatches` / `upsertQuestionBatch` / `findQuestion` |
| [`web/src/stores/agents/types.ts`](../../web/src/stores/agents/types.ts) | 公共类型：StreamState / HistoryItem / ApprovalState / QuestionBatchState / ChunkMessage / NotificationMessage |
| [`web/src/features/agent/AgentFab.vue`](../../web/src/features/agent/AgentFab.vue) | 创建会话入口（preset/brain/senseGroup/mcpServers）|
| [`web/src/features/agent/chat/AgentDialog.vue`](../../web/src/features/agent/chat/AgentDialog.vue) + `dialog/useAgentDialogOptions.ts` | 发消息 + 临时编制切换 |
| [`web/src/features/agent/drawer/HistoryDrawerPanel.vue`](../../web/src/features/agent/drawer/HistoryDrawerPanel.vue) | 历史抽屉：layout=group/direct 切换 |
| [`web/src/features/agent/chat/MessageBubble.vue`](../../web/src/features/agent/chat/MessageBubble.vue) + `MessageAvatar.vue` | 消息渲染（5 种 role）|
| [`web/src/features/agent/cards/ApprovalCard.vue`](../../web/src/features/agent/cards/ApprovalCard.vue) + `QuestionCard.vue` + `RunningTools.vue` + `TodoPanel.vue` | 工具栏卡片（审批/提问/工具/todo）|
| [`web/src/features/agent/toolbar/PetToolbar.vue`](../../web/src/features/agent/toolbar/PetToolbar.vue) | pet 工具栏（继续/中止/隐藏/压缩）|
| [`web/src/features/agent/renderers/`](../../web/src/features/agent/renderers/) | 工具渲染器（按 sense name 分发）|
| [`web/src/features/agent/settings/SettingsDialog.vue`](../../web/src/features/agent/settings/SettingsDialog.vue) + 10 tabs | 设置面板 |

> 行号随代码漂移，**以函数名/symbol 定位为准**。

---

## 6. 不在本手册范围

- 协议字段定义 / wire 格式 / 错误码全集 —— [docs/protocol.md](../protocol.md)
- 端到端交互序列样例 —— [docs/interaction.md](../interaction.md)
- F1-F5 重构执行细节 —— [docs/web/frontend-refactor-handoff.md](frontend-refactor-handoff.md)
- 后端 Middleware / Sense / Provider 实现 —— [docs/agent/](../agent/) + [docs/core/](../core/)
- 多 agent 唤醒策略（immediate/deferred/barrier）—— [docs/agent-pet.md §5.4](../agent-pet.md)
- WS 服务端实现 —— [docs/service/websocket.md](../service/websocket.md)

---

## 7. 参考资源

- 协议规范：[docs/protocol.md](../protocol.md)
- 交互序列：[docs/interaction.md](../interaction.md)
- 流程测试：[docs/flow-test.md](../flow-test.md)
- Agent-pet 唤醒策略：[docs/agent-pet.md](../agent-pet.md)
- Sub-agent Live Stream（spawn_role eager 启动）：[docs/agent-pet.md §5.4](../agent-pet.md) + 本手册 §2.10
- WebSocket 服务端：[docs/service/websocket.md](../service/websocket.md)
- F1-F5 前端重构：[docs/web/frontend-refactor-handoff.md](frontend-refactor-handoff.md)
