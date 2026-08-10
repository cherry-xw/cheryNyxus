# agent 接入（CP1-CP8，已落地）

> 上级 [README.md](./README.md) ｜ 跨前后端设计 [../../agent-pet.md](../../agent-pet.md) ｜ 渲染分层 [rendering.md](./rendering.md)

pet 模块已由纯装饰桌宠改造为 **主从 Agent 可视化交互系统**（整体设计见 [../../agent-pet.md](../../agent-pet.md)）。CP1-CP8 为历史演进记录；当前数据边界以“ChatSession 单一数据层”一节为准。

## ChatSession 单一数据层

前端按 `chatId` 维护唯一 `ChatSession`，统一保存本 chat 的消息、实时运行态、审批/问题、runtime、上下文用量和工作区投影。Pet 只保留动作、位置、表情、拖拽、ghost 动画等展示状态，以及关联用 `chatId`；`isWorking`、runtime/context、canResume、workspace 不再以 Pet 字段作为权威值。

```text
后端 chat.list/chat.sync + WebSocket event
  → ChatSession reducer（唯一写入口，seq + msgId 幂等）
    → Pet selector（实时气泡 / busy / toolbar / context）
    → History selector（本 chat / 主子群聊时间线）
    → Session selector（会话目录）
```

消息按 `msgId` 规范化存储，`activeMessageId` 只指向当前 LLM 响应；Pet 气泡和 HistoryDrawer 渲染同一个消息对象。一个 send/resume 的 `runId` 可以包含多次工具循环，每次 LLM 响应都有独立 `msgId`。新 `msgId` 首个 delta 到达时，旧 active 消息封口并留在历史，新消息从空内容开始累积，Pet 立即切换，HistoryDrawer 同步显示服务端 delta 形成的打字效果。

每个 ChatSession 只保存自身物理消息。主 chat 的群聊历史由 selector 动态读取 root 和 descendants 后做角色重映射、按时间排序；禁止把 child 消息复制进 parent history。消息重复在 reducer 入口用 `seq` 和 `msgId` 阻止，展示层不再依赖 reload 或多层 dedup 修复。

### Pet 投影边界

`ChatSessionStore.sessionsById` 是主从关系、角色身份、运行态与交互态的唯一权威来源。Pet 舞台不得把 `role_created` 当作唯一的“创建子 pet”命令：它只能促使会话 catalog 更新；舞台随后按会话树幂等对账，补建缺失的视觉实例并将已完成的子实例转为 ghost。这样事件重放、快照恢复或事件暂缺都不会造成“历史已有子会话、舞台没有子 pet”。

Pet 实例只拥有不可由会话推导的视觉状态：位置、目标位置、速度、拖拽、hover、表情及 ghost 动画时间。审批、运行中工具、ask_user_question 批次、todo、消息气泡、runtime、上下文与可继续状态必须从 ChatSession selector 投影；pet 组件发出的操作委托 ChatSession action，再由该 action 调 RPC。

启动只完整 hydration 舞台最近 5 个主 chat 及其全部后代；其他会话只建立 catalog 实体，用户从 SessionList 加载时原位升级。running chat 遵循 `attach → sync`：attach 只重定向后续实时输出，不提前跳过 cursor；sync 从本地 cursor（冷启动为 0）补齐历史和当前实时消息，再在 `snapshotSeq` 边界应用 currentState/question/session metadata。HistoryDrawer、Pet hover、SessionList 打开均不触发 `chat.get`，只消费已构建实体。

> “完整上下文”在前端仅指 UI 会话投影。system prompt、memory、skills、tools 和压缩后的 LLM 上下文仍由后端 `AgentBuilder` 独占构建。

## 工具栏（CP1 去装饰记录）

