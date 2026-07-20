# agent 接入（CP1-CP8，已落地）

> 上级 [README.md](./README.md) ｜ 跨前后端设计 [../../agent-pet.md](../../agent-pet.md) ｜ 渲染分层 [rendering.md](./rendering.md)

pet 模块已由纯装饰桌宠改造为 **主从 Agent 可视化交互系统**（整体设计见 [../../agent-pet.md](../../agent-pet.md)）。CP1-CP8 全部落地：连接接线、FAB/对话、子 agent 前端驱动、历史抽屉、审批、生命周期、contextUsage 计算、会话列表 + 销毁语义分离。

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

- **AgentFab**（[AgentFab.vue](../../../web/src/features/agent/AgentFab.vue)）：右下常驻圆形按钮 + 下方小字连接状态（disconnected 灰 / connecting 黄 / connected 绿）；点击先 `fetchServerConfig` 取 `presets`（T6）并弹预设选择器（每项显 name + leader 角色的 brain + 角色数）；选预设 → `createMasterPet({preset})`（后端通过 `presets[name].leader` 引用的角色解析编制快照）；无可用预设时不能创建主 pet；非 connected 禁用。
- **AgentDialog**（[AgentDialog.vue](../../../web/src/features/agent/AgentDialog.vue)）：overlay + panel 弹窗。弹窗按当前小组以“组长优先”的顺序列出带主/成员图标的两行紧凑角色摘要：首行显示角色名与完整当前模型，次行显示当前感官组 icon；点击后在更宽的横向角色名片中查看配置。名片展示模型、思考、上下文、Tool Call 状态及图片/视频/音频输入和生成徽标。大脑选择项显示完整 `model` 名；临时切换到 `toolCall:false` 模型会清空并隐藏感官选择，按仅对话编制提交，切回支持工具的模型才可再选感官。图片/视频/音频上传入口会先检查当前临时 brain 的 `capabilities.input`，通过后上传至 `/api/media/upload` 并把受控资产引用加入本轮消息。选择经 `session.runtime.set` 写入内存态且不改会话默认配置；`Cmd/Ctrl+Enter` 发送、`Esc` 关闭、点遮罩关闭。完整能力规则见 [../../model-capabilities.md](../../model-capabilities.md)。
- **ContextBar**（[ContextBar.vue](../../../web/src/features/agent/ContextBar.vue)）：contextUsage 0-1 progressbar，色阶：<50% 绿 / 50-80% 黄 / ≥80% 红。
- **PetToolbar**（[PetToolbar.vue](../../../web/src/features/agent/PetToolbar.vue)）：主 pet = 历史/中止/隐藏（✕ destroy=hide，CP8）；子 pet = 历史/中止（无隐藏）；contextUsage ≥ 50% 显 compact（预留）。中止按钮 `:disabled="!pet.isWorking"`——非工作态灰显不可点。**隐藏按钮 `:disabled="pet.isWorking || hasWorkingChild"`**（CP8）——运行中或任一子 pet 运行中禁用（避免孤儿流）。
- **PetSprite 双气泡**（[PetSprite.vue](../../../web/src/features/pets/PetSprite.vue)）：thinking 阶段（content 空）主气泡全空间显 thinking；thinking 结束（content 非空）主气泡显 content + 左侧独立小气泡显 thinking。
- **工作态 action=chatting**：`setWorking` 切 `pet.action="chatting"`（复用现有 chatting motion，不新增 action）+ `mood="curious"` + `interactionUntil=0`（agent 工作态不超时，由 done/error 解除）。
- **sendMessage action**（agents store）：runtime diff 决策（与当前 runtime 异 → 先 `agentApi.setRuntime` 再 send，同则直发）；发送后重置 stream 实时累积 + 清 pending approval + pet 进 isWorking；`runtime.set` 后同步 `pet.runtime`。

### CP3（spawn_role 前端驱动）

- **role_created notification 处理**（agents store `routeNotification`）：从 notification `{chatId, parentChatId, type, prompt, wait, brain, senseGroup}` 造子 pet（emoji face，落主附近）+ 登记子 pet `runtime={brain, senseGroup, mcpServers:[]}`（brain/senseGroup 来自 notification）+ 调 `sendMessage(chatId, prompt)` 跑子 agent；后端 spawn_role sense 已预创建 chat + runtime（metadata.runtime 路径）→ 前端不调 chat.create（避 PRIMARY KEY 冲突）、不调 runtime.set。
- **spawnWaits Map**：登记子 chatId → `{parentChatId, type, wait}`，done 时按 wait 决策回传/注入。
- **agentApi.subagentResult**（已废）：wait=true 子完成回传通道，2026-07-09 后改为后端注入角色回复（role:role）+ role_reply notification 唤醒主 chat；前端 wait=true 回传分支已删。wait=false 复用 `sendMessage` 注入 `[子 agent {type}] {content}` 到主 chat。

