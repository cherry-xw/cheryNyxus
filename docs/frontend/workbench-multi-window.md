# 工作台多窗口

本文维护当前浏览器工作台的窗口状态、会话选择、交互入口与验证方法。窗口状态由工作区 store 维护；会话、运行和审批事实由对应状态模块维护。

> 当前工作台由浏览器工作区窗口承载；每个预设拥有独立窗口状态。

## 目标

当前任务的总运行时长放在窗口底部上下文信息区的主 Agent 名字后，子 Agent 的各自运行时长也紧跟其名字，均先于模型、上下文和运行状态显示；“停止全部”留在该行右侧。三种视图均可从底部入口停止正在运行的任务树，工作台工具栏不再重复提供全流程停止。主 Agent 时间来自本次任务执行投影，子 Agent 时间来自各自执行记录；不足 10 分钟绿、10 至 30 分钟黄、之后红逐渐加深，停止或结束后定格。**审批等待（阻塞等待）期间总运行时长一并冻结（2026）**：底部用量条与各 Agent 时长为墙钟时长，审批等待期间冻结、决定后继续（`useWorkbenchAgentUsage` 经 `approvalWait` 入参跟踪待审批集合，累计审批暂停时长并从总/各 Agent 时长中扣减，数据源为工作台 `workspacePending` 中 kind=approval 且 pending/blocked 的交互），与精简视图节点「已等待」计时语义一致（节点树节点不再显示计时，2026-09-28）。原有“暂停/继续任务树”仍用于当前会话控制。