> **CP1 移除装饰工具栏**：原 `pet/feed/sleep/dismiss/summon` 装饰工具及 `invokeTool`/`masterTools`/`PetStage toolbar`（+pet/pause/reset/mood）已删（见下 [CP1](#cp1接线骨架--去装饰化)）。CP2 起工具栏由 [PetToolbar](../../../web/src/features/agent/PetToolbar.vue) 组件承担 agent 操作（历史/中止/销毁，非装饰交互）。下文为 CP1 前装饰工具栏的设计记录（CSS `.tools`/`.tool-icon` 已置 `display:none`）。

- 名字后 icon 行：`core` 工具常驻（第一行，name 旁）；非 core 默认隐藏，悬浮 `.tools` 时在**第二行居中**展开（`.tools-extra`，与第一行保持间距，`opacity`/`transform` 过渡）。**隐藏延迟 240ms**（`scheduleCloseTools` 定时器），便于鼠标从第一行移到第二行不被中断。原 ⋯ 切换按钮已移除（不再支持触屏点切）。
- 每 icon hover 显示 `label`（CSS `.tip` tooltip，无 element-plus 依赖）。
- 点击 emit `tool` 事件 → `usePetWorld.invokeTool(pet, toolId)`：
  - `pet`→happy+emotion、`feed`→happy+emotion+台词、`sleep`→触发休息（`punch` 工具随 pump preset 拆解退役，无 pet 持有；`invokeTool` 的 punch case 保留为无害死代码）
  - `dismiss`→removePet（任意 pet 可驱逐，无特权保护）
  - `summon`→`summonSub(pet)`（仅主 pet 工具列有 summon，召子入本部落）
- **工具 ↔ agent 能力**：当前工具为养桌宠交互语义；未来 pet 作为 agent 显示层时，`invokeTool` 改为消费后端 RPC（工具=agent 能力 UI 入口）。

## 落地清单（按 CP）

### CP1（接线骨架 + 去装饰化）

- **PetInstance 扩字段**（[types.ts](../../../web/src/features/pets/types.ts)）：`chatId` / `parentChatId?` / `agentType?` / `isWorking` / `contextUsage` / `runtime?`（`RuntimeSelection`：brain+senseGroup+mcpServers，主 pet 由 `createMasterPet` 设、子 pet 由 `role_created` 设、AgentDialog `runtime.set` 后同步；刷新后丢失）。pet = agent 可视化躯壳。
- **状态层单一数据源**（[stores/agents.ts](../../../web/src/stores/agents.ts)）：`pets: PetInstance[]` 由 chat.list + chunk/notification 驱动；`streams: Record<chatId, StreamState>` 按 requestId→chatId 路由 chunk。runtime 挂 pet（`pet.runtime`），`getRuntime(chatId)` 从 pet 取。
- **连接接线**（[main.ts](../../../web/src/main.ts) / [App.vue](../../../web/src/App.vue)）：挂 Pinia + onMounted 调 `useConnectionStore().init()` + 订阅 `wsClient.onChunk`/`onNotification` 转发 agents store。
- **RPC 封装**（[services/agentApi.ts](../../../web/src/services/agentApi.ts)）：基于 wsClient.rpc 封装 chat.create/list/get/send/resume/abort/delete、runtime.set、sense.approval、brain.list + `/api/config` 缓存（`fetchServerConfig` / `fetchDefaultRuntime`）。
- **去装饰化**（[usePetWorld.ts](../../../web/src/features/pets/usePetWorld.ts) / [PetStage.vue](../../../web/src/features/pets/PetStage.vue)）：删 `invokeTool` 装饰分支 / pet 间 chatting / `randomEmotion` / `addPet`/`summonSub` / PetStage toolbar（+pet/pause/reset/mood）/ `resetPets` 自动刷主子；`pets` 改读 agents store（单一数据源）。

### CP2（FAB + 对话 + 双气泡 + ContextBar + PetToolbar）

- **NyxusCore**（[NyxusCore.vue](../../../web/src/features/pets/components/NyxusCore.vue)，原 AgentFab）：nyxus 独立核心（脱离 pet 体系，详见 [rendering.md](./rendering.md) §nyxus 独立核心），工具环 create 按钮点击先 `fetchServerConfig` 取 `presets`（T6）并弹预设选择器（每项显 name + leader 角色的 brain + 角色数）；选预设 → `createMasterPet({preset})`（后端通过 `presets[name].leader` 引用的角色解析编制快照）；无可用预设时不能创建主 pet；非 connected 禁用。
- **AgentDialog**（[AgentDialog.vue](../../../web/src/features/agent/AgentDialog.vue)）：overlay + panel 弹窗。弹窗按当前小组以“组长优先”的顺序列出带主/成员图标的两行紧凑角色摘要：首行显示角色名与完整当前模型，次行显示当前感官组 icon；点击后在更宽的横向角色名片中查看配置。名片展示模型、思考、上下文、Tool Call 状态及图片/视频/音频输入和生成徽标。大脑选择项显示完整 `model` 名；临时切换到 `toolCall:false` 模型会清空并隐藏感官选择，按仅对话编制提交，切回支持工具的模型才可再选感官。图片/视频/音频上传入口会先检查当前临时 brain 的 `capabilities.input`，通过后上传至 `/api/media/upload` 并把受控资产引用加入本轮消息。选择经 `session.runtime.set` 写入内存态且不改会话默认配置；`Cmd/Ctrl+Enter` 发送、`Esc` 关闭、点遮罩关闭。完整能力规则见 [../../model-capabilities.md](../../model-capabilities.md)。
- **ContextBar**（[ContextBar.vue](../../../web/src/features/agent/ContextBar.vue)）：contextUsage 0-1 progressbar，色阶：<50% 绿 / 50-80% 黄 / ≥80% 红。
- **PetToolbar**（[PetToolbar.vue](../../../web/src/features/agent/PetToolbar.vue)）：主 pet = 历史/中止/隐藏（✕ destroy=hide，CP8）；子 pet = 历史/中止（无隐藏）；contextUsage ≥ 50% 显 compact（预留）。中止按钮 `:disabled="!pet.isWorking"`——非工作态灰显不可点。**隐藏按钮 `:disabled="pet.isWorking || hasWorkingChild"`**（CP8）——运行中或任一子 pet 运行中禁用（避免孤儿流）。
- **PetSprite 双气泡**（[PetSprite.vue](../../../web/src/features/pets/PetSprite.vue)）：thinking 阶段（content 空）主气泡全空间显 thinking；thinking 结束（content 非空）主气泡显 content + 左侧独立小气泡显 thinking。
- **工作态 action=chatting**：`setWorking` 切 `pet.action="chatting"`（复用现有 chatting motion，不新增 action）+ `mood="curious"` + `interactionUntil=0`（agent 工作态不超时，由 done/error 解除）。
- **sendMessage action**（agents store）：runtime diff 决策（与当前 runtime 异 → 先 `agentApi.setRuntime` 再 send，同则直发）；发送后重置 stream 实时累积 + 清 pending approval + pet 进 isWorking；`runtime.set` 后同步 `pet.runtime`。

### CP3（spawn_role 后端 eager 启动，**不再前端驱动**）

- **后端 eager 启动**（2026-07-23 收敛）：spawn_role sense 完成时**同步** fire-and-forget 触发 `runChildTaskInBackground`（[spawnEager.ts](../../../src/service/chat/spawnEager.ts)）→ handleChatStartSpawn claim + handleChatSend 绑子 chatId + streamAgentChunks 推 ws 到 parent。端到端路径与主 agent chat.send **完全一致**（user 原意：「子 agent 应该和主 agent 走同一条 API 路径」）。前端只通过 ws 订阅观察子 stream，无需调 chat.startSpawn RPC。
- **role_created notification 处理**（agents store `routeNotification`）：从 notification `{chatId, parentChatId, type, prompt, brain, senseGroup, wake, ...}` 造子 pet（emoji face，落主附近）+ 登记子 pet `runtime={brain, senseGroup, mcpServers:[]}`（brain/senseGroup 来自 notification）。
  - **幂等 join**（[streamRouter.ts:453](../../../web/src/stores/agents/ui/streamRouter.ts#L453)）：若 sub stream 已在累积（`isWorking || thinking.length > 0 || content.length > 0`）→ 跳过 RPC（后端 eager 已跑，前端 startSpawn 无意义且会抹掉已收 chunks）。
  - **startSpawn 防御**（[index.ts:374](../../../web/src/stores/agents/index.ts#L374)）：stream 累积内容非空时不重置（避免抹掉后端 eager 跑出的 chunks）。
- **chat.startSpawn 退化为 recovery-only**：[web/services/agentApi.ts:899](../../../web/src/services/agentApi.ts#L899) RPC 保留（重连 / 抢占 / 中断续跑 / 已 finished 同步），不再是「启动」入口。Response 分支 `alreadyRunning / alreadyFinished / finished` 任一即可判断「子任务生命周期已显式落地」。
- **后端 spawn_role sense 已预创建 chat + runtime**（metadata.runtime 路径）：前端不调 chat.create（避 PRIMARY KEY 冲突）、不调 runtime.set。
- **subagent 消息**：wake 策略决定的 `role_reply` 由 `ChatSessionStore` 在**实时**收到后写入父会话并调用 `resumeAgent`；启动 RPC 前立即把该会话的 `run.status` 投影为 `running`，Pet 只消费该投影。`sync.replaying`、快照与重连回放只还原数据，绝不调用 resume，避免刷新页面重放旧 `role_reply` 时误启动新一轮。legacy `streamRouter` 不再负责父会话续跑或 working 状态。
- **agentApi.subagentResult**（已废）：wait=true 子完成回传通道，2026-07-09 后改为后端注入角色回复（role:role）+ role_reply notification 唤醒主 chat；前端 wait=true 回传分支已删。wait=false 复用 `sendMessage` 注入 `[子 agent {type}] {content}` 到主 chat。**2026-07-23 注**：连 wait=false 也由后端注入完成，前端不再做 sendMessage 注入。

### CP4（历史 + 群消息 + sense 调用 box）

- **HistoryDrawer**（[HistoryDrawer.vue](../../../web/src/features/agent/HistoryDrawer.vue)）：右侧抽屉，AnimatePresence + motion.div 滑入滑出；宽度默认 `clamp(320px,40vw,560px)`，左缘拖拽改宽并持久化。面板只读 ChatSession selector；打开、关闭、切层不发历史 RPC，也不改变 Pet 实时气泡。
- **MessageBubble**（[MessageBubble.vue](../../../web/src/features/agent/MessageBubble.vue)）：群消息样式——user 头像右/气泡左（row-reverse）；assistant 头像左/气泡右；subagent 同 assistant。**去除文字角色标签，保留圆形头像**；**hover 头像弹详情面板**从 `item.runtime` 显 brain/senseGroup/mcpServers + agentType(subagent)；**user 不弹面板**。runtime 缺失字段显「—」（旧消息无 runtime 场景）。thinking 折叠区（默认收起），senseCalls 列表挂在 content 下方。消息级 runtime 见 [agent-pet.md §5.7](../../agent-pet.md)。
  - **双布局**（`layout` prop，[HistoryDrawer](../../../web/src/features/agent/HistoryDrawer.vue) 按 opened chat 是否子 chat 传 `"direct"|"group"`）：
    - **group**（默认，主 chat 合并视图）：master/subagent 双头像（发言者大 + 对方小徽章），均左排；user 右。**发言者 = caller（派发方）**，按 `callerIsMaster` 区分多级 spawn（见 [agent-pet.md §5.8.9](../../agent-pet.md)）：master 消息（父→子派发 prompt）发言者大头像——单层（主→子）= 主 pet（pet-master + masterText）/ 多级（子→孙）= 上层子 pet（pet-sub + callerPetFace）；role 消息（子回复）徽章同理。多级时两头像均 pet-sub 紫，靠 face emoji + name-initial 区分。
    - **direct**（ghost 自身抽屉，opened chat 为子 chat）：单头像 1:1 布局——**master 靠右**（row-reverse，主 pet 名首字符头像，hover 面板翻向左侧防溢出）/ **subagent 靠左**（ghost emoji 头像）。master 消息由子 chat 自身 `user→master` 重映射得来（见 getHistory）。
- **SenseCallBox**（[SenseCallBox.vue](../../../web/src/features/agent/SenseCallBox.vue)）：sense 调用 box（assistant 消息内子项），显 senseName + 状态指示（⋯ running / ✓ done / ✗ error）+ arguments/result 可折叠 pretty-print（后端 arguments 契约为 JSON 字符串）。
- **ChatSession messages**：历史回放、实时 stream/staged、done finalMessage、role_reply 和乐观 user 都进入同一 reducer。消息以 `messagesById + messageOrder` 保存；实时 LLM 消息从第一个带 `msgId` 的 stream delta 起即进入时间线，staged/done/replay 只补全同一个对象。主视图通过 selector 合并全部后代 ChatSession，按 `agentChatId` 反向溯源，但不在父实体存 child 副本。抽屉工作中直接渲染 active 消息，因此与 Pet 气泡共享实时打字内容，不再等待整轮结束或稳定 300ms 后重新加载。
  - **实现位置**：[web/src/stores/chats/](../../../web/src/stores/chats/)（5 文件，≤5 约束）--`types.ts`（ChatSession/ChatMessage 契约）、`reducer.ts`（`reduce` 单写者 + 跨 session 落点 `reduceRoleCreated/reduceRoleReply/reduceConsumed`）、`selectors.ts`（只读投影 + `selectGroupTimeline` 群聊聚合）、`hydration.ts`（catalog 工厂 + `applySnapshot` 权威替换）、`index.ts`（`useChatSessionsStore`：`replaceSnapshot`/`applyEvent` 两写入口 + `hydrateTree` attach->sync 内核 + 命令 actions + `bindEffects`/`bindWsClient`）。reducer 复用 [streamAccumulator](../../../web/src/stores/agents/data/streamAccumulator.ts) 与 [historyMerge](../../../web/src/stores/agents/data/historyMerge.ts) 纯逻辑语义，仅把 `history[]` 改为规范化 `messagesById`+`messageOrder`。
- **抽屉栈 + 跨层管理层**（[HistoryDrawer.vue](../../../web/src/features/agent/HistoryDrawer.vue) 重构）：单值 `activeHistoryChatId` 升级为**栈** `historyDrawerStack`（[uiState.ts](../../../web/src/stores/agents/uiState.ts)，无限层上限 5）。HistoryDrawer 拆为**栈容器**（v-for [HistoryDrawerPanel](../../../web/src/features/agent/HistoryDrawerPanel.vue) + 单遮罩 + ESC 关顶层）+ **单面板子组件**（chatId 驱动的 pet/layout/history/滚动/jumpToSpawn/宽度逻辑）。每层 z-index 递增（280 + N×10）；下层 panel 已挂载被遮盖、关闭顶层即时显现（无需重载历史）。
- **useHistoryDrawerManager**（[useHistoryDrawerManager.ts](../../../web/src/features/agent/useHistoryDrawerManager.ts)）：App 顶层 `provide`、后代 `inject` 的跨层管理层，只负责抽屉栈操作（`openRoot` / `drillChild` / `closeTop` / `closeAll` / `switchTop`）。历史数据由 ChatSession selector 提供，不维护第二份 historyCache，也不代理 `getHistory`。
- **spawn_role 详情下钻**：[SpawnRenderer.vue](../../../web/src/features/agent/renderers/SpawnRenderer.vue) 隐藏原始 chatId、改显「详情」链接；点击 → `manager.drillChild(childChatId)` push 栈 + 加载子 chat direct 历史。

### CP5（审批 + 队列 + PetIcons 闪烁）

- **ApprovalCard**（[ApprovalCard.vue](../../../web/src/features/agent/ApprovalCard.vue)）：pet 气泡内审批卡片（最高优先级，z-index=400 单独自提避开 AgentDialog 300/HistoryDrawer 280/FAB 200 的覆盖），显 senseName + arguments 折叠 + Accept/Reject + ✕关闭 三按钮（请求中三按钮都禁用防双击）。✕关闭调 `agents.dismissApprovalToQueue(chatId)` → 当前审批移入 `approvalQueue` 末尾保留（不调 RPC，等服务端超时 reject 自动清，或用户点 icon 重新唤起）。
- **StreamState.approval / approvalQueue**：
  - `approval`：当前在气泡展示的审批（最多 1）
  - `approvalQueue`：已隐藏但未处理的审批队列（任意长度）。PetIcons 渲染为闪烁 icon，频率 = `max(0.2, min(5, remainingSec * 0.1))` 秒（剩余越少闪得越快）。倒计时归零 → 按 approvalId 精确移除并推进下一条，不保留不可点击死卡。
  - `interrupt` notification → 若 `approval` 已存在则 push 到 queue；否则 `stream.approval = 新项`（多审批堆叠，不互相覆盖）。
  - `accept` / `rejected` notification → 按 approvalId 在 `approval` + `approvalQueue` 中查找移除；若移除的是当前 approval 则 auto-pop queue head 下一个进 `approval`（连续处理多审批）。
  - `sendMessage` / `resumeAgent` → 当前 approval 移到 queue（不丢失），不重置 queue（用户后续可从 PetIcons 重新唤起）。
  - `dismissApproval`（Accept/Reject submit 后调）：清 `approval` + auto-pop 下一个。
  - `dismissApprovalToQueue`（ApprovalCard ✕ 调）：把 `approval` push 到 queue + auto-pop 下一个。
  - `resummonApproval(chatId, approvalId)`（PetIcons 点击队列 icon 调）：按 id 从 queue 找到项移到 `approval`；若当前 `approval` 已存在则把它也移到 queue（保留连续处理能力）。
- **routeNotification interrupt/accept/rejected**：approvalId/senseName 字段残缺时 console.warn fail loud；Accept/Reject 委托 `agentApi.approval(approvalId, action)`。
- **PetIcons**（[PetIcons.vue](../../../web/src/features/pets/PetIcons.vue)）：pet 头部右侧 icon slot（绝对定位 `pet.x + width`，`top = pet.y + 16`，z-index = `speechZ - 1`）。两列布局：
  - **history 列（左）**：本 chat 最近 5 条 `HistoryItem` 小圆点（14px，role 配色，hover 弹 240px 气泡显 role tag + content 截 80 字）。
  - **approval 列（右）**：当前 approval 实心橙高亮（无闪）+ approvalQueue 白底橙边闪烁。click icon → `resummonApproval`；倒计时归零 → 淡出。
  非 ghost pet 才挂载；容器 `pointer-events:none`，icon 显式 `auto` 收点击。

### CP6（中止 + 销毁 + destroy_role）

- **store.abort(chatId)**：调 `agentApi.abortAgent` + 手动清工作态（后端 chat.abort 可能不推 done，需兜底清 isWorking + stream.isWorking）。
- **store.hide(chatId)**（CP8 修订，原 `destroy`）：**仅前端隐藏**——移除主 pet + 其子 pet 出 `pets` + 清 `streams`/`spawnWaits`，**不调 chat.delete**。运行中（`isWorking` 或任一子 pet isWorking）禁用（PetToolbar destroy 按钮 disabled）。
- **PetStage 接线**：`handleAbort`/`handleDestroy`(→`hide`)/`handleHistory`/`handleCompact` 各自委托 store；主 pet 点击 → `activeDialogChatId`（开 AgentDialog），子 pet 点击 → 装饰 clickPet。
- **role_destroyed notification**：清对应 pet + spawnWaits + streams。

### CP7（contextUsage 后端计算）

- **后端 token 估算**（[src/utils/token.ts](../../../src/utils/token.ts)）：`estimateTokens = Math.ceil(text.length / 4)`（英文近似 4 char/token，中文偏保守）；`sumChatTokens` 累加 chat 所有非 revoked 消息 content+thinking；`computeContextUsage(chatId)` = used /（brain.contextLimit × `TOKENS_PER_KB`=256）（`contextLimit` 语义为**记忆容量 KB**，换算 1KB≈1024char÷4=256token 后作分母；clamp [0,1]，brain 未配 contextLimit 兜底 32 KB）。
- **返传通道**：`done` notification + `chat.get` response 各携 `contextUsage`；agents store `routeNotification`（done 分支）/ `getHistory`（response.then）写入 `pet.contextUsage` → ContextBar 渲染。
- **估算失败 fail loud**：兜底 0 + console.warn，不阻塞 chat.send/get 主流程（规则 12）。

### CP8（会话列表 + 销毁语义分离）

- **stage 默认 5 个**（[stores/agents.ts](../../../web/src/stores/agents.ts) `initFromChats`）：`chat.list`（lean）→ 主 chat 按 `sessionRecency = max(master.updatedAt, 其子 updatedAt)` 排序取前 5 → 建主 pet + 其子 pet。不再重建全部 chat。允许临时超过 5（+ 新建 / 历史加载不挤，用户手动 hide 才减）。
- **销毁语义分离**：
  - **隐藏**（stage pet 工具栏 ✕，仅主 pet）：`store.hide(chatId)` 仅前端移除 `pets`（含子 pet），不删 DB。运行中禁用（`isWorking` 或任一子 isWorking → destroy 按钮 disabled）。
  - **删除**（会话列表行 ✕）：`store.deleteSession(chatId)` 调 `chat.delete`（后端级联子 chat）→ 从 `historyList` + `pets` 移除。
- **会话列表 UI**（[SessionList.vue](../../../web/src/features/agent/SessionList.vue)）：右侧抽屉，`historyListOpen` 驱动。`fetchHistoryList()` 调 `chat.list({includePreview:true})` 缓存 `historyList`。行显 `preview` 截断（hover 显 chatId/创建时间）+ last-run（`updatedAt`）+ 轮次（`turnCount`）；点行 → `loadSession(chatId)` 从缓存建主+子 pet 入 `pets`（允许 >5）。
- **会话列表入口**（[NyxusCore.vue](../../../web/src/features/pets/nyxus/components/NyxusCore.vue)）：工具环 history 按钮 → `historyListOpen=true` + `fetchHistoryList()`。
- **命名区分**：`HistoryDrawer`（单 pet 消息史，pet 工具栏 ▤）保留；`SessionList`（会话列表，☰）为 CP8 新组件。
- **隐藏不持久化**：重连重取 top-5，隐藏但仍 top-5 的 pet 会重现（transient，不增 schema）。

## G8 + F1–F2：hydration 重构（currentState 快照消费）

后端协议改造（G1–G8）已全绿，前端按 [frontend-refactor-handoff.md](../frontend-refactor-handoff.md) F1+F2 落地两项：
- **F1**：删 `syncChatEvents` 死分支（`data.reset → getHistory()`，后端已不再返 `reset:true`，保留会误覆盖缓存）。
- **F2**：消费 `currentState` 快照（pendingApproval / runningTools / currentTodo），补实时态缺口。

### F1 死分支清理

[syncChatEvents](../../../web/src/stores/agents/index.ts) 删 `if (data?.reset)` 整块 + 收紧 `data` 类型（移除 `reset?: boolean`）。`chat.sync(0)` 后端已用消息合成事件回填超窗淘汰历史，前端不再需要 `getHistory()` 重拉快照。

### F2 currentState 快照消费

后端 `chat.get` / `chat.sync` / `chat.attach` response 携带 `currentState: { pendingApproval?, runningTools[], currentTodo? }`（镜像 [src/service/message/types.ts CurrentStateData](../../../src/service/message/types.ts)）。前端定义本地 `CurrentStateData` 类型（[agentApi.ts](../../../web/src/services/agentApi.ts)），避免跨包 import。

**`applyCurrentState(chatId, data, advanceEventCursor)`**（[stores/agents/index.ts](../../../web/src/stores/agents/index.ts)）镜像 [applyQuestionSnapshot](#cp5审批--队列--peticons闪烁) 模式：
- 缺 `currentState` 字段 → 早返回，不动 StreamState
- `pendingApproval` → 权威 replace `stream.approval`（含 waitTime/createdAt 倒计时）+ 清 `stream.approvalQueue`
- `runningTools` → 权威 replace `stream.runningTools`（含 smart/manual 待审批，**补实时态缺口**：parked 审批气泡存活判定 + smart/manual 工具态）
- `currentTodo` → 写入新增字段 `stream.currentTodo`（TodoPanel 改造留待 F5 收口）
- `advanceEventCursor=true` + `snapshotSeq` → `wsClient.resetChatSeq` 推进 cursor

**调用点**：
- `syncChatEvents`：sync response 到达后立即 `applyCurrentState(chatId, data, true)`（与 `applyQuestionSnapshot` 并列）
- `attachRunningChats`：attachChat response 到达后 `applyCurrentState(chatId, res, true)`

**`routeNotification` 三处 replayMode 'sync' 守卫删除**（[streamRouter.ts](../../../web/src/stores/agents/ui/streamRouter.ts) interrupt / sense_started / accept,rejected）：currentState 已权威 replace pendingApproval/runningTools，回放期不再需要事件流重建实时态；保留守卫反会导致 parked 子 chat 审批气泡/spinner 残留。role_created / role_destroyed 的守卫保留（F3 收口）。

### F3 replayMode 收敛（已落地）

回放模式从 `'sync'/'resume'` 双字面量收敛为单一 boolean 标记 `replaying?: boolean`，统一回放期行为：抑制副作用 RPC（startSpawn/resumeAgent）+ 抑制终态（done retainUntil / error-bubble / auto_compacted toast）；实时态由 F2 currentState 快照给定。

#### 类型与设置

[types.ts](../../../web/src/stores/agents/types.ts)：`replayMode?: 'sync' | 'resume'` → `replaying?: boolean`。
[syncChatEvents](../../../web/src/stores/agents/index.ts)：
- L833 `stream.replaying = chat.running`（运行中 = true=resume；非运行 = false=sync）
- L862/L879 回放结束 → `stream.replaying = undefined`

#### 守卫收敛（6 处）

[streamRouter.ts](../../../web/src/stores/agents/ui/streamRouter.ts)：

| 行 | 原 | 新 | 理由 |
|---|----|----|------|
| L114 | `if (stream.replayMode === 'sync') return`（routeChunk stream chunk 累加） | **删除** | sync 期间 chunk 累加污染由 sync 结束清空兜底（[index.ts:863-873](../../../web/src/stores/agents/index.ts#L863) 清 thinking/content/approval/runningTools/...）；resume 期间 chunk 累加保留（重建打字机实时态）—— 删除 L114 让两条路径一致 |
| L152 | `if (!stream.replayMode && type === 'done') stream.retainUntil = ...` | `if (!stream.replaying && type === 'done') ...` | truthy 检查语义一致（undefined/false 都跳过） |
| L239 | `if (streams.value[chatId]?.replayMode) return`（error-bubble） | `if (streams.value[chatId]?.replaying) return` | truthy 检查 |
| L276 | `if (chatId && streams.value[chatId]?.replayMode) return`（auto_compacted toast） | 同上 truthy | — |
| L469 | `if (ensureStream(streams, d.parentChatId).replayMode) return`（role_created startSpawn 抑制） | 同上 truthy | — |
| L531 | `if (stream.replayMode) return`（role_reply resumeAgent 抑制） | `if (stream.replaying) return` | truthy 检查 |

### F4 历史实现：缓存数组统一 + 去重栈瘦身（已由 ChatSession 目标取代）

> 本节保留 F4 演进背景，解释旧 `StreamState.history` 与 reload/dedup 设计。新实现不得继续物化 parent history，也不得保留 HistoryDrawer reload；权威规则见本文开头“ChatSession 单一数据层”。

F1+F2+F3 已落地 hydration 单一水源 + currentState 快照消费 + replayMode 收敛。本期 F4 釜底抽薪重写历史面板数据流：5 源 → 2 源 + 6 层去重 → 大幅缩减 + 单一有序数组视图。层⑥ `mergeChildReplyHistory` 保留不动（数据模型层 A/B 双物理记录，待后端统一）。

#### 数据模型不变式

[types.ts](../../../web/src/stores/agents/types.ts) `StreamState.history` 不变（[types.ts:154](../../../web/src/stores/agents/types.ts#L154)），仅加注释不变式：

> append-only by createdAt；past（chat.sync staged 累加）+ present（C/D/E 乐观累加）单一有序数组；任意时刻 history 即 drawer 直渲染源，无第二数组、无 in-progress 合并识别。实时轮打字机由 stream.thinking/content 暂存（双气泡契约）。

`HistoryItem`（[types.ts:47-93](../../../web/src/stores/agents/types.ts#L47)）字段不变 — 已是 31 个 callers 的唯一渲染契约。

#### pushHistoryItem 统一 helper

[streamAccumulator.ts](../../../web/src/stores/agents/data/streamAccumulator.ts) 新增 `pushHistoryItem(stream: StreamState, item: HistoryItem): void`：

- **职责**：接收**已成型** HistoryItem 写入 `stream.history`，不解析 staged 行（与 `accumulateStaged` 边界：accumulateStaged 解析 `StagedChunkData` 行[B 源]；pushHistoryItem 接收整条 item[C/D/E 源]）
- **唯一去重轴 = msgId**：① `item.msgId` 命中既有同 msgId → 就地补空字段（content/thinking/msgId/agentChatId/senseCalls 缺则填，已有不覆盖），不 push；② 无命中或缺 msgId → 直接 `history.push(item)`
- **不识别末位 in-progress** — 实时轮打字机走 stream.thinking/content 暂存，不并入 history 末项
- 媒体抽取由调用方在构造 item 前用 `extractMediaUrls(content)` 完成
- sense_calls 关联由 `accumulateStaged` 负责（B 源）；C/D/E item 自带 senseCalls

两者写同一 `stream.history`、共享 msgId 幂等轴 → 交叉去重天然成立。

#### 5 源 → 3 源（**F4 修订**：恢复 A 源主 chat loadHistory）

| 源 | 原实现 | F4 修订后 |
|---|--------|-----------|
| A: chat.get staged | doLoadHistory 调 agentApi.getHistory → routeChunk staged → accumulateStaged | **保留**（主 chat loadHistory）+ 子 chat direct/合流 |
| B: chat.sync staged | syncChatEvents → agentApi.syncChat → routeChunk staged → accumulateStaged | **保留**（replay + attach 后补回 + 启动批 replay） |
| C: done finalMessage | streamRouter done notification 内联 push（带 isDuplicate 检查） | 改走 pushHistoryItem |
| D: role_reply | streamRouter role_reply 内联 push（带 msgId 检查） | 改走 pushHistoryItem |
| E: sendMessage 乐观 | index.ts:280 入口即时 push tempMsgId 占位 user | 改走 pushHistoryItem |

#### 主 chat 历史获取：双 RPC 对齐（M1 修订）

[doLoadHistory](../../../web/src/stores/agents/index.ts) 改造：

- **主 chat**（`!openedSummary?.parentChatId`）`syncOneChat(openedSummary, 'loadHistory')` → 内部走 **`chat.get`**（loadHistory 模式），取全量历史 + currentState + contextUsage + workspace + canResume 一并到位
- **子 chat**（direct 视图 & 后代合流）仍走 `agentApi.getHistory` + `lifecycle.remapChildHistory` — 子 chat 只要消息 + remap
- **M1 修订注**：F4 原方案「chat.sync(0) 唯一历史源」因 `chat.sync(afterSeq)` 增量语义 + `afterSeq=wsClient.getLastSeq()` 永不 0 + chat_events retention 边界，触发刷新后主 chat sync 流返空；本期回归「双 RPC 各司其职」：`chat.get` = 全量（loadHistory，messages 表 retention-independent），`chat.sync` = 增量（replay/attach，chat_events seq>afterSeq + 超窗回填）
- **contextUsage 一次到位**：`chat.get` response 含 contextUsage/contextUsed/contextTotal/contextBreakdown/commandConfig/workspace/workspaceValid，`syncOneChat(loadHistory)` 一次性 consume；无需独立 `agentApi.contextUsage` 兜底 RPC
- **dirty/loaded 时机**：chat.get 流灌满 history + applyQuestionSnapshot 已推 cursor → 尾清 `historyDirty=false` + `historyLoaded=true`，取代原依赖 `loaded` notification 清 dirty 的路径

#### attach + sync 组合（M2+M9 修复）

`chat.attach` 响应**补 `snapshotSeq` + `pendingQuestionBatches`**（继承 `QuestionStateSnapshotData`），与 chat.get/chat.sync 同源 — 这是 cursor 锚点：

- `applyCurrentState(c.chatId, res, true)` 借此 `resetChatSeq` 推进 chatSeq 到此刻持久化的最新事件位
- `applyQuestionSnapshot(c.chatId, res, true)` 权威 replace parked question batches
- 紧接 `syncOneChat(c, 'replay')` 补回 disconnect-window 事件（chatSeq 已在 snapshotSeq，sync 仅取 seq>snapshotSeq 的留存事件）
- 验收测试 [flowAttachSync.test.ts](../../../test/flows/service/flowAttachSync.test.ts) S17 锁住行为

[syncChatEvents](../../../web/src/stores/agents/index.ts) 单 chat 化：抽出内核 `syncOneChat(chat)`（`replay` / `loadHistory` 双模式），`initFromChats` / bootstrap 仍批量；`doLoadHistory` 主 chat 直接 `await syncOneChat(mainSummary, 'loadHistory')`。

**子 chat 合流串行**：`await syncOneChat(main, 'loadHistory')` 完成 → `await Promise.all(childHistoryPromises)` → 再合流（层④）。async 串行保证主 chat history 已就位再合入子 remap。

#### 去重栈瘦身表

| 层 | 位置 | F4 动作 |
|---|------|--------|
| ① staged 幂等 | [streamAccumulator.ts accumulateStaged](../../../web/src/stores/agents/data/streamAccumulator.ts#L35) | **保留**（chat.get yield 走 accumulateStaged msgId/id 幂等；chat.sync retained events 同走） |
| ② done 内联 dedup | [streamRouter.ts isDuplicate 块](../../../web/src/stores/agents/ui/streamRouter.ts#L172) | **删 ~30 行** → pushHistoryItem 幂等兜底 |
| ③ role_reply dedup | [streamRouter.ts:503](../../../web/src/stores/agents/ui/streamRouter.ts#L503) | **删 ~1 行** → pushHistoryItem 幂等兜底 |
| ④ doLoadHistory 合流 | [index.ts:708-722](../../../web/src/stores/agents/index.ts#L708) | **缩减 ~10 行**：仅「主 chat chat.get 结果 + 子 chat remap」按 createdAt 合流；msgId dedup 保留（跨 chat 物理去重）；sort 保留 |
| ⑤ dedupHistoryByMsgId | [historyMerge.ts:7-71](../../../web/src/stores/agents/data/historyMerge.ts#L7)；调用 [HistoryDrawerPanel.vue:106](../../../web/src/features/agent/drawer/HistoryDrawerPanel.vue#L106) | **降防御**：函数不删，`:106` 加注释「上游 pushHistoryItem msgId 幂等后此处为防御兜底，多源竞态残留时才生效」 |
| ⑥ mergeChildReplyHistory | [historyMerge.ts:111-173](../../../web/src/stores/agents/data/historyMerge.ts#L111)；调用 vue:107 | **保留不动**（A/B 双物理记录，待后端统一） |

`accumulateStaged` 注释（[streamAccumulator.ts:40-41、96](../../../web/src/stores/agents/data/streamAccumulator.ts#L40)）中「done.finalMessage 已 push」改指「pushHistoryItem 已 push」，语义等价。

#### 渲染管道稳定

[HistoryDrawerPanel.vue:100-114](../../../web/src/features/agent/drawer/HistoryDrawerPanel.vue#L100) history computed 零改动：`stream.history → dedupHistoryByMsgId(⑤ 防御) → group?mergeChildReplyHistory(⑥) → subagentDisplay filter`。上游 5→3 源收敛后同一有序数组，管道输入形状不变。

[MessageBubble.vue](../../../web/src/features/agent/chat/MessageBubble.vue) 单 item 契约不变。VirtualScroll key（`getHistoryItemKey` [vue:138-140](../../../web/src/features/agent/drawer/HistoryDrawerPanel.vue#L138)）`item.msgId ?? idx-<index>`：E 乐观 push tempMsgId 保证首帧稳定 key，userMsgId 替换后切一次（单条 user，可接受）。

#### 关键风险与缓解

- **syncOneChat 单 chat + 子串行时序**：doLoadHistory `await syncOneChat(main)` 串行守卫，否则空数组合并
- **E msgId 占位合并时机**：done.then userMsgId 到达前若 B staged 先带真 msgId，短暂 tempMsgId + userMsgId 两条 user，靠 ⑤ 防御 + 「user prompt 仅一条」约束覆盖
- **D mergedView 写入与⑥ 配对**：⑥ 跳过已带 mergedView 项（[historyMerge.ts:117、131](../../../web/src/stores/agents/data/historyMerge.ts#L117)）

## 渲染分层注记

完整的 ASCII 分层图与命中区/z-index/对话框 slot 机制见 [rendering.md](./rendering.md)。agent 接入引入的关键变化：

- **status-row**：原 `span.bar.emotion + span.bar.fatigue` 改为 `span.stat.emotion .fill` + `<ContextBar :usage="pet.contextUsage" />`（CP2/CP7）。emotion 条保留（统一橙色），fatigue bar 移除。
- **meta-row**：原 `div.tools`（core 常驻）+ `div.tools-extra`（hover 展开）被 `<PetToolbar>` 组件取代（CP2/CP6）；CSS `.tools`/`.tool-icon` 已置 `display:none`（保留兼容）。
- **speech**：原单一 Motion.speech + `#dialog` slot 扩为 4 tier 互斥（ApprovalCard / error-bubble / work-bubble / 默认 slot）+ 独立 `AnimatePresence` 侧气泡（thinking 副本）。审批存在时优先显 ApprovalCard（`v-if="stream?.approval"`，z-index=400 单独避开浮层覆盖），同时抑制侧气泡（避免与 interrupt 视觉冲突）。

## fatigue 与 contextUsage 语义解耦

CP7 后两者职责彻底分离：

- **fatigue**：保留为 pet 移动生活感（移动/拖拽累积，≥80 自动休息，休息时 emotion 回血）。与 agent 无关，纯装饰。
- **contextUsage**：CP7 已接入后端 token 估算（[src/utils/token.ts](../../../src/utils/token.ts)），由 `done` / `chat.get` 返传 → `pet.contextUsage` → ContextBar 渲染（色阶：<50% 绿 / 50-80% 黄 / ≥80% 红）。PetToolbar `contextUsage ≥ 50%` 显 compact 按钮（compact RPC 预留）。

原 PetSprite status-row 的 fatigue bar 已被 ContextBar 组件取代（emotion 条保留，统一橙色）。

## 运行中工具 bar + todo 专用渲染（能力驱动）

**运行中工具 icon（`sense_started` notification）**：auto 工具触发执行时后端推 `sense_started` `{id, senseName, arguments}`（smart/manual 仍走 interrupt）。agents store `routeNotification` 据 `id` push 到 `stream.runningTools`（`{id,name}[]`），`accept`（`approvalId=id`）到达时按 id 移除，`done`/`error` 清空。前端缓存 `sense.tools`（含 `icon`）name→icon，未命中 fallback ⚙。

**RunningTools 组件**（[RunningTools.vue](../../../web/src/features/agent/RunningTools.vue)）：挂 [PetSprite](../../../web/src/features/pets/PetSprite.vue) `.meta-row` 右侧（PetToolbar 之后），多工具并发时并排多 icon；空间不足时 `.name` max-width+ellipsis 让位。每个 icon = 运行中工具的 `icon` 字段。

**todo 专用渲染（能力驱动，无专属 todo_worker）**：
- **历史对话框**（[MessageBubble.vue](../../../web/src/features/agent/MessageBubble.vue)）：`senseCalls` 渲染按 `call.name==="update_todo"` 分支——命中走 [TodoSenseBox.vue](../../../web/src/features/agent/TodoSenseBox.vue)（读 `call.args`(JSON)→`todos:[{content,status,activeForm}]`，checklist：pending☐ / in_progress▣spinner / completed✓+strikethrough），其余走通用 [SenseCallBox.vue](../../../web/src/features/agent/SenseCallBox.vue)。
- **pet 右侧侧栏**（[TodoPanel.vue](../../../web/src/features/agent/TodoPanel.vue)）：**能力驱动**——任何 pet（主/子）其 agent senseGroup（经 `sense.list` 解析为 sense 名集合）含 `update_todo` 即显示；读 `streams[pet.chatId].history` walk back 最近一次 `update_todo` senseCall 的 `args.todos`，只读勾选。todo 存在与否 = 是否在 senseGroup 里（无 task-scale 判断逻辑）。

## 留待

- **tokenizer 精确计算**：当前 `estimateTokens` = `Math.ceil(text.length / 4)` 字符近似（英文偏准、中文偏保守），后续接 js-tiktoken 等替换 `estimateTokens` 实现，调用点不变。
- **compact RPC**：PetToolbar `contextUsage ≥ 50%` 已预留 compact 按钮 + PetStage `handleCompact` TODO 占位，后端 compact RPC 未实现。