### CP4（历史 + 群消息 + sense 调用 box）

- **HistoryDrawer**（[HistoryDrawer.vue](../../../web/src/features/agent/HistoryDrawer.vue)）：右侧抽屉，AnimatePresence + motion.div 滑入滑出；宽度默认 `clamp(320px,40vw,560px)`，**左缘拖拽手柄（col-resize）改宽**——`setPointerCapture` + pointermove 计算 `startW - dx`，边界 `[320, Math.floor(innerWidth*2/3)]`（max = 屏幕 2/3）；拖拽宽持久化 localStorage `cheryclaw:history-drawer:width`（px 数字），加载时 clamp 防小屏溢出，window resize 时重 clamp 保约束；打开时 `agents.getHistory(chatId)` 触发 staged 流（**缓存守卫**：`!stream.historyDirty && stream.historyLoaded` → 零 RPC 直接 return；否则才走 RPC），history 累积到 `stream.history`，`loaded` notification 标 historyLoaded + historyDirty=false；history 长度变化 / loaded 切 true 后滚到底。
- **MessageBubble**（[MessageBubble.vue](../../../web/src/features/agent/MessageBubble.vue)）：群消息样式——user 头像右/气泡左（row-reverse）；assistant 头像左/气泡右；subagent 同 assistant。**去除文字角色标签，保留圆形头像**；**hover 头像弹详情面板**从 `item.runtime` 显 brain/senseGroup/mcpServers + agentType(subagent)；**user 不弹面板**。runtime 缺失字段显「—」（旧消息无 runtime 场景）。thinking 折叠区（默认收起），senseCalls 列表挂在 content 下方。消息级 runtime 见 [agent-pet.md §5.7](../../agent-pet.md)。
  - **双布局**（`layout` prop，[HistoryDrawer](../../../web/src/features/agent/HistoryDrawer.vue) 按 opened chat 是否子 chat 传 `"direct"|"group"`）：
    - **group**（默认，主 chat 合并视图）：master/subagent 双头像（发言者大 + 对方小徽章），均左排；user 右。**发言者 = caller（派发方）**，按 `callerIsMaster` 区分多级 spawn（见 [agent-pet.md §5.8.9](../../agent-pet.md)）：master 消息（父→子派发 prompt）发言者大头像——单层（主→子）= 主 pet（pet-master + masterText）/ 多级（子→孙）= 上层子 pet（pet-sub + callerPetFace）；role 消息（子回复）徽章同理。多级时两头像均 pet-sub 紫，靠 face emoji + name-initial 区分。
    - **direct**（ghost 自身抽屉，opened chat 为子 chat）：单头像 1:1 布局——**master 靠右**（row-reverse，主 pet 名首字符头像，hover 面板翻向左侧防溢出）/ **subagent 靠左**（ghost emoji 头像）。master 消息由子 chat 自身 `user→master` 重映射得来（见 getHistory）。