- **每预设一窗**：窗口内经**标题栏会话状态条**切换根会话（钢琴已降级为节点树彩蛋；切换入口 2026-09-16 从 rail 会话列表提升到标题栏 strip + 下拉）。
- **多窗口布局**：窗口模式可拖动/缩放，多窗口层叠/平铺同时可见，后开的盖前开的。
- **最小化**：窗口隐藏并保留任务栏入口，点击按当前窗口状态还原、聚焦或最小化，见[最小化与任务栏](#最小化与任务栏)。
- **待处理提醒**：树节点与 `WorkbenchAttentionIndicator` 显示当前审批及提问状态；标题栏提醒字段是否具有完整触发链，须以实际调用为准。

## 架构

### Store：窗口注册表（`apps/web/src/stores/workspace/uiState.ts`）

新增 `WorkbenchWindowState` 与 per-window actions，窗口 id = **presetId**（每预设一窗，重开复用状态）：

```ts
interface WorkbenchWindowState {
  id: string
  presetId: string
  presetName: string | null // 入口携带的预设名（空白工作台/会话未水合时角色编制据此解析，不靠会话推导）
  chatId: string | null // 当前根会话（会话列表切换）
  view
  minimized // 最小化状态
  mode
  position
  size // 窗口几何
  historyDrawerStack
  historyDrawerMode
  historyDrawerAnchor
  focused
  zOrder
  attentionBlink
}
```

- refs：`workbenchWindows`、`workbenchWindowOrder`（末尾=最上）、`focusedWorkbenchWindowId`
- actions：`openWorkbenchWindow(presetId, presetName?)` / `closeWorkbenchWindow` / `focusWorkbenchWindow` / `setWorkbenchWindowMinimized/Chat/View/Geometry/Blink/Drawer/WorkspaceBrowser`
- computed：`workbenchWindowsList`

### 数据层：多根观察（`apps/web/src/stores/chats/index.ts`）

移除模块级单例 `observedRootChatId`/`rootObservationEpoch`，删除 `closeStaleRootSubscriptions`，简化 `closeRootTimeline`/`observeRootTimeline` 支持并发多根订阅。底层 `rootSubscriptions` 本就按根 keyed，是历史硬阻塞，现可同开多根树。

### 根订阅栅栏的终态丢弃修复（2026-08-20）

`applyRootSubscriptionEvent` 的序栅栏三分支：`rootEventSeq <= eventSeq` 按重复静默丢弃 / `rootEventSeq !== eventSeq+1` 判 gap 触发 `reopenRootSubscription`（重拉权威快照）/ 正常路径应用并推进 cursor。

**问题**：工作台在打开根时间线时，订阅 cursor 基准（`openChat` 的 `eventSeq`）可能落后于并发事件；后续终态事件被当作重复丢弃时，根运行状态可能一直显示「执行中」。

**修复**：丢弃分支不再纯静默——终态事件且 transient 中仍有对应残留时，`flushRootDeltas` 后 `reopenRootSubscription` 重拉权威快照（`openChat` 的 `state.runs` 已空自愈）。判定函数 `isTerminalRootEvent`（`done`/`error`/`turn.cancelled`/`turn.completed`/`run.updated` 的 status ∈ `paused|completed|failed`）；残留检查避免无谓重拉（已清理则直接丢弃）。

## 组件

### `WorkbenchDialog.vue`（新，`apps/web/src/features/agent/workbench/`）

自包含窗口组件，`defineProps<{ windowId; presetId }>`。整段 `.workbench-shell` 子树从 AgentDialog 迁入：titlebar、MessageBranchTree、rail、角色 popout、右侧待处理抽屉、composer dock、resize handles。rail 的钢琴按钮已移除——钢琴仅经**节点树彩蛋**触发浮层出现（见 [pet/rendering.md#nyxus-钢琴彩蛋nyxuspianostrip](pet/rendering.md#nyxus-钢琴彩蛋nyxuspianostrip)）。

**rail 工具栏分组与 lite/对话显隐（2026-08-28，2026-09 对话模式扩展）**：右侧工具栏按三组划分——**主操作**（发送消息 / 暂停·继续任务树 / 暂停全部分支）、**会话**（新建会话 / 对话模式 / 查看上下文；会话列表 ≡ 按钮及其 popout 已于 2026-09-16 移除，切换入口上移标题栏会话状态条，见下「标题栏会话状态条」）、**视图与配置**（布局切换 / 卡牌阅读 / 折叠档位 / 角色配置）；布局切换按钮从标题栏下独立顶部位置挪入视图与配置组。会话组 icon 区分：对话模式用 ↺（回看完整对话，整屏会话视图）、查看上下文用 ❐（内容快照），替换原 ◷/◍ 双圆点避免混淆。**查看上下文侧边抽屉（2026-09-18）**：rail ❐ 按钮由 460px 小弹窗改为工作台内右侧抽屉（`workbench-context-drawer`，状态在 `useWorkbenchDialogController` 的 `contextDrawerOpen`）——与卡牌模式抽屉同款形态（参照 `MessageBranchTree` 的 tree-drawer）：遮罩 `--nx-z-drawer-mask` + 贴右缘面板 `--nx-z-drawer`，从标题栏下方延伸到底部、宽 `min(720px, 88%)`，40px 头部（标题 + ✕），占用条（inline）置于内容区顶部，主体滚动展示 `PromptSnapshotTip`（系统消息全文 + 工具定义）；内容排版统一 12px、去加粗（scoped `:deep()` 覆盖子组件样式）；Esc / 遮罩 / ✕ 关闭；历史抽屉内「上下文」hover 弹窗维持原样。**三视图模式（2026-09 扩展）**：标题栏 `WorkbenchViewToggle` 由两档（树/精简）扩为三档——**树 / 对话 / 精简**；对话模式（`ConversationView` 整屏会话视图）替代原「档案」docked 抽屉，精简是对话的紧凑展示方式（lite）。视图状态以 `liteStore.viewModeByWindow` 为单一事实源、per-window 持久化（`cherynyxus:workbench-view-mode:<windowId>`，旧两档键 `cherynyxus:workbench-lite-view` 读取时迁移），入口见 [`useWorkbenchViewMode.ts`](../../apps/web/src/features/agent/workbench/useWorkbenchViewMode.ts)。**lite/对话模式下隐藏无对应界面的按钮**：树视图类（发送消息 / 布局切换 / 卡牌阅读 / 折叠档位 / 暂停全部分支）——lite 的发送入口是底部输入框、对话模式有同款底部输入框（2026-09 起，见「会话视图（对话模式）」节），rail 的「发送消息」只对树视图 composer 有效故隐藏；「暂停·继续任务树」保留（lite 顶部的停止/继续是 abort/resume，与任务树 pause/resume 互补，用户拍板保留）；对话模式隐藏 composer dock 与 ctx 分割线（`.is-conversation`），消息列表内提问可直接作答（`QuestionRenderer` 可交互形态，见下）。**待处理入口归属（2026-09-27 树模式改版）**：树模式审批/提问不再有左下角浮窗与右侧铃铛（`WorkbenchAttentionSurface` 与铃铛按钮、`attentionCollapsed`/`attentionWindowOpen`/`toggleAttentionWindow` 状态整体删除）——待处理节点在树上持续闪烁，点击节点打开锚定交互卡（见 [Agent 运行图交互入口规范](../standards/modules/agent/runtime-diagram-interactions.md)），工作台标题栏仅保留不可点击的待处理图标（`WorkbenchAttentionIndicator`，持续闪烁 + hover 显示数量；树模式且有 pending 事项时出现，overlay 内部标题栏与 native/embedded 外层 title-actions 三处共用同一组件）；对话模式走消息列表内交互；精简模式点击待处理工具图标进详情抽屉（原铃铛「定位待处理交互」请求 `rootUi.attentionOpenRequest` 随铃铛一并移除）。**角色编制（rail ♟）统一入口（2026-09-20）**：composer 内的「小组角色编制」折叠面板已移除（⚙ 按钮不再存在），rail ♟ 按钮成为树/对话/精简三视图共用的角色编制入口——点击后打开更宽的纵向像素身份卡堆（泰拉瑞亚式冒险面板语言）：Y 轴从上到下为 C→B→A（A 最前/上层、C 最后/下层），默认每张卡只露出上半部分头部，角色名标签位于卡片头部、与卡片一体移动；鼠标移入某张卡片时，只将它之前的卡片沿 Y 轴下移（悬停 B 时 A 下移露出 B、悬停 C 时 A 和 B 都下移露出 C、悬停 A 不动），当前卡片和后面的卡片保持默认位置；移动只改 Y 轴偏移、Z 层级永远固定，离开后恢复默认位置；悬停时正在查看的卡保持全亮、外圈升级为亮金色描边，其余卡强烈压暗变灰，卡片外圈以粗黑边+淡细线+投影表现前后分层，便于区分当前查看与已移开的卡片。每张卡直接展示角色身份、当前模型、模型参数、上下文用量、能力和器官组；模型选项以装备槽形式直接点击切换，其他配置也在卡内编辑。rail 按钮 hover/click 展开、延迟关闭、交互锁定与外部点击关闭逻辑保持不变。**角色卡大脑选择按钮名称/模型大小字互切（2026-09-24）**：大脑选择区（choice-slot）每个按钮内默认「大脑名大字 + 模型名小字（8-9px）」，区块标题旁的 ⇄ 按钮一键互换整组大小字，字号过渡带轻微过冲回弹（像两气球通气：同刻互偿，无气球/连线视觉）。**思考等级动态调整（2026-09-24，仅工作台堆叠卡）**：悬停卡片时卡头右上浮现「💭 思考 · 档位」入口，点击展开泰拉瑞亚风**滑动高亮 switch**——独立金色色块左右平移 + Q弹（位置移动用 `power3.out` 不过冲——档位多且等宽密集排列，标题栏式弹性回弹过冲会甩到相邻/最高档，Q弹只保留横向挤压-回弹）+ 文字变色由遮罩随色块矩形裁切揭示（同标题栏 树/对话/精简 switch 的实现手法），档位列表按选中大脑的模型从后端 `getModelRecommendation` 拉取（与设置页同源），仅列该模型实际支持档位；选中档位作为**本次会话该角色的临时覆盖**（`RuntimeSelection.thinking`）经 `session.runtime.set` 生效，新会话回落大脑配置默认档位；切换大脑时原覆盖不在新模型可用档位里自动清除。实现见 [`RoleConfigPopover.vue`](../../apps/web/src/features/agent/runtime/RoleConfigPopover.vue)（`showThinkingControl`/`showRoleName` prop 门控，仅工作台堆叠卡开启，AgentDialog 角色卡保持原样）。

- chatId 来源：`useAgentDialogOptions({ chatId: () => win.chatId ?? null })`，不再读全局单例。
- **presetName 来源**：`useAgentDialogOptions` 同传 `presetName: () => win.presetName ?? null`——窗口打开时由**入口携带**（Nyxus 传预设名 `'cheryNyxus'`、Pet 传历史 summary 的 `preset` 名），不依赖 pet/session/history 推导。空白工作台（无历史会话、会话未水合）下角色编制、Nyxus 判定、`quickTargetRequired`、`roleMentions` 等据此立即正确。
- 几何/视图/最小化写回 per-window store actions。
- 树订阅：`observeRootTimeline(win.chatId, 'tree')`，close 清理。
- 最小化按钮写 `minimized=true`，shell `v-show` 隐藏。

### 分支创建后的工作台切换契约（2026-08-24）

输入草稿由 [useAgentDialogOptions.ts](../../apps/web/src/features/agent/composer/useAgentDialogOptions.ts) 按输入面板与会话保存在当前浏览器内存中；切换会话、收起和重新打开面板不清空文本或已上传附件。刷新页面前提示未提交内容，草稿不写入服务器或持久存储。上传绑定当前草稿代次，切换后迟到结果不进入新会话；发送期间及上传期间禁止重复提交，只有输入 ACK 成功才移除本次提交的文本和附件，失败可直接重试。

composer 在 `branchTarget` 存在时经 `chat.branch.create` 创建新根 Chat（`WorkbenchDialog.sendFromComposer`）；现有分支协议不接收附件，因此分支模式禁用附件添加，已有附件必须移除或返回普通输入后发送。创建 ACK 与后续时间线刷新分开处理，刷新失败不可提示重新创建。创建成功后的切换行为**按分支类型区分**：

- **`continuation`（从此处继续）**：切换工作台到新分支——`setWorkbenchWindowChat(windowId, created.chatId)` + `treeRootChatId = created.chatId`，新分支成为当前主流程，后续发送/交互落在新分支。
- **`detail`（解释该节点）**：**不切换**工作台会话/树——`setWorkbenchWindowChat` 与 `treeRootChatId` 均不更新，解释分支只作为轻量子分支渲染在当前树上（与子分支同级），核心主流程保持不变。
- 两种类型创建成功后都**无条件刷新** `taskTimeline`（`getTaskTimeline({ taskId, view: 'tree' })`，让新分支出现在树上）并 `openSession(created.chatId)` 打开会话。

与后端语义对齐：`detail` 永远不能成为 `active_branch_id` 主干（见 `apps/backend/src/service/chat/conversationBranch.ts` 与 [docs/backend/service/chat.md](../backend/service/chat.md#任务分支语义)「任务分支语义」），故前端只在 `continuation` 时切换工作台身份。

### 会话视图（对话模式）与历史抽屉分支管理契约（2026-08-24，2026-09 对话模式接管）

工作台的「档案」docked 抽屉已于 2026-09 移除，其能力并入**对话模式**——整屏会话视图 `ConversationView.vue`（`apps/web/src/features/agent/workbench/`），在 `.nyxus-branch-top` 内以 `embedded` 形态直接复用 `HistoryDrawerPanel`（消息气泡、分支级联切换、设为主流程、打包代际历史、工具折叠、子 Agent 显示模式、滚动 minimap 全部保留）。`ConversationView` 传 `conversation` 置位 + `taskBranches`（工作台 `liveTimeline.branches` 注入，按窗口隔离，不再写全局 `historyDrawerTaskBranches`）：

- **显示与入口**：标题栏 `WorkbenchViewToggle` 三档中的「对话」档 + rail 会话组「对话模式」按钮（两处共用 `useWorkbenchViewMode`，状态同步）；无当前会话时按钮禁用，画布显示既有空态「新建会话」。切换回树时 `closeHistoryGeneration()` 清理代际二层，避免残留展开。
- **级联下拉结构与显示条件**（`cascadeOptions` / `dropdownAsTitle`，`HistoryDrawerPanel.vue`）按是否对话模式/`historyDrawerMode` 分家：
  - **对话模式（conversation）**：下拉**恒显示**（`dropdownAsTitle` 有选项即显，窗口停在子 Agent 会话也保留，便于切回主流程）；选项为**四分类两级**——一级 = 会话类别（主 Agent 对话 / 子 Agent 对话 / 检视对话 / 废弃的分支对话），二级 = 该类别的会话（`checkStrictly` 可点任意一级/二级切换查看）：
    - **主 Agent 对话** = `activeBranchId` 主流程分支（active 未知时回退 `original`），标签「主流程 · 标题」
    - **子 Agent 对话** = 当前任务树内的子 Agent 会话（任务时间线参与会话 `sourceChatId`/actor + 会话目录 parent 链归属并集，按最近更新排序），标签「角色名/agentType · 首条 user 预览（缺省用更新时间）」
    - **检视对话** = `kind === 'detail'`（解释该节点）分支，标签「解释 · 标题」
    - **废弃的分支对话** = 非主流程分支（原流程 / 继续，已不再是最新主流程），标签「原流程/继续 · 标题」
    空的分类不展示。任务身份解析：优先取 `ChatSummary.taskId`；窗口停在子 Agent 会话（direct，summary 无 taskId）时沿 parent 链回退到根会话再取 taskId（`agents.rootChatForChat`）。**无任务分支的会话**（普通未分支会话）不再退化为「单个日期时间」——至少展示主 Agent（当前根会话）+ 存在的子 Agent 分类（子 Agent 数据来自根实时时间线节点源 / 会话目录 parent 链归属），检视/废弃因无分支不出现。
  - **overlay（全局抽屉）**：保持**两级**（一级=任务组、二级=分支会话）；**二级去除解释分支**——当前任务二级 `orderedTaskBranches` 过滤 `kind !== 'detail'`，其他任务二级过滤 `branchKind !== 'detail'`。解释分支对话不在此入口显示，仍可经节点树 / 工作台对话模式访问。
  - **显示条件**：对话模式有选项即显（含子 Agent direct 视图）；overlay 为 `layout === 'group'` 且（同 preset 可切换 root 会话 >1 **或** 任务分支数 >1），且当前 chat 非解释分支（overlay 打开解释分支会话时值不在二级选项中，降为静态标题 `titleText`）。
- **下拉切换（局部会话，不带动树/精简）**：`onSwitchCascade` 分支——对话模式经 `onSwitchChat` 回调只改写工作台**对话模式局部会话** `conversationRootChatId`（`useWorkbenchDialogController`，per-window），`ConversationView` 以派生值 `conversationViewChatId` 作 `key`/`root-chat-id` 重载面板；**不改写窗口会话**（`chatId`/`treeRootChatId` 不动），树/精简视图继续显示窗口根会话。窗口根被外部切换（标题栏状态条 / 任务浏览器 / 归档）时，`conversationRootChatId` 跟随 `treeRootChatId` 复位（watch 同步）。对话模式底部发送目标 = 局部会话，且**不发散**到窗口：目标为局部会话且不等于窗口根时跳过 `setWorkbenchWindowChat`/`activatePresetSession`，避免发送又把局部会话带回树/精简；抽屉路径透传当前 `historyDrawerMode` + `historyDrawerAnchor`（`manager.openRoot(cid, mode, anchor)`），保持 dock 锚定不回退 overlay。
- **「设为主流程」按钮**（`activateCurrentBranch`）：当前打开分支 `kind !== 'detail'` 且 `branchId !== activeBranchId` 时显示；点击经 `chat.branch.activate` 切换主干后刷新 `getTaskTimeline({ view: 'conversation' })`。`detail` 永远不能设为主干（对齐后端语义）。
- **底部输入框（2026-09，精简模式同款）**：`ConversationView` 纵向布局 = 会话面板（flex:1）+ 底部输入区（`.conversation-input`）——单行自适应 textarea（Enter 发送 / Shift+Enter 换行）+ 实心发送钮，视觉用会话面板 token（`--accent` 暖金系，非 lite 的 `--el-color-primary`）。**展开交互（2026-10，2026-11 显隐/图标重设计）**：默认 6 行（120px）上限；发送钮右上角有展开钮（`.conversation-expand-btn`，EP `Top` 矢量图标、展开态旋转 180° 表「收起」，el-tooltip 提示），**默认隐藏、仅当输入内容超过 2 行时出现**（行数按可视行计、含自动换行，`refreshInput` 重算高度时顺带测量 `inputLines`；内容回落 2 行以内自动收起展开态，避免「已展开却无法收起」），点击后输入框高度提升到**至少 12 行（`min-height: min(240px, 50vh)`）、最高窗口一半（`max-height: 50vh`）**，大段内容输入不再在小框中翻页滚动；状态存组件内 ref（`expandedInput`），不持久化。输入框高度重算在 `box-sizing: border-box` 下补上边框高度（原 `height = scrollHeight` 使盒子比内容矮 1px×2，空内容也挤出右侧细滚动条，2026-11 修复）。草稿与树 composer **共用 `text` 同一事实源**（`onConversationDraftInput` 直写 `text.value`，树端打开时经 `restoreEditor` 回填；切会话 stash 照常），发送走同一 `sendFromComposer`（分支目标/快速目标/附件提交语义一致）。输入区提示随行状态：发送错误行（`error`）、分支目标 chip（`composerBranchTitle`，✕ 只清目标不动草稿）、草稿附件计数 chip（附件管理仍在树视图输入框）。
- **待处理提问与审批在消息内处理（2026-09）**：对话模式不渲染树视图的待处理入口（原左下角浮窗与铃铛已随树模式改版整体移除，见「rail 工具栏分组」节）。消息列表里 `ask_user_question` 的渲染器 `QuestionRenderer` 在**等待中（call.status='running'）且命中 pending 提问批**时切换为可交互形态；匹配关系 `call.id = questionId`，提交走 `interactions.answer`。普通工具消息中若 `call.id` 命中 pending 审批，则由 `ApprovalInteractionRenderer` 显示独立审批气泡，允许直接接受或拒绝。两种交互都与树视图/精简视图共享同一交互状态，提交后卡片自动回退只读展示。`ConversationView` 打开时 `interactions.refresh()` 一次，确保消息列表内交互可用。
- **历史加载**：面板经 `manager.loadHistory(chatId, owner)` 获取 root 时间线（`view: 'conversation'`），与树订阅（`view: 'tree'`）、lite 读模型多 owner 并存；抽屉路径 owner 为全局 `history-drawer`，对话模式用 per-window owner `workbench:<windowId>:conversation`（切会话释放上一根、退出对话模式释放当前根，与树订阅 owner 模式一致，避免跨会话累积订阅）。对话模式切会话（下拉局部切换 / 窗口根外部切换）驱动 `conversationViewChatId` prop 变化 → 面板重载；标题栏状态条等外部切换经 `setWorkbenchWindowChat` 驱动 `treeRootChatId`，再由 watch 同步局部会话。
- **overlay 全局抽屉**：仍由 PetStage / 任务中心 / 归档设置等入口打开（`openHistoryRoot(chatId, 'overlay')`），App.vue 按 `historyDrawerMode === 'overlay'` 渲染独立历史窗，工作台不持有该路径。

### 三种视图的待处理交互入口

三种视图共用 `interactions` 状态和审批/提问提交结果，但入口分别归属于当前视图：树视图以待处理节点闪烁 + 点击节点打开锚定交互卡为入口（标题栏另有不可点击的待处理图标 `WorkbenchAttentionIndicator`，持续闪烁、hover 提示数量；2026-09-27 起替代旧左下角浮窗与铃铛）；对话视图在消息列表中直接处理提问，并在对应工具消息中显示可单独处理的审批气泡；精简视图点击待处理工具图标进入详情抽屉。精简视图中尚未消费的提问会让对应工具图标持续闪烁，开始提交后停止。

### `AgentDialog.vue`（精简）

仅保留「快速发送 composer」单例面板（Pet 单击打开）。移除全部 workbench 子树/脚本/样式。head 的 ⑂ 按钮与待处理抽屉 `@tree` 改为 `openWorkbenchWindow(presetId)`。

### 桌面窗口承载

`WorkspaceCyberWindow.vue` 承载工作台，`CyberDesktopHost.vue` 提供任务栏。窗口和最小化状态由工作区 store 维护；工作台没有独立胶囊组件。

### 入口：`PetToolbar.vue`

工具栏**第一个按钮**（🌳「工作台」）调 `agents.openWorkbenchWindow(presetId, presetName)`。presetId 回退链：`pet.presetId` → `historyList[].presetId`；**presetName 顺带取同条 `summary.preset`**（Pet 工作台以真实 presetId 开窗，预设名必须随窗携带——角色编制解析需要预设名）。无 preset 时按钮 `:disabled`。工具栏容器已有 `@click.stop`，不触发生单击 composer。

**打开即恢复会话**：新建窗口初始 `chatId: null`，空树不渲染。入口须在新建窗口时恢复该 preset 活跃根会话——Pet 用 `activeRootForPet(pet)`（`activeRootByPreset` 优先，回退 pet 当前会话），Nyxus 用 `activeNyxusChatId`（空则 `getActiveNyxus()` 取最近/新建）。仅当窗口 `chatId` 为空时设置，已存在窗口重开复用不覆盖当前浏览。

**入口携带预设名**：工作台入口把 `presetName` 与窗口身份一起传入；空白会话也使用窗口自己的预设信息解析角色编制，不依赖尚未加载的历史。浏览器窗口状态由工作区 store 维护。

**空态新建会话**：窗口 `chatId` 为空且无任何会话时渲染空态「新建会话」按钮（`WorkbenchDialog.createSession`）。该场景下 `presetName`/`isNyxus` 不再推导不到——2026-08-21 起入口随窗携带 `presetName`（`win.presetName` 打开即定），预设判定优先用 `win.presetName`：等于 `'cheryNyxus'`（Nyxus 窗口以预设名开窗）→ `createNyxusSession()`；普通预设窗口（稳定 id）→ 复用空白会话或 `createMasterPet({ preset })`，无 preset 名可解析时明确报错而非静默失败（`props.presetId` 与 `win.presetName` 双保险，仍以窗口自身为准而非会话推导）。空白会话匹配键同样按窗口形态区分（Nyxus 用 `preset` 名、普通预设用 `presetId`），避免 Nyxus 空白会话永不命中而重复新建。

## 通知与待处理交互

审批与提问事实由交互状态模块维护。树视图通过节点和标题栏待处理指示器展示，对话视图在消息内处理，精简视图通过工具详情处理。窗口焦点、最小化和提醒显示不改变审批权限，也不替代提交结果。

## 保留耦合点 / 未来工作

- **HistoryDrawer 仍为全局单例**：`useHistoryDrawerManager` 单注入，overlay 历史窗（PetStage / 任务中心 / 归档）继续写全局。工作台对话模式已脱离抽屉栈（`conversation` 置位 + `taskBranches` prop 注入，per-window 隔离）；per-window `historyDrawer*` store 字段仍未接线（最深依赖，建议独立小步）。
- **loadOptions 全局选项去重**：未引入共享机制，每窗口独立拉一次全局配置（可接受）。
- **Nyxus 窗口**：`NyxusCore` 单击入口现落 composer 面板，经 ⑂/工具栏进工作台；`activeNyxusChatId` 闭包捕获未按窗口参数化（后续如需）。

---

## 最小化与任务栏

工作区窗口最小化后从桌面隐藏，底部任务栏仍保留对应入口。`CyberDesktopHost` 根据窗口状态处理点击：最小化窗口还原并聚焦，当前聚焦窗口最小化，未聚焦窗口仅聚焦。图谱窗口通过工作区 store 的工作台操作同步状态。

最小化不停止后端运行；窗口关闭、会话订阅释放与任务停止是不同操作。窗口几何和生命周期由 `windowModel.ts`、`uiState.ts` 维护。

## 卡牌阅读与图谱方向联动

工作台图谱展示模式由**卡牌阅读开关单一入口**决定，不再提供独立的方向切换按钮：

- `useWorkbenchViewPreferences.ts`：`presentationMode` 改为由 `paperMode` **派生**（卡牌开 → `vertical-classic`，卡牌关 → `horizontal-signal`），不再独立持久化；load 时忽略旧持久化字段完成迁移（存量 `presentationMode='vertical-classic' && paperMode=false` 迁移为横向）。
- `WorkbenchDialog.vue`：删除独立 ⇥ 方向切换按钮；卡牌按钮是唯一方向入口，tooltip/aria 为「切换卡牌纵向视图 / 切换信号横向视图」。两种展示模式（纵向 Classic 渲染 / 横向 Signal Grid）共存，随卡牌开关切换。
- **fallback 豁免（实现结论：无需额外守卫）**：`fallbackToClassic`（`useWorkbenchDialogController.ts`）直接写 `presentationMode.value = 'vertical-classic'`，而联动 `watch` 只监听 `paperMode`，回退值不会被反向翻转；用户下次手动切换卡牌时联动按派生规则恢复，重载后派生值按 `paperMode` 重算（自然重试 Signal）。回退提示由既有 `graph.fallback` 视觉事件承担（「警告 // 图谱回退：Signal Grid 初始化失败，已回退 Classic」）。
- 投影/渲染契约见 [pet/nyxus-node-tree-maintenance.md#signal-grid-展示投影2026-09-02-返工契约二轮修订](pet/nyxus-node-tree-maintenance.md#signal-grid-展示投影2026-09-02-返工契约二轮修订)。

## 标题栏任务切换

工作台标题栏以 `WorkbenchSessionStrip.vue` 提供稳定任务快捷位，现行位置、状态和 tip 规则见下节。旧 rail「会话列表」按钮及 popout 已移除，不再作为切换入口。

- **标题栏挂载**：`App.vue` 在 `WorkspaceCyberWindow` 的 `title-actions` 插槽挂载 `WorkbenchSessionBar`，传入窗口、预设、活动会话和前台状态；选择任务后通过 `workspace.setWorkbenchWindowChat` 更新所属工作台。当前说明不提供Electron原生窗口入口。
- **数据与偏好**：实时状态只读应用级 `chat.overview` 订阅；稳定快捷位由 `useSessionStripPreferences.ts` 按预设持久化，并通过同源存储事件与 BroadcastChannel 同源页面间同步。组件不自行建立任务订阅，也不清除未查看记录。
- **全部任务入口**：`WorkbenchSessionBar.vue` 通过按 `windowId` 隔离的 `useTaskBrowserOverlay.ts` 打开所属工作台覆盖页；标题栏不再挂载会话下拉，`SessionDropdown.vue` 与专用分页逻辑已删除。

### 标题栏与全部任务页

任务目录接口、未查看记录、任务级概要字段、稳定标题栏和全部任务覆盖页在浏览器工作台有对应入口。任务页从 `TaskBrowser.vue` 进入，`useTaskBrowserController` 按工作台隔离查询与恢复状态，`taskBrowserModel.ts` 负责筛选请求、实时原位更新及纯文本命中片段，`useTaskBrowserOverlay.ts` 负责按窗口隔离开关、归档后的当前任务处理和查看确认前置判断。覆盖页打开时底层树、输入区、工具栏和离线操作不可接收交互，但工作台控制器、草稿状态与树订阅保持；结果查看只在目标树加载完成、窗口处于前台且覆盖页关闭后按 `resultId` 确认。定向验证见 `apps/web/test/workbench/taskBrowser.test.ts`、`apps/web/test/workbench/taskBrowserIntegration.test.ts` 与 `apps/web/test/taskCenter/taskCatalogStore.test.ts`。

#### 稳定标题栏

- 标题栏保持纯图标，不做水平滚动。每个预设保存 5 个稳定快捷位，并额外预留 1 个当前任务补位；宽窗口因此最多显示 6 个任务图标。当前任务已经占有可见快捷位时只高亮，不重复显示。
- 快捷位按 `taskKey` 持久化在前端工作台偏好中，以稳定 `presetId` 分区，legacy 场景才回退预设名；通过既有同源存储通知或 BroadcastChannel 同步同源页面。它不进入聊天协议，也不与任务中心“关注任务”混为同一状态。
- 新任务在首次满足“当前任务、运行中、待处理或存在未查看结果”且有空位时追加到末尾。任务状态变化、普通步骤推进、运行结束、查看结果和切换任务均不重排，也不自动移除；快捷位满时只更新“全部任务”入口提醒，不挤掉现有任务。
- 手动收起记录任务当时的 `attentionKey`。同一 key 下的普通进度更新不能重新加入；新 run、新待处理事项或新终态结果产生新的 key 后，若有空位才可重新加入。手动收起当前任务只移除其稳定快捷位，当前任务补位在离开该任务前仍保留。
- 窗口缩窄只改变可见数量，不修改持久顺序：从末尾暂时隐藏；当前任务的原槽被隐藏时，以当前任务补位显示且不形成第二份逻辑记录；恢复宽度后各项回到原位。至少保留当前任务补位与“全部任务”入口。
- 主图标由稳定 `taskKey`（即最初根会话 id）确定性映射到项目内固定线性图标集合，同一任务跨刷新、重启和窗口保持不变，不再随模型、工具或当前步骤改变。实时步骤、结果与时间只进入 tip。
- 运行中仅在主图标角落显示小状态图标并做轻微明暗闪烁，不使用 loading 或旋转。`prefers-reduced-motion` 下保持静态高亮；窗口不在前台时停止持续闪烁。待处理、暂停、停止、失败、完成和未查看使用静态小标记，颜色只作辅助，均需有可读名称。
- tip 可由鼠标与键盘进入，显示完整标题、最近要求、当前步骤或真实最新结果、更新时间和状态，并提供“从标题栏收起”。打开 tip 不清除未查看。

#### 全部任务入口与覆盖页

- 原标题栏下拉入口替换为“全部任务”图标。点击后只覆盖所属工作台的节点树内容区，标题栏保留可操作；输入区、底层节点树和其他工作台在覆盖期间不能误接收指针或键盘操作。
- 一张卡片对应一个任务，任务内分支合并。卡片通过 `chat.taskUsage.summaries` 批量读取真实累计 Token、轮次、模型请求和参与 Agent 数；空任务显示真实零值或未知值，请求失败显示缺失状态，不得根据 `taskKey` 伪造统计。当前上下文快照没有长期记录时明确显示“暂无快照”。更多菜单提供标题栏显示/收起和归档。**卡片高度（2026-09-21）**：不固定高度（不再 200px + overflow:hidden），内容多时卡片随内容撑开、全部区块可见；同网格行内的卡片仍等高（grid 拉伸）。**状态表达（2026-09-21）**：状态由卡片内状态徽章 + 整卡 4% 极淡状态底色表达，不使用顶部彩色描边线或左侧未读亮条；未查看由标题旁「未查看结果」徽章表达。
- 普通卡片点击打开任务活动主流程；解释分支不作为默认打开目标。任务与分支身份、状态、未查看和完整历史查询以[共享协议](../shared/protocol/websocket.md#工作台任务目录与结果查看记录)为准。
- 页面首次打开为三列/两列/一列响应式等高网格。搜索覆盖当前预设完整非归档历史的任务标题、用户提问和结果，返回来源明确的纯文本命中片段；状态、最近活动时间和排序使用相同的下拉按钮样式。“清除筛选”始终占位，未选择条件时禁用，并显示结果总数。
- 一次浏览期间冻结卡片顺序。实时状态只原位更新卡片；新任务显示“有新内容”提示，不再符合筛选的卡片暂留。用户主动刷新或改变筛选后才建立新结果快照。
- 普通打开恢复该工作台上次筛选、排序和滚动位置；从标题栏状态角标进入时使用对应筛选，但不覆盖普通入口的已保存条件。关闭覆盖页恢复原节点树位置和焦点。
- 浏览卡片、打开 tip 和后台预载均不算查看。只有任务切换完成、对应最新结果成功显示、窗口处于前台且覆盖页已关闭时才确认查看；迟到加载只能确认其携带的旧 `resultId`，不得清除期间产生的新结果。

#### 上下文与统计只读面板

概览无跳转至上下文的交互；分类图例为 ECharts Legend，支持开关系列与悬停联动，环图扇区使用原生放大。步骤图默认显示最近 48 步（窄窗 30 步），范围滑块高 28px，整列 axisPointer 阴影；无图表横向浏览器滚动条。工具调用为固定列的紧凑表格，数量不限，不使用独立方块。

阅读样式参考 [Microsoft Fluent 2 Typography](https://fluent2.microsoft.design/typography) 的基线对齐与正文/辅助信息层级；保留项目 12px 下限和正常字重。具体标题增加轻量标识、章节细分隔、参数隔行底色，长文用排版而非大卡片分割。ECharts 图例行为参考 [官方图例说明](https://echarts.apache.org/handbook/en/concepts/legend/)。

运行摘要并入左上上下文模块。小统计块使用可整除条目数的列数，等宽等高填满每一行；操作与媒体合计八项，采用四/二/一列。柱状图使用 ECharts Canvas 和 dataZoom 在固定宽度容器展示，按窗口宽度增加可见柱数，少量记录时按类别填满横轴；同一步的所有分类同时高亮。未来真实大数据查询必须先聚合或分段加载。

上下文阅读采用嵌入分隔线的轻量分类标签，不保留左侧分类栏或分类大外壳。具体条目名称使用 15px 正常字重，来源在旁侧弱化；正文行高 1.55，宽窗长文自动双栏连续排版，窄窗单栏，标题与后文尽量保持同栏。工具与技能各条内容直接列出，不再添加分类卡片边框。

图表使用 ECharts 绘制。步骤柱关联只读操作记录，悬停、点击或键盘选择后在图下显示轮次、步骤、输入占比及操作；汇总区点击统计数字可筛选操作明细。工具耗时、调用与失败合并为自适应多列卡片。正文按类别使用规则排版、技能说明与工具参数卡，无分类定位或复制按钮。缓存命中率仅以已报告请求为分母；未知图片、语音和操作数量不能补成零。操作记录只供展示，命令与路径不得执行。

- 工作台右侧“查看上下文”进入两页签的上下文与统计面板。面板打开后按任务根身份读取 `chat.taskUsage.detail` 与 `chat.contextContent`；列表页和每日热力图分别使用批量摘要、日统计和日期任务查询。服务端失败时显示错误或已保存内容状态，不显示假数据掩盖真实失败；无真实任务时显示空态提示。
- 从未发送用户消息的空任务不显示卡片统计或“查看上下文”入口；面板查询也以首个真实模型请求为展示门槛。输入组成暂时为空时仍绘制最近 24 小时到当前时刻的空 X/Y 坐标轴和时间范围条，使“尚无数据”和“图表未加载”可区分。
- 面板只负责查看：统计概览与上下文内容两个页签；纪元选择、原因及交接说明并入上下文内容。它不提供修改配置、启停技能或工具、压缩、恢复、切换运行纪元等操作，也不得因为打开面板而调用模型。
- 已保存请求输入分类时，Token 变化默认按步骤（一次模型请求）显示固定宽度、直角堆叠柱并支持按轮次汇总；分类估算不能当作供应商累计账单。当前长期记录尚不包含完整分类时显示无记录空态，不得补全为完整分类。模型名称仅在真实记录或明确配置来源可用时展示。
- 工具定义列表常驻展示参数名称、类型、必填状态和格式化参数说明；工具长描述与完整定义收进“查看工具详情”弹窗，保存内容中的转义换行须还原为实际段落。没有可选纪元时不显示空的纪元选择框。
- 所有上下文环形图共用主题感知的提示层：提示层限制宽度并留在图表范围内，显示分类、Token、窗口占比及当前窗口汇总；背景、边框和文字随浅色/深色主题变化，不使用固定黑白配色。
- Agent 前三使用第二、第一、第三的卡片排列；后续使用行列表，详情原位增高，当前上下文采用横向堆叠条。正文与标题均用正常字重，最小字号 12px。上下文所有已保存正文按分类直接列出，工具名称突出，描述和参数以次要颜色完整展示。
- 统计范围固定说明为整个任务；Agent 与纪元选择只改变内容查看范围。所有 Agent 名称默认可见，累计消耗前三名默认显示详细卡片，其余可逐项原位展开。
- 真实任务入口必须读取真实接口；接口失败、字段尚未采集或历史缺失均保留错误、未知或空态，不显示假数据。
- 全部任务卡片通过 `context-analytics/public.ts` 将批量真实摘要转换为卡片模型，映射严格按响应 `taskKey` 完成。点击“查看统计”不打开普通任务。
- 全部任务筛选区下方固定显示每日 Token 热力图。统计范围是当前工作台全部非归档任务，不随状态、最近活动或排序筛选改变；日期字段必须来自 Token 消耗记录，不能用任务 `updatedAt` 代替。日历默认显示最近 364 天并包含当前周的未来占位，最多不超过 366 个闭区间日期，页面明确显示 IANA 时区。
- 日历使用 ECharts Calendar + Custom + VisualMap，矩形由 ECharts 创建并处理交互。完整、部分、未知、零消耗和未来日期保留数据语义；范围外、未来和无数据在视觉图例中合并为近乎透明的灰色，未知和未来不能补成零。选择日期后通过真实日期任务查询列出当天任务、Token 和覆盖状态，“查看统计”只打开该真实任务的只读统计，不触发普通任务卡片打开。
- 热力图不使用斜线纹理，图例与日历网格必须分开留出空间；颜色使用可区分的低饱和紫色阶梯。保留“最近活动”筛选并与日历联动：全部时间显示完整范围，24 小时、7 天和 30 天只显示对应日期区间；点击日期后，任务卡片按该日已有 Token 记录筛选，不使用 `updatedAt` 冒充消耗日期。卡片中的最近要求和最新结果只显示一行，超出部分省略；任务卡使用自适应紧凑网格和状态跳色，避免长期任务列表中卡片过高。
- 日历几何与独立调色板由 `context-analytics/dailyChart.ts` 维护：高度按容器可用高度分配七行，宽度按全年列数计算且不超过高度；切换日期范围不放大色块，窗口变化才重新分配。矩形圆角明确为 1px，横纵空隙均为 2px。使用 ECharts 官方 Custom 系列的矩形形状设置圆角，避免依赖 roundRect 默认半径；参考 [官方 Custom 文档](https://echarts.apache.org/en/option.html#series-custom)。范围外、未来、无数据共用近乎透明的灰色；零消耗为白色；正值从近白逐步过渡到深紫。图例和色块共用颜色表，悬浮与选中保持不透明。日期范围扩展到完整周，悬浮不触发日期筛选。定向验证见 `apps/web/test/workbench/contextDailyChart.test.ts`，代码验证不代替实际视觉验收。任务卡使用最大 `280px × 200px` 的固定密度网格。
- 任务卡第一行合并标题、状态和未读标记，右侧操作按钮缩小。环图旁只显示当前上下文、累计 Token、轮次、请求数和 Agent 数；最近要求与结果在下方各展示一次，标签与省略正文同行，阅读文字不小于 12px。
- 任务列表和日详情的滚动区域使用统一的细窄自定义滚动条：透明轨道、低对比圆角滑块，悬浮时才使用强调色；不依赖浏览器默认滚动条外观。

## 角色身份卡堆叠交互

本节描述角色身份卡的位置、遮挡和标签层级约束；实际视觉与交互效果仍由用户验收。

### 当前交互的不变量

角色卡堆叠必须先拆成两个互不混淆的方向：

- **Z 轴**只表示遮挡关系，固定为原始角色顺序 `A > B > C`。悬浮、离开和窗口变化都不能改变这个顺序。
- **Y 轴**只表示页面上的上下位置。默认位置按名字标签露出高度递增；悬浮某张卡时，只下移它之前的卡片，当前卡片和后面的卡片保持默认 Y 位置。
- 悬浮 A 或没有悬浮时，所有卡片回到默认位置。
- 名字标签属于独立的统一覆盖层，不能因为某张完整卡片的 Z 轴较高而被遮住。
- 卡片主体和标签显示不能通过整组位移互相影响；不允许使用一个额外的列表整体位移来代替单卡 Y 轴规则。

三张卡的验收表必须始终成立：

| 状态 | A 的 Y 位置 | B 的 Y 位置 | C 的 Y 位置 | 主体 Z 轴 |
| --- | --- | --- | --- | --- |
| 默认 / 悬浮 A | `0` | `peek` | `2 × peek` | `A > B > C` |
| 悬浮 B | 下移距离 | `peek` | `2 × peek` | `A > B > C` |
| 悬浮 C | 下移距离 | `peek + 下移距离` | `2 × peek` | `A > B > C` |

任何实现只要让当前卡片移动到 Y 轴第一位、改变主体 Z 轴顺序、重新排列角色数组，或让没有被要求移动的卡片发生整体位移，都不符合这张验收表。

### 后续发生理解异议时的处理方案

1. **先暂停修改，不把异议当成数值微调。**
   用户指出“反了”“不动”“被遮住”时，先判断是位置、层级、命中区域还是整体边界问题。未完成判断前不得继续改 `top`、`transform` 或 `z-index`。

2. **明确区分四个概念。**
   每次分析必须分别写出：
   - 卡片原始顺序；
   - 主体 Z 轴遮挡顺序；
   - 每张卡的 Y 轴坐标；
   - 名字标签所在的独立显示层。
   “上面”“下面”“前面”“置顶”等容易产生歧义的词，必须改写成“Y 轴更小”“Y 轴更大”“Z 轴更高”或“DOM 顺序更早”。

3. **先用三张卡做完整推演。**
   不得先推广到任意数量。必须先逐项写出 A、B、C 在四种状态下的 Y 和 Z，确认结果与用户描述一致后，再提取通用公式。

4. **出现表面要求冲突时，说明几何冲突并请求确认。**
   例如“完整卡片 A 在最高 Z 轴”与“B、C 的标签仍需显示”不能靠同一父层级直接同时实现。此时应明确指出冲突，提出“主体层 + 标签覆盖层”的结构方案，不能擅自通过反转 z-index 解决。

5. **把固定规则和动态规则分开验证。**
   固定规则包括卡片顺序、主体 Z 轴和标签层级；动态规则只包括悬浮索引与 Y 轴偏移。任何悬浮事件都不得同时修改两类规则。

6. **优先重建错误链路，而不是保留旧状态。**
   如果旧实现已经包含重排数组、活动卡片提层、整组位移等相互冲突的状态，应删除这些状态后重新实现，不在旧逻辑上叠加兼容分支。

7. **自动化验证必须检查行为公式，而不只检查字符串。**
   回归测试至少要覆盖：默认位置、悬浮 A、悬浮 B、悬浮 C、离开恢复，以及固定 `A > B > C`。源代码字符串断言只能确认结构存在，不能证明坐标和遮挡关系正确；实际视觉仍需由用户确认。

8. **不能把类型检查或测试通过当成视觉正确。**
   类型检查只能证明代码可编译，结构测试只能证明入口和代码片段存在。卡片遮挡、标签可见性、鼠标移动过程和窗口边界必须单独检查，并如实说明未完成的人工视觉验收。

### 修改前强制检查清单

- [ ] 是否已写出 A、B、C 的默认和悬浮状态表？
- [ ] 是否明确区分了 Y 轴位置和 Z 轴遮挡？
- [ ] 是否确认当前卡片不需要移动到 Y 轴第一位？
- [ ] 是否确认悬浮不改变主体 Z 轴？
- [ ] 是否确认未被要求移动的卡片不会被整体容器再次移动？
- [ ] 名字标签是否脱离完整卡片主体的层级上下文？
- [ ] 连续两次反馈仍错误时，是否已经停止调参数并回退算法模型？
- [ ] 测试是否验证了行为状态，而不是只验证源码字符串？