- **SenseCallBox**（[SenseCallBox.vue](../../../web/src/features/agent/SenseCallBox.vue)）：sense 调用 box（assistant 消息内子项），显 senseName + 状态指示（⋯ running / ✓ done / ✗ error）+ arguments/result 可折叠 pretty-print（后端 arguments 契约为 JSON 字符串）。
- **getHistory action + StreamState.history/historyLoaded/historyDirty**：只有 `chat.get` 回放的 staged chunk（无 runId）经 `routeChunk` → `accumulateStaged` 重组为 `HistoryItem[]`；实时 checkpoint staged（带 runId）只表示阶段边界，不进入历史，避免与 `done.finalMessage` 叠成 thinking-only/content-only/完整消息三份。展示层再以纯函数按 msgId 合并多来源投影，不原地修改 store。主视图继续合并全部后代 chat，并按 `agentChatId` 反向溯源。抽屉打开期间，同一会话树的每个运行 Agent 各显一条 loading；先完成项保留“等待其他 Agent”，全部结束且稳定 300ms 后按 dirty 标记重新加载根与后代完整历史，再统一替换 loading。子 Agent done 会沿 parentChatId 把祖先历史标脏。
- **抽屉栈 + 跨层管理层**（[HistoryDrawer.vue](../../../web/src/features/agent/HistoryDrawer.vue) 重构）：单值 `activeHistoryChatId` 升级为**栈** `historyDrawerStack`（[uiState.ts](../../../web/src/stores/agents/uiState.ts)，无限层上限 5）。HistoryDrawer 拆为**栈容器**（v-for [HistoryDrawerPanel](../../../web/src/features/agent/HistoryDrawerPanel.vue) + 单遮罩 + ESC 关顶层）+ **单面板子组件**（chatId 驱动的 pet/layout/history/滚动/jumpToSpawn/宽度逻辑）。每层 z-index 递增（280 + N×10）；下层 panel 已挂载被遮盖、关闭顶层即时显现（无需重载历史）。
- **useHistoryDrawerManager**（[useHistoryDrawerManager.ts](../../../web/src/features/agent/useHistoryDrawerManager.ts)）：App 顶层 `provide`、后代 `inject` 的跨层管理层。统一抽屉栈操作（`openRoot` / `drillChild` / `closeTop` / `closeAll` / `switchTop`），SpawnRenderer「详情」、PetStage 打开、MessageBubble jumpToSpawn 均经此（不再层层 emit）。`loadHistory(chatId)` 透传 `store.getHistory`；`historyCache: Map` 接口预留消息缓存，**当前不启用命中**（实时对话一致性需脏标记/版本号设计，待后续）。
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
- **会话列表入口**（[AgentFab.vue](../../../web/src/features/agent/AgentFab.vue)）：`+` 下方加 ☰ "会话列表"按钮 → `historyListOpen=true` + `fetchHistoryList()`。
- **命名区分**：`HistoryDrawer`（单 pet 消息史，pet 工具栏 ▤）保留；`SessionList`（会话列表，☰）为 CP8 新组件。
- **隐藏不持久化**：重连重取 top-5，隐藏但仍 top-5 的 pet 会重现（transient，不增 schema）。

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

**运行中工具 icon（`sense_started` notification）**：auto 工具触发执行时后端推 `sense_started` `{id, senseName, arguments}`（confirm/manual 仍走 interrupt）。agents store `routeNotification` 据 `id` push 到 `stream.runningTools`（`{id,name}[]`），`accept`（`approvalId=id`）到达时按 id 移除，`done`/`error` 清空。前端缓存 `sense.tools`（含 `icon`）name→icon，未命中 fallback ⚙。

**RunningTools 组件**（[RunningTools.vue](../../../web/src/features/agent/RunningTools.vue)）：挂 [PetSprite](../../../web/src/features/pets/PetSprite.vue) `.meta-row` 右侧（PetToolbar 之后），多工具并发时并排多 icon；空间不足时 `.name` max-width+ellipsis 让位。每个 icon = 运行中工具的 `icon` 字段。

**todo 专用渲染（能力驱动，无专属 todo_worker）**：
- **历史对话框**（[MessageBubble.vue](../../../web/src/features/agent/MessageBubble.vue)）：`senseCalls` 渲染按 `call.name==="update_todo"` 分支——命中走 [TodoSenseBox.vue](../../../web/src/features/agent/TodoSenseBox.vue)（读 `call.args`(JSON)→`todos:[{content,status,activeForm}]`，checklist：pending☐ / in_progress▣spinner / completed✓+strikethrough），其余走通用 [SenseCallBox.vue](../../../web/src/features/agent/SenseCallBox.vue)。
- **pet 右侧侧栏**（[TodoPanel.vue](../../../web/src/features/agent/TodoPanel.vue)）：**能力驱动**——任何 pet（主/子）其 agent senseGroup（经 `sense.list` 解析为 sense 名集合）含 `update_todo` 即显示；读 `streams[pet.chatId].history` walk back 最近一次 `update_todo` senseCall 的 `args.todos`，只读勾选。todo 存在与否 = 是否在 senseGroup 里（无 task-scale 判断逻辑）。

## 留待

- **tokenizer 精确计算**：当前 `estimateTokens` = `Math.ceil(text.length / 4)` 字符近似（英文偏准、中文偏保守），后续接 js-tiktoken 等替换 `estimateTokens` 实现，调用点不变。
- **compact RPC**：PetToolbar `contextUsage ≥ 50%` 已预留 compact 按钮 + PetStage `handleCompact` TODO 占位，后端 compact RPC 未实现。
