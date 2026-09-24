# 节点树工作台多窗口化（Part 2）实现汇总

> 本文档记录节点树工作台从**单实例**改造为**每预设一窗**多窗口架构的完整实现细节。需求确认见记忆 `workbench-multi-window-plan`；Part 1（待处理交互右侧抽屉）已单独落地，见 `AgentDialog.vue`/`overlayLayers.ts`。

> **2026-08 迁移（Part 3）**：Electron 面工作台/设置改为**原生独立窗**，console 窗废弃，新增跨窗主题同步与深色灰边修复。详见文末 [Electron 原生独立窗迁移（Part 3）](#electron-原生独立窗迁移part-3)。

## 目标

- **每预设一窗**：窗口内经**标题栏会话状态条**切换根会话（钢琴已降级为节点树彩蛋；切换入口 2026-09-16 从 rail 会话列表提升到标题栏 strip + 下拉）。
- **多窗口布局**：窗口模式可拖动/缩放，多窗口层叠/平铺同时可见，后开的盖前开的。
- **最小化**：**（2026-09-03 起废弃胶囊，改为赛博桌面底部任务栏 tag）**最小化窗从桌面消失、仅任务栏保留 tag；点击 tag 按 Windows 交互三态切换——最小化窗还原+聚焦 / 当前聚焦窗最小化 / 打开未聚焦窗聚焦。详见文末 [最小化任务栏化与胶囊移除（2026-09-03）](#最小化任务栏化与胶囊移除2026-09-03)。（历史方案：缩成「小胶囊」可拖摆放、层叠——已移除。）
- **标题栏高亮**：收到需用户操作的通知时，窗口标题栏 + 胶囊加高亮闪烁。

## 架构

### Store：窗口注册表（`web/src/stores/agents/ui/uiState.ts`）

新增 `WorkbenchWindowState` 与 per-window actions，窗口 id = **presetId**（每预设一窗，重开复用状态）：

```ts
interface WorkbenchWindowState {
  id: string
  presetId: string
  presetName: string | null // 入口携带的预设名（空白工作台/会话未水合时角色编制据此解析，不靠会话推导）
  chatId: string | null // 当前根会话（会话列表切换）
  view
  minimized // 胶囊态
  mode
  position
  size // 窗口几何
  capsulePos // 胶囊摆放位置（可拖，持久化）
  historyDrawerStack
  historyDrawerMode
  historyDrawerAnchor
  focused
  zOrder
  attentionBlink
}
```

- refs：`workbenchWindows`、`workbenchWindowOrder`（末尾=最上）、`focusedWorkbenchWindowId`
- actions：`openWorkbenchWindow(presetId, presetName?)` / `closeWorkbenchWindow` / `focusWorkbenchWindow` / `setWorkbenchWindowMinimized/Chat/View/Geometry/CapsulePos/Blink/Drawer/WorkspaceBrowser`
- computed：`workbenchWindowsList`

### 数据层：多根观察（`web/src/stores/chats/index.ts`）

移除模块级单例 `observedRootChatId`/`rootObservationEpoch`，删除 `closeStaleRootSubscriptions`，简化 `closeRootTimeline`/`observeRootTimeline` 支持并发多根订阅。底层 `rootSubscriptions` 本就按根 keyed，是历史硬阻塞，现可同开多根树。

### 根订阅栅栏的终态丢弃修复（2026-08-20）

`applyRootSubscriptionEvent` 的序栅栏三分支：`rootEventSeq <= eventSeq` 按重复静默丢弃 / `rootEventSeq !== eventSeq+1` 判 gap 触发 `reopenRootSubscription`（重拉权威快照）/ 正常路径应用并推进 cursor。

**问题**：Electron 原生独立窗各自独立 renderer + Pinia store，工作台窗打开瞬间的 root 订阅 cursor 基准（`openChat` 的 `eventSeq`）可能落后于跨窗并发事件 → 后续终态事件（`done`/`error`/`turn.cancelled`/`turn.completed`/`run.updated{终态}`）落入「重复丢弃」分支时，该 run/turn 若在 `rootTimelineStates` transient 里仍有残留（曾被 delta 建立、终态被丢弃），就永远卡「执行中/工作中」，重启才自愈。

**修复**：丢弃分支不再纯静默——终态事件且 transient 中仍有对应残留时，`flushRootDeltas` 后 `reopenRootSubscription` 重拉权威快照（`openChat` 的 `state.runs` 已空自愈）。判定函数 `isTerminalRootEvent`（`done`/`error`/`turn.cancelled`/`turn.completed`/`run.updated` 的 status ∈ `paused|completed|failed`）；残留检查避免无谓重拉（已清理则直接丢弃）。

## 组件

### `WorkbenchDialog.vue`（新，`web/src/features/agent/workbench/`）

自包含窗口组件，`defineProps<{ windowId; presetId }>`。整段 `.workbench-shell` 子树从 AgentDialog 迁入：titlebar、MessageBranchTree、rail、角色 popout、右侧待处理抽屉、composer dock、resize handles。rail 的钢琴按钮已移除——钢琴仅经**节点树彩蛋**触发浮层出现（见 [pet/rendering.md#nyxus-钢琴彩蛋nyxuspianostrip](pet/rendering.md#nyxus-钢琴彩蛋nyxuspianostrip)）。

**rail 工具栏分组与 lite/对话显隐（2026-08-28，2026-09 对话模式扩展）**：右侧工具栏按三组划分——**主操作**（发送消息 / 暂停·继续任务树 / 暂停全部分支）、**会话**（新建会话 / 对话模式 / 查看上下文；会话列表 ≡ 按钮及其 popout 已于 2026-09-16 移除，切换入口上移标题栏会话状态条，见下「标题栏会话状态条」）、**视图与配置**（布局切换 / 卡牌阅读 / 折叠档位 / 角色配置）；布局切换按钮从标题栏下独立顶部位置挪入视图与配置组。会话组 icon 区分：对话模式用 ↺（回看完整对话，整屏会话视图）、查看上下文用 ❐（内容快照），替换原 ◷/◍ 双圆点避免混淆。**查看上下文侧边抽屉（2026-09-18）**：rail ❐ 按钮由 460px 小弹窗改为工作台内右侧抽屉（`workbench-context-drawer`，状态在 `useWorkbenchDialogController` 的 `contextDrawerOpen`）——与卡牌模式抽屉同款形态（参照 `MessageBranchTree` 的 tree-drawer）：遮罩 `--nx-z-drawer-mask` + 贴右缘面板 `--nx-z-drawer`，从标题栏下方延伸到底部、宽 `min(720px, 88%)`，40px 头部（标题 + ✕），占用条（inline）置于内容区顶部，主体滚动展示 `PromptSnapshotTip`（系统消息全文 + 工具定义）；内容排版统一 12px、去加粗（scoped `:deep()` 覆盖子组件样式）；Esc / 遮罩 / ✕ 关闭；历史抽屉内「上下文」hover 弹窗维持原样。**三视图模式（2026-09 扩展）**：标题栏 `WorkbenchViewToggle` 由两档（树/精简）扩为三档——**树 / 对话 / 精简**；对话模式（`ConversationView` 整屏会话视图）替代原「档案」docked 抽屉，精简是对话的紧凑展示方式（lite）。视图状态以 `liteStore.viewModeByWindow` 为单一事实源、per-window 持久化（`cherynyxus:workbench-view-mode:<windowId>`，旧两档键 `cherynyxus:workbench-lite-view` 读取时迁移），入口见 [`useWorkbenchViewMode.ts`](../../web/src/features/agent/workbench/useWorkbenchViewMode.ts)。**lite/对话模式下隐藏无对应界面的按钮**：树视图类（发送消息 / 布局切换 / 卡牌阅读 / 折叠档位 / 暂停全部分支）——lite 的发送入口是底部输入框、对话模式有同款底部输入框（2026-09 起，见「会话视图（对话模式）」节），rail 的「发送消息」只对树视图 composer 有效故隐藏；「暂停·继续任务树」保留（lite 顶部的停止/继续是 abort/resume，与任务树 pause/resume 互补，用户拍板保留）；对话模式隐藏 composer dock 与 ctx 分割线（`.is-conversation`），待处理审批与提问在对话模式仍走左下角浮窗（铃铛收起/展开），消息列表内提问可直接作答（`QuestionRenderer` 可交互形态，见下）。**角色编制（rail ♟）统一入口（2026-09-20）**：composer 内的「小组角色编制」折叠面板已移除（⚙ 按钮不再存在），rail ♟ 按钮成为树/对话/精简三视图共用的角色编制入口——点击后打开更宽的纵向像素身份卡堆（泰拉瑞亚式冒险面板语言）：Y 轴从上到下为 C→B→A（A 最前/上层、C 最后/下层），默认每张卡只露出上半部分头部，角色名标签位于卡片头部、与卡片一体移动；鼠标移入某张卡片时，只将它之前的卡片沿 Y 轴下移（悬停 B 时 A 下移露出 B、悬停 C 时 A 和 B 都下移露出 C、悬停 A 不动），当前卡片和后面的卡片保持默认位置；移动只改 Y 轴偏移、Z 层级永远固定，离开后恢复默认位置；悬停时正在查看的卡保持全亮、外圈升级为亮金色描边，其余卡强烈压暗变灰，卡片外圈以粗黑边+淡细线+投影表现前后分层，便于区分当前查看与已移开的卡片。每张卡直接展示角色身份、当前模型、模型参数、上下文用量、能力和器官组；模型选项以装备槽形式直接点击切换，其他配置也在卡内编辑。rail 按钮 hover/click 展开、延迟关闭、交互锁定与外部点击关闭逻辑保持不变。**角色卡大脑选择按钮名称/模型大小字互切（2026-09-24）**：大脑选择区（choice-slot）每个按钮内默认「大脑名大字 + 模型名小字（8-9px）」，区块标题旁的 ⇄ 按钮一键互换整组大小字，字号过渡带轻微过冲回弹（像两气球通气：同刻互偿，无气球/连线视觉）。**思考等级动态调整（2026-09-24，仅工作台堆叠卡）**：悬停卡片时卡头右上浮现「💭 思考 · 档位」入口，点击展开泰拉瑞亚风**滑动高亮 switch**——独立金色色块左右平移 + Q弹（位置移动用 `power3.out` 不过冲——档位多且等宽密集排列，标题栏式弹性回弹过冲会甩到相邻/最高档，Q弹只保留横向挤压-回弹）+ 文字变色由遮罩随色块矩形裁切揭示（同标题栏 树/对话/精简 switch 的实现手法），档位列表按选中大脑的模型从后端 `getModelRecommendation` 拉取（与设置页同源），仅列该模型实际支持档位；选中档位作为**本次会话该角色的临时覆盖**（`RuntimeSelection.thinking`）经 `session.runtime.set` 生效，新会话回落大脑配置默认档位；切换大脑时原覆盖不在新模型可用档位里自动清除。实现见 [`RoleConfigPopover.vue`](../../web/src/features/agent/runtime/RoleConfigPopover.vue)（`showThinkingControl`/`showRoleName` prop 门控，仅工作台堆叠卡开启，AgentDialog 角色卡保持原样）。

- chatId 来源：`useAgentDialogOptions({ chatId: () => win.chatId ?? null })`，不再读全局单例。
- **presetName 来源**：`useAgentDialogOptions` 同传 `presetName: () => win.presetName ?? null`——窗口打开时由**入口携带**（Nyxus 传预设名 `'cheryNyxus'`、Pet 传历史 summary 的 `preset` 名），不依赖 pet/session/history 推导。空白工作台（无历史会话、会话未水合）下角色编制、Nyxus 判定、`quickTargetRequired`、`roleMentions` 等据此立即正确。
- 几何/视图/最小化写回 per-window store actions。
- 树订阅：`observeRootTimeline(win.chatId, 'tree')`，close 清理。
- 最小化按钮写 `minimized=true`，shell `v-show` 隐藏。

### 分支创建后的工作台切换契约（2026-08-24）

输入草稿由 [useAgentDialogOptions.ts](../../web/src/features/agent/composer/useAgentDialogOptions.ts) 按输入面板与会话保存在当前 renderer 内存中；切换会话、收起和重新打开面板不清空文本或已上传附件。刷新或原生窗口销毁前提示未提交内容，草稿不写入服务器或持久存储。上传绑定当前草稿代次，切换后迟到结果不进入新会话；发送期间及上传期间禁止重复提交，只有输入 ACK 成功才移除本次提交的文本和附件，失败可直接重试。运行配置选择仍即时同步，输入面板显示同步中、已应用、等待运行边界或失败反馈。

composer 在 `branchTarget` 存在时经 `chat.branch.create` 创建新根 Chat（`WorkbenchDialog.sendFromComposer`）；现有分支协议不接收附件，因此分支模式禁用附件添加，已有附件必须移除或返回普通输入后发送。创建 ACK 与后续时间线刷新分开处理，刷新失败不可提示重新创建。创建成功后的切换行为**按分支类型区分**：

- **`continuation`（从此处继续）**：切换工作台到新分支——`setWorkbenchWindowChat(windowId, created.chatId)` + `treeRootChatId = created.chatId`，新分支成为当前主流程，后续发送/交互落在新分支。
- **`detail`（解释该节点）**：**不切换**工作台会话/树——`setWorkbenchWindowChat` 与 `treeRootChatId` 均不更新，解释分支只作为轻量子分支渲染在当前树上（与子分支同级），核心主流程保持不变。
- 两种类型创建成功后都**无条件刷新** `taskTimeline`（`getTaskTimeline({ taskId, view: 'tree' })`，让新分支出现在树上）并 `openSession(created.chatId)` 打开会话。

与后端语义对齐：`detail` 永远不能成为 `active_branch_id` 主干（见 `src/service/chat/conversationBranch.ts` 与 [docs/backend/service/chat.md](../backend/service/chat.md#任务分支语义)「任务分支语义」），故前端只在 `continuation` 时切换工作台身份。

### 会话视图（对话模式）与历史抽屉分支管理契约（2026-08-24，2026-09 对话模式接管）

工作台的「档案」docked 抽屉已于 2026-09 移除，其能力并入**对话模式**——整屏会话视图 `ConversationView.vue`（`web/src/features/agent/workbench/`），在 `.nyxus-branch-top` 内以 `embedded` 形态直接复用 `HistoryDrawerPanel`（消息气泡、分支级联切换、设为主流程、打包代际历史、工具折叠、子 Agent 显示模式、滚动 minimap 全部保留）。`ConversationView` 传 `conversation` 置位 + `taskBranches`（工作台 `liveTimeline.branches` 注入，按窗口隔离，不再写全局 `historyDrawerTaskBranches`）：

- **显示与入口**：标题栏 `WorkbenchViewToggle` 三档中的「对话」档 + rail 会话组「对话模式」按钮（两处共用 `useWorkbenchViewMode`，状态同步）；无当前会话时按钮禁用，画布显示既有空态「新建会话」。切换回树时 `closeHistoryGeneration()` 清理代际二层，避免残留展开。
- **级联下拉结构与显示条件**（`cascadeOptions` / `dropdownAsTitle`，`HistoryDrawerPanel.vue`）按是否对话模式/`historyDrawerMode` 分家：
  - **对话模式（conversation）**：下拉**恒显示**（`dropdownAsTitle` 恒 true，即使单分支）；打开时优先选中 `activeBranchId` 对应的主流程，选项平铺当前任务分支为**一级**（`orderedTaskBranches` 按 `branchOptionLabel` 打标：主流程/继续/解释，`checkStrictly` 可点解释分支切换查看）。解释分支对话仅经此一级选项可达。任务身份优先取 `ChatSummary.taskId`，当精简会话目录未包含当前分支时，从注入的 `taskBranches` 按 `chatId` 恢复，避免错误退化为日期时间标签。**无任务分支的会话**（非任务会话 / 分支已清空）仅显示当前会话单选项，绝不退化两级跨任务。
  - **overlay（全局抽屉）**：保持**两级**（一级=任务组、二级=分支会话）；**二级去除解释分支**——当前任务二级 `orderedTaskBranches` 过滤 `kind !== 'detail'`，其他任务二级过滤 `branchKind !== 'detail'`。解释分支对话不在此入口显示，仍可经节点树 / 工作台对话模式访问。
  - **显示条件**：对话模式恒显；overlay 为 `layout === 'group'` 且（同 preset 可切换 root 会话 >1 **或** 任务分支数 >1），且当前 chat 非解释分支（overlay 打开解释分支会话时值不在二级选项中，降为静态标题 `titleText`）。
- **下拉切换**：`onSwitchCascade` 分支——对话模式经 `onSwitchChat` 回调交给工作台（`setWorkbenchWindowChat(windowId, cid)`，树/精简/对话三视图随窗口会话整体跟随）；抽屉路径透传当前 `historyDrawerMode` + `historyDrawerAnchor`（`manager.openRoot(cid, mode, anchor)`），保持 dock 锚定不回退 overlay。
- **「设为主流程」按钮**（`activateCurrentBranch`）：当前打开分支 `kind !== 'detail'` 且 `branchId !== activeBranchId` 时显示；点击经 `chat.branch.activate` 切换主干后刷新 `getTaskTimeline({ view: 'conversation' })`。`detail` 永远不能设为主干（对齐后端语义）。
- **底部输入框（2026-09，精简模式同款）**：`ConversationView` 纵向布局 = 会话面板（flex:1）+ 底部输入区（`.conversation-input`）——单行自适应 textarea（Enter 发送 / Shift+Enter 换行）+ 实心发送钮，视觉用会话面板 token（`--accent` 暖金系，非 lite 的 `--el-color-primary`）。**展开交互（2026-10，2026-11 显隐/图标重设计）**：默认 6 行（120px）上限；发送钮右上角有展开钮（`.conversation-expand-btn`，EP `Top` 矢量图标、展开态旋转 180° 表「收起」，el-tooltip 提示），**默认隐藏、仅当输入内容超过 2 行时出现**（行数按可视行计、含自动换行，`refreshInput` 重算高度时顺带测量 `inputLines`；内容回落 2 行以内自动收起展开态，避免「已展开却无法收起」），点击后输入框高度提升到**至少 12 行（`min-height: min(240px, 50vh)`）、最高窗口一半（`max-height: 50vh`）**，大段内容输入不再在小框中翻页滚动；状态存组件内 ref（`expandedInput`），不持久化。输入框高度重算在 `box-sizing: border-box` 下补上边框高度（原 `height = scrollHeight` 使盒子比内容矮 1px×2，空内容也挤出右侧细滚动条，2026-11 修复）。草稿与树 composer **共用 `text` 同一事实源**（`onConversationDraftInput` 直写 `text.value`，树端打开时经 `restoreEditor` 回填；切会话 stash 照常），发送走同一 `sendFromComposer`（分支目标/快速目标/附件提交语义一致）。输入区提示随行状态：发送错误行（`error`）、分支目标 chip（`composerBranchTitle`，✕ 只清目标不动草稿）、草稿附件计数 chip（附件管理仍在树视图输入框）。
- **待处理提问列表内直接作答（2026-09）**：对话模式不内嵌独立待处理区（左下角浮窗对树/对话模式照常渲染，铃铛收起/展开语义不变）。消息列表里 `ask_user_question` 的渲染器 `QuestionRenderer` 在**等待中（call.status='running'）且命中 pending 提问批**时切换为可交互形态：选项可点选（单选互斥/多选叠加）、选项「补充」输入、「其他」也作为选项项（单选/多选视觉一致，点击展开自由文本输入，单选互斥/多选共存）、底部「提交回答」按钮——匹配关系 `call.id = questionId`（后端 question_items.question_id 即 call.id），提交走 `interactions.answer`（整批原子提交，草稿与浮窗/决策窗口**全局共享**：批内多题可逐卡作答，任一卡片提交整批；其他题未答时提交给出明确提示）。提交后交互项进入 resolving/completed，卡片自动回退只读展示（已回答/已取消）。`ConversationView` 打开时 `interactions.refresh()` 一次（后续由 `interaction.changed` 事件实时 upsert），确保列表内提问可交互。
- **历史加载**：面板经 `manager.loadHistory(chatId, owner)` 获取 root 时间线（`view: 'conversation'`），与树订阅（`view: 'tree'`）、lite 读模型多 owner 并存；抽屉路径 owner 为全局 `history-drawer`，对话模式用 per-window owner `workbench:<windowId>:conversation`（切会话释放上一根、退出对话模式释放当前根，与树订阅 owner 模式一致，避免跨会话累积订阅）。切会话（标题栏状态条 / 对话模式级联）经 `setWorkbenchWindowChat` 驱动 `treeRootChatId` → `ConversationView` prop 变化 → 面板重载。
- **overlay 全局抽屉**：仍由 PetStage / 任务中心 / 归档设置等入口打开（`openHistoryRoot(chatId, 'overlay')`），App.vue 按 `historyDrawerMode === 'overlay'` 渲染独立历史窗，工作台不持有该路径。

### `WorkbenchCapsule.vue`（新，`web/src/features/agent/workbench/`）

胶囊最小化 UI，`defineProps<{ windowId }>`。App.vue 按 `workbenchWindowsList` 中 `minimized===true` 渲染。

- **可拖**：指针捕获模式（复用 `useWorkbenchWindow.beginPointerInteraction` 风格），写 `setWorkbenchWindowCapsulePos`。
- **层叠**：`stackIndex` = minimized 列表位置，渲染 pos = capsulePos + index×偏移，后缩盖前缩，只露前标题。
- **hover z**：`focusWorkbenchWindow` 提 z 到顶。
- **还原**：`setWorkbenchWindowMinimized(false)` + `focusWorkbenchWindow`（mode/pos/size 保留）。
- **关闭**：`closeWorkbenchWindow`；工作台已不持有 docked 历史抽屉（对话模式为整窗视图，随窗销毁），overlay 全局抽屉不受影响。

### `AgentDialog.vue`（精简）

仅保留「快速发送 composer」单例面板（Pet 单击打开）。移除全部 workbench 子树/脚本/样式。head 的 ⑂ 按钮与待处理抽屉 `@tree` 改为 `openWorkbenchWindow(presetId)`。

### `App.vue`（多渲染）

authenticated 分支保留 `<AgentDialog />`，新增：

```vue
<WorkbenchDialog
  v-for="win in agents.workbenchWindowsList"
  :key="win.id"
  :window-id="win.id"
  :preset-id="win.presetId"
/>
<WorkbenchCapsule v-for="win in agents.workbenchWindowsList.filter((w) => w.minimized)" ... />
```

（胶囊渲染用 `template v-for` 包裹，避免 `v-for`+`v-if` 同元素作用域问题。）

### 入口：`PetToolbar.vue`

工具栏**第一个按钮**（🌳「工作台」）调 `agents.openWorkbenchWindow(presetId, presetName)`。presetId 回退链：`pet.presetId` → `historyList[].presetId`；**presetName 顺带取同条 `summary.preset`**（Pet 工作台以真实 presetId 开窗，预设名必须随窗携带——角色编制解析需要预设名）。无 preset 时按钮 `:disabled`。工具栏容器已有 `@click.stop`，不触发生单击 composer。

**打开即恢复会话**：新建窗口初始 `chatId: null`，空树不渲染。入口须在新建窗口时恢复该 preset 活跃根会话——Pet 用 `activeRootForPet(pet)`（`activeRootByPreset` 优先，回退 pet 当前会话），Nyxus 用 `activeNyxusChatId`（空则 `getActiveNyxus()` 取最近/新建）。仅当窗口 `chatId` 为空时设置，已存在窗口重开复用不覆盖当前浏览。

**入口统一携带预设名（2026-08-21）**：窗口 id/presetId 语义双通道——Nyxus 入口直接传**预设名** `'cheryNyxus'`（`CHERY_NYXUS_PRESET`），Pet/AgentDialog 入口传**真实 presetId**。为让 `useAgentDialogOptions` 的 `presetName` 不依赖可能为空的会话数据（空白工作台根因），三处入口（`NyxusCore.openWorkbench` / `PetToolbar.openWorkbench` / `AgentDialog` 的 `openWorkbenchForChat`/`openWorkspaceTree`）在 `openWorkbenchWindow` 第二参 / `bridge.openWindow` 的 `OpenWindowRequest.presetName` 统一携带预设名；`WorkbenchWindowState.presetName` 打开时存入，已存在窗口重开时防御性补写（入口解析失败留下的旧窗 presetName 恒 null 也可被后续打开纠正）。Electron 原生窗经 `OpenWindowRequest` → main `extraParams` → URL `?presetName=` → App.vue 读入（见 [electron.md#多-surface-模型桌面宠物--独立原生窗](electron.md#多-surface-模型桌面宠物--独立原生窗)）。

**空态新建会话**：窗口 `chatId` 为空且无任何会话时渲染空态「新建会话」按钮（`WorkbenchDialog.createSession`）。该场景下 `presetName`/`isNyxus` 不再推导不到——2026-08-21 起入口随窗携带 `presetName`（`win.presetName` 打开即定），预设判定优先用 `win.presetName`：等于 `'cheryNyxus'`（Nyxus 窗口以预设名开窗）→ `createNyxusSession()`；普通预设窗口（稳定 id）→ 复用空白会话或 `createMasterPet({ preset })`，无 preset 名可解析时明确报错而非静默失败（`props.presetId` 与 `win.presetName` 双保险，仍以窗口自身为准而非会话推导）。空白会话匹配键同样按窗口形态区分（Nyxus 用 `preset` 名、普通预设用 `presetId`），避免 Nyxus 空白会话永不命中而重复新建。

## 通知高亮（Phase E）

- **触发**：`streamRouter.routeNotification` 里 `interrupt`（审批）/`question_batch_requested`（提问）→ `setWorkbenchWindowBlinkForChat(chatId,true)`，遍历窗口匹配 `win.chatId===chatId` 或 chatId 属窗口根会话后代（`collectDescendantChatIds`）；**仅非聚焦窗**置 blink（聚焦窗用户正看着，闪烁属噪音）。
- **熄灭**：标题栏 pointerdown / 胶囊还原时清 blink；`accept`/`rejected`/`question_batch_completed` 后仅当该 chat 无挂起审批/提问批次才熄灭。
- **动画**：`.has-attention` 加 accent（深空电光强调色，随主题经 `var(--accent)` 翻转）box-shadow 外发光 + 边框脉冲 `@keyframes` infinite 恒开（应用不跟随 `prefers-reduced-motion`，见 `docs/frontend/settings.md` 动效降级约定）。

## 待操作面板（PendingOperationsPanel）交互优化（2026-08-22）

工作台右上「待操作」面板收敛全部待确认交互（审批 + 提问批次）。本次优化：

### 工具能力解释

- 后端审批注册时从 senseRegistry 注入 sense 定义 `description` → `ApprovalPayload.senseDescription` → interaction payload（[manager.ts](../../src/service/approval/manager.ts) / [observer.ts](../../src/service/chat/observer.ts)）。
- 审批卡不直接暴露「工具名 + 原始 action」。共享 [approvalPresentation.ts](../../web/src/utils/approvalPresentation.ts) 把 `senseName + arguments` 投影为标题（「大模型需要做什么」）、能力、行为、对象；未知自定义工具保留原名安全回退。**2026-11 精简**：审批界面不再显示「大模型发起 / 由你审批后执行」徽章与「批准后才会执行」总结句——`ApprovalSummary` 只留标题 + 能力/行为/对象，`InteractionCard` 卡头不再重复标题（标题由 `ApprovalSummary` 单一承载）。
- `config_manage` 按实际 `action` 显示「获取/修改/恢复配置参数」或「获取/保存/归档角色资产」；技术值（如 `get`）仅在完整参数中作为追溯信息保留。
- [ParsedArgs.vue](../../web/src/features/agent/cards/ParsedArgs.vue) 与递归 `ArgumentValue.vue` 解析 JSON 字符串、嵌套对象和数组，统一中文字段名；非法 JSON 仍以原文回退，不会丢失审批证据。**2026-11**：`完整操作参数` **默认收起**（点击 ▸ 展开），开关为**无边框纯文字**（内部已是 key:value 行，不再套胶囊边框）。
- 后端注入的 sense `description` 保留为默认折叠的深入能力说明，不再承担审批主标题。

### 节点展开与动画

- **布局放宽**：面板 `width` 300px → **440px**，内容不再细长。
- **展开限制 1**：`activeId` 状态一次只展开一个节点；点击卡片头切换（再点当前卡收起，`activeInitialized` 哨兵区分手动收起与 active 项移除）。
- **短/长节点**：收起节点仅显示卡片头（kind + 标题 + 状态，固定高度）；active 节点展开完整内容，`grid-template-rows 0fr↔1fr` + opacity CSS 动画。
- **隐藏动画**：`<TransitionGroup name="card">` —— 交互完成（decide/answer 后记录移出 pending）旧卡以 `translateX + scale + opacity` 渐隐消失，watch 自动激活下一个 pending 节点继续交互。
- **标题细字体**：卡片头标题 `font-weight` → 400（全区域去加粗）。
- **超高内容滚动（2026-08-22 修复）**：`.pending-card` 加 `flex-shrink: 0`。列表是 `flex-direction: column` + `max-height: min(52vh, 420px)`，卡片默认 `flex-shrink: 1` 会被 max-height 压缩 → grid 展开轨道 `1fr` 随之收缩、`.card-body` 的 `overflow: hidden` 裁剪超高选项 → 列表不出现滚动条，交互无法完成。`flex-shrink: 0` 令卡片高度 = 内容高度，超高内容撑起列表滚动（`.pending-panel-list` 的 `overflow-y: auto` 生效）。

### 可读性规范（2026-08-22 实测修订）

- **字号（2026-10 全局放大 +2，最小 12px）**：正文/按钮/选项 ≥ **15px**（卡片头标题 16px、次级/徽章 14px），弱化文字不低于 13px。`nyxusPopoverTheme.less` 节点弹窗随全局放大（原 8.5-11px → 12-13px，2026-10 → 14-15px）。
- **字重**：待确认面板与节点树弹窗全部 **400**（原 600/700/800 加粗去除，避免小字号糊字）。
- **工具解释排版**：`.sense-desc` 不设 `max-height` 滚动（避免内容被挤压小空间），随面板列表自然滚动；字号 15px（2026-10 全局放大后）、行高 1.65、正文色。
- **倒计时**：approval 卡头状态旁显示 `剩余 Ns`（后端 `deadlineAt` = createdAt + approval_timeout），归零变红显示「已超时」，`now` 250ms 定时器驱动。
- **语义标题**：待确认标题统一使用 `createApprovalPresentation`，不再只是 sense 英文名的中文替换。
- **同步入口**：节点树工作台、Pet 气泡、设置窗待办与轻量工作台共用 `ApprovalSummary + ParsedArgs`，同一审批在不同入口的标题、参数展示一致（2026-11 起不再有「审批责任标记」徽章，`ParsedArgs` 完整操作参数默认收起、无边框纯文字开关）。

### 左右分栏重构（2026-08-23）

「待操作」面板由「单列卡片列表（点卡头展开）」改为**「入口行 + 左右两栏」**，一屏内完成全部交互、不依赖滚动：

- **入口行**：`待操作` 标题 + 计数 + 下拉箭头 与 范围切换（当前树/全部）**同一行**（`.pending-panel-head` 为 flex 行，segmented 右对齐）；收起态不再重复 hint（切按钮自身即状态）。
- **左栏任务导航**（`.task-nav`）：任务小按钮**顺序排列**（参考卡牌阅读器左侧 title-strip，但顺序不交错），点击切换右栏详情（=`activeId`，天然互斥，替代原 `toggleActive` 展开/收起）。每页固定 8 个，超出后**点击 ▲/▼ 翻页**（`.page-up`/`.page-down`，不用滚动条）；`activeId` 被移除或聚焦到页外任务时自动翻页定位（`syncPageToActive` watch）。
- **右栏详情**（`.task-detail`）：当前任务内容**默认全部展开、不滚动**；顶部「在节点树中查看」链接 + sense 描述（`.sense-desc`），中部 ParsedArgs（审批）/ 选项表单（提问），底部**固定操作栏**（`.detail-actions`：接受/拒绝、提交回答），一屏可操作。
- **窗体简化**：去掉 `.card-body-wrap` 的 `grid-template-rows 0fr↔1fr` 折叠动画与两层嵌套，改为单层 `.panel-main` 两栏 flex；宽度 440px → **600px**。
- **保留契约**：`expanded`（整体收起/展开）、`scope`、`focusedInteraction` 聚焦、`locate` 事件、倒计时、draft 草稿、`pickNextActive` 自动激活——全部不变。

### 二次优化（2026-08-23，布局对调 + 单选交互）

- **左右对调**：内容展示固定**左栏**（`.task-detail`）；任务导航 + 操作按钮并入**右栏**（`.side-col`）：▲/▼ 分页 → 任务按钮 → 页码 → 底部操作区（`.side-actions`，`margin-top: auto` 贴列底）。操作不再占左内容底部整行，宽度不变、高度短一截。
- **单选提示**：选项区上方提示行 `.options-hint`——单选显示「单选 · 再次点击可取消」、多选显示「可多选」，明确告知单选可取消（用户此前困惑：选了选项又填「其他补充」以为叠加，实际互斥清空）。
- **提交状态关联**：`canSubmitOf` 前置判定——单选恰好 1 项或有「其他补充」输入、多选 ≥1，否则「提交回答」禁用（灰不可点）。
- **同步**：[WorkspaceSessionBrowser.vue](../../web/src/features/agent/attention/WorkspaceSessionBrowser.vue)（会话浏览器）同步单选提示 + 提交禁用逻辑。

### 内容撑开与空状态可见（2026-08-24 修复）

`.pending-panel` 高度 auto（仅 `max-height` 上限工作台可用空间），展开后纵向 flex 链若用 `flex-basis: 0`，会在 auto-height 容器中无确定尺寸可 grow 而**逐层塌陷为 0**（`.pending-panel-body` → `.panel-main` → `.task-nav` → `.task-nav-list`），配合 `overflow: hidden` 把全部内容（含 `.pending-panel-empty` 空状态）裁剪掉——面板只剩几像素高、无法交互。

**修复**：纵向 flex 链全部改 `flex-basis: auto`（保留 `flex-shrink` + `min-height: 0`）：

- **内容少/空**：面板高度 = 内容高度（由内容自然撑开，空状态「没有待操作任务」正常显示）。
- **内容超高**：面板被 `max-height` 截断为确定高度，左栏 `.task-detail` / 右栏 `.task-nav-list` 各自内部滚动（不超出工作台）。

涉及选择器：`.pending-panel-body` / `.panel-main` / `.task-nav` / `.task-nav-list`（`flex: 1 1 0` → `flex: 1 1 auto`）。横向链不受影响：`.task-detail` 的 `flex: 1` 是宽度分配，其高度由 `.panel-main` 的 `align-items: stretch` 决定。

### 高度上下限约束（2026-08-24）

`.pending-panel` 增加显式高度约束（上节 flex-basis: auto 链不变，min/max 兜底两端极端态）：

- **最小高度（仅展开态）**：`.pending-panel.is-expanded { min-height: 280px }`——内容少（如仅 1 个短任务）时也保证 1-2 个任务按钮 + 操作区 + 头部可容纳，不局促。收起态不撑高（收起态仅入口行约 36px，`min-height` 不应用避免产生透明拦截热区）。
- **最大高度固定上限**：`.pending-panel { max-height: min(560px, calc(100% - 44px)) }`——固定上限 560px 叠加窗口可用空间约束（`min()` 取小者）：任务满一页（8 个）+ 操作区 + 头部也能完整容纳，且窗口过小时不溢出。任务再多由左栏 `.task-detail` / 右栏 `.task-nav-list` 内部滚动承接。
- **native 面同步**：`.workbench-shell.is-native :deep(.pending-panel)` 同步为 `max-height: min(560px, calc(100% - 8px))` + `min-height: 280px`（仅保留其 `top: 8px` 定位差异），原生窗与浏览器 overlay 视觉一致。

## 待操作面板聚焦流水线重构（2026-09-02）

> 本节取代上方「左右分栏重构（2026-08-23）」「二次优化（2026-08-23）」「内容撑开与空状态可见（2026-08-24 修复）」「高度上下限约束（2026-08-24）」四节的**布局描述**（后两节的 flex-basis/高度约束结论仍适用，详见下方「保留契约」）；旧节仅存档。注意旧节「宽度 600px」记载与实现失真：重构前实际已是 820px。

用例驱动：旧结构「右栏任务列表 + 左栏详情 + 左栏内嵌问题两栏 + 栏底操作」形成之字形动线、两套选择范式混用、选项下弹出输入框破坏选择的原子性，且样式未随全仓直角化收敛。参照队列决策类交互的市场范式（Linear triage / macOS 弹窗队列）重构为**「Interrupt Queue 聚焦流水线」**——单层无嵌套，屏上永远只有一张聚焦工作卡：

### 新结构

- **状态头** `.pending-panel-head`（收起/展开入口行保留）：IRQ 徽记 + 「待操作队列」+ `N 项 · X/Y` 进度 + 范围切换（当前树/全部）+ 刷新；展开/收起动画沿用 gsap Flip（`Flip.getState` → 改状态 → rAF 内 `Flip.from`，`MOTION.sweep`）。
- **FOCUS CARD** `article.focus-card`（主体，唯一工作对象，全宽）：
  - 任务头行：kind 徽记（确认/回答）+ 标题（`createApprovalPresentation`）+ 倒计时 + 「在节点树中查看」定位；
  - approval：ApprovalSummary / 能力解释折叠块 / `<details>` 技术详情（ParsedArgs + FileChangeDiff）**全宽**展示；
  - question_batch：**步进器** `QuestionStepper.vue`——横向进度点 ●─○─○ + `Q1/3` + 题标题，一次只渲染一个问题；选项为**选项卡**（整卡按钮）；选中后备注输入行**内嵌选项卡内部**以 gsap Flip 展开（对整个 `.options` 容器取 getState，nextTick 后 `Flip.from`，兄弟行位移被补偿；数据结构 `optionNotes` 不变）；「上一题/下一题」翻题；**不自动跳题**（每个选中选项都带可选备注输入，选中即跳会打断备注输入，翻题一律走步进器手动）；
  - **底部动作栏两类任务同位** `footer.action-bar`：approval = [拒绝][接受]；question_batch = [提交回答]（`canSubmitOf` 前置禁用 + 已答 X/Y 进度文案）。
- **QUEUE 队列缩略带** `PendingQueueStrip.vue`（面板底部）：横向 chips（kind 徽记 + 标题 + 倒计时/状态），点击切换聚焦任务；键盘 ←/→ 循环（roving tabindex）；`flex-wrap: nowrap` + `overflow-x: auto`，active chip 变化 `scrollIntoView({block:'nearest', inline:'nearest'})` 跟随；定高 + `flex-shrink: 0` 防塌陷。**废除 `PAGE_SIZE` ▲/▼ 分页**（`page`/`pageItems`/`syncPageToActive` 移除）。

### 组件拆分

- `PendingOperationsPanel.vue`：状态头 + FocusCard + 全部有状态逻辑（drafts、activeId、activeQuestion、倒计时 tick、scope、expanded、decide/answer/校验）——`interactionSurfaceWiring.test.ts` 以源码字符串断言 `await interactions.decide(item, action)` / `await interactions.answer(item, submit)` / `countdownOf(item).expired` / `'已超时'` 必须留在本文件，且 `PendingInteractionFocus` 接口必须从此文件导出。
- `PendingQueueStrip.vue` / `QuestionStepper.vue`：纯展示子组件（props/emits），内联 scoped 样式（无伴生 less），不触 store、不 import gsap（动画由父级 `useGsap` context 统一调度）。OptionCard 不拆——备注行 Flip 须在选项列表层级取 getState 且直接读写 draft。

### 动效（GSAP）

- 全部经 `useGsap(panelRoot, setup)` 建立的 `gsap.Context`；事后触发的 tween（任务切换/题切换/Flip/stagger）一律 `ctx.add(fn)`，卸载 revert 全回收。
- 时长/缓动取 `utils/gsapCore.ts` 的 `MOTION`（sweep/panel/view/micro + easePanel）；只动画 transform/opacity；布局变化（展开、备注行）用 Flip 插件补偿；body `<Transition>` 只保留 opacity。
- 任务切换 crossfade+slide、题切换方向感知 slide、chips stagger 入场；`useMotionTier().spec.enter === 'opacityOnly'` 时位移/Flip 全部退化为 opacity，另保留 `matchMedia('(prefers-reduced-motion: reduce)')` 兜底。
- 倒计时 tick 改 `interactions.calibratedNow()`（serverClockOffsetMs 校准；首次 refresh 前偏移为 0，expired 翻转可能随校准跳变数秒，属预期）。

### 样式收敛

全直角 `border-radius: 0`（含 chips/选项卡/输入框/徽记，禁 999px 胶囊）；**移除 `backdrop-filter`**（实色 `color-mix` 补偿层级感）；字重 400（标题/主按钮上限 600）；中文阅读内容 ≥12px；颜色全部 `var(--nx-*)` / `var(--accent)` / `color-mix` 派生；hover 只用 transform/opacity。保留根定位（`top:44px; right:52px; width:820px; max-height:min(620px, calc(100% - 44px))`）、`.is-expanded { min-height: 280px }`、clip-path 切角与网格纹理、`.has-tasks` 徽记脉冲 keyframes（reduced 关闭）、light 主题 `:global(html[data-theme='light'] …)` 覆盖。

### 保留契约

props `rootChatId`/`focusedInteraction`、emit `locate`、挂载点 `WorkbenchDialog.vue` 签名与根类名 `pending-panel` + `is-expanded`（`WorkbenchDialog.scoped.less` 四处 `:deep(.pending-panel)` 依赖）；stores/interactions 的 pending/decide/answer/refresh；drafts 跨刷新；`canSubmitOf`/`questionAnsweredOf` 前置禁用、单选与 freeText 互斥、提交前完整性校验跳第一未答题；双向定位（focusedInteraction watch → 展开选中）；有任务自动展开/无任务自动收起、active 移除自动激活下一个（`pickNextActive`）；纵向 flex 链 `flex-basis: auto` + `min-height: 0` 结论（防塌陷，见旧节 2026-08-24 修复）。

### 本次改动文件

| 文件                                                                  | 变更                                               |
| --------------------------------------------------------------------- | -------------------------------------------------- |
| `web/src/features/agent/attention/PendingOperationsPanel.vue`         | 重写：状态头 + FocusCard 单层结构 + GSAP/Flip 动效 |
| `web/src/features/agent/attention/PendingOperationsPanel.styles.less` | 重写：全直角、去 backdrop-filter、token 色收敛     |
| `web/src/features/agent/attention/PendingQueueStrip.vue`              | 新：底部队列缩略带（键盘循环 + scrollIntoView）    |
| `web/src/features/agent/attention/QuestionStepper.vue`                | 新：问题步进器（进度点 + 上/下题）                 |
| `web/test/agents/pendingOperationsLayout.test.ts`                     | 重写：旧 DOM 断言 → 聚焦流水线结构断言             |

## 改动文件清单

| 文件                                                                                             | 变更                                                |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| `web/src/stores/agents/ui/uiState.ts`                                                            | 窗口注册表 + actions                                |
| `web/src/stores/agents/ui/streamRouter.ts`                                                       | 通知→blink 触发/熄灭                                |
| `web/src/stores/chats/index.ts`                                                                  | 移除根观察单例守卫                                  |
| `web/src/features/agent/workbench/WorkbenchDialog.vue`                                           | 新：自包含窗口组件                                  |
| `web/src/features/agent/workbench/WorkbenchCapsule.vue`                                          | 新：胶囊最小化                                      |
| `web/src/features/agent/composer/useAgentDialogOptions.ts`                                       | 参数化 chatId 来源（2026-08-21 加 presetName 入口） |
| `web/src/features/agent/workbench/useWorkbenchWindow.ts`                                         | 参数化 windowId + per-window key                    |
| `web/src/features/agent/chat/AgentDialog.vue`                                                    | 精简为 composer 单例                                |
| `web/src/features/agent/toolbar/PetToolbar.vue`                                                  | 工作台 icon 入口（携带 presetName）                 |
| `web/src/features/pets/nyxus/components/NyxusCore.vue`                                           | 工作台入口携带 `CHERY_NYXUS_PRESET`                 |
| `web/src/App.vue`                                                                                | 多窗口/胶囊渲染（workbench 面读 URL `presetName`）  |
| `web/src/features/desktop/desktopBridge.ts` + `web/electron/main.ts` + `web/electron/preload.ts` | `OpenWindowRequest` 透传 `presetName`               |

## 保留耦合点 / 未来工作

- **HistoryDrawer 仍为全局单例**：`useHistoryDrawerManager` 单注入，overlay 历史窗（PetStage / 任务中心 / 归档）继续写全局。工作台对话模式已脱离抽屉栈（`conversation` 置位 + `taskBranches` prop 注入，per-window 隔离）；per-window `historyDrawer*` store 字段仍未接线（最深依赖，建议独立小步）。
- **loadOptions 全局选项去重**：未引入共享机制，每窗口独立拉一次全局配置（可接受）。
- **Nyxus 窗口**：`NyxusCore` 单击入口现落 composer 面板，经 ⑂/工具栏进工作台；`activeNyxusChatId` 闭包捕获未按窗口参数化（后续如需）。

---

## Electron 原生独立窗迁移（Part 3）

> 2026-08-18。将设置 / 工作台从 console 大窗（单 BrowserWindow 内叠加）迁移为 **Electron 原生独立窗**（每预设一工作台窗），console 窗废弃；同时修复深色模式窗口边缘灰边，并顺带实现跨窗主题实时同步。需求确认见记忆 `electron-native-windows-plan`。

### 动机

- 设置 / 工作台当前渲染在 console 窗（`?surface=console`，1200×800 frameless）内部叠加，用户要求二者为**相互独立**的原生窗。
- 深色模式下窗口四周出现灰色边框：`html.dark` → element-plus dark css-vars → `color-scheme:dark` → Chromium 给根画布涂系统深灰；仅 desktop 透明窗锁了 `color-scheme:light`，其余窗未锁。

### 架构（Electron 面）

**主进程 = 唯一窗口生命周期管理者**：

- `ManagedWindow` 注册表（`web/electron/main.ts`），key = `'settings'` | `'wb:<presetId>'`，惰性创建 / 聚焦 / 复用 / hide 保活。
- 通用 `window:control` IPC，按 `BrowserWindow.fromWebContents(event.sender)` 定位窗口，免传 windowId、防伪造。
- bounds 持久化：`userData/window-state.json`，`move`/`resize` 去抖 400ms 保存，创建时 `screen.getAllDisplays()` 校验贴屏（只存 bounds，不存最大化态）。
- 主题广播：任一窗 `theme:changed` → main 对全部 managed 窗 `theme:set`。

**渲染层四 surface**（App.vue 分发）：

| surface                                                  | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `?surface=desktop`                                       | 桌面透明宠物窗（不变：PetStage/NyxusCore/AgentDialog）                                                                                                                                                                                                                                                                                                                                                                                                          |
| `?surface=settings`                                      | 设置原生窗：`WindowFrame`（标题栏三键/主题边框）内嵌 `<SettingsDialog native/>`（native 面隐藏自身 header，标题 + 打开配置文件夹按钮并入 WindowFrame 标题栏）                                                                                                                                                                                                                                                                                                   |
| `?surface=composer&chatId=xx&view=composer               | attention`                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 发消息（快速发送）原生窗：`WindowFrame` 外壳承载标题栏（标题=当前会话 pet 名，回退预设名），`title-actions` slot 放两个能力按钮——🌳 打开当前会话节点树工作台 + ! 待处理交互（有待处理时充能高亮：accent 金底白字 + 徽标脉动光晕；点击切 attention 视图）。`<AgentDialog native/>` 隐藏自绘标题栏，按钮操作经 `defineExpose` 暴露调用。待处理视图（`WorkspaceSessionBrowser` native 模式）**整窗铺满布局**（无二次内边距，列表区 `flex:1` 内部滚动 + `.inner-scrollbar` 弱化滚动条），按 `rootChatId` 会话分组（分组头显会话名 + 计数），顶部导航 chip 点击滚动定位到对应分组；「需确认 / 需回答」kind 标签全局双色高对比（金/紫实色底白字，native 与浮动窗一致） |
| `?surface=workbench&presetId=xx&chatId=xx&presetName=xx` | 工作台原生窗（每 preset 一窗）：**同用 `WindowFrame` 公共外壳**——`<WorkbenchDialog native/>` 隐藏自身 `.workbench-titlebar`，标题显示预设名、`attentionBlink` → 标题栏闪烁、关闭经 `defineExpose(closeWorkbench)` 由 WindowFrame `close` handler 接管（先释放根时间线订阅），另渲染 `HistoryDrawer`。`presetName` 由入口经 `OpenWindowRequest` 携带 → main `extraParams` 拼入 URL → App.vue 读 `?presetName=` 写 `win.presetName`（空白工作台角色编制解析必需） |
| 无 surface                                               | 浏览器单页（**逐字节不变**：应用内多工作台窗 + 胶囊 + overlay 设置 + 抽屉）                                                                                                                                                                                                                                                                                                                                                                                     |

每个原生窗是独立 renderer，各连一条 WS（后端 `ConnectionManager` 支持多连接）；跨窗状态只经 query（chatId/presetId）+ 少量 IPC（`workbench:open-chat` / `workbench:focus` / `window:focused` / `theme:set`）。

### 窗口生命周期

| 操作        | 设置窗                                     | 工作台窗                                                                                      |
| ----------- | ------------------------------------------ | --------------------------------------------------------------------------------------------- |
| 点 X 关闭   | **destroy**（无运行状态，重开重载 config） | **hide 不销毁**：WS 与 run 保持、任务继续；重开同 preset → show+focus 还原（任务可见/可继续） |
| 最小化      | 任务栏                                     | 任务栏，run 继续                                                                              |
| 最大化/还原 | 原生（双击标题栏 / Win+↑ / 拖边缘均可）    | 同左                                                                                          |

托盘点击 / `app.activate` / `second-instance`：原打开 console 壳窗 → **改为打开设置窗**（应用主界面锚点）。

### 通用窗口外壳能力（三件套）

- `useWindowFrame.ts`（`web/src/features/desktop/`）：composable，封装 `windowControl` / `onWindowMaximized` / `onWindowFocused` / `flashFrame` / `setBackgroundColor`；含 `lockWindowRootColorScheme()`（置 `documentElement.style.colorScheme='light'` + `<html>` 加 `window-surface` class —— 灰边修复核心）。
- `WindowFrame.vue`：**settings / workbench 公共外壳**。自绘 40px 标题栏（`-webkit-app-region: drag` + 双击最大化）+ 三键 + 主题边框，body slot 铺满；三键行为默认 `windowControl`，可经 `minimize`/`maximize`/`close` prop 覆盖（workbench 关闭先释放订阅），`attention` prop 驱动标题栏闪烁。**标题位置扩展点**：`title-actions` slot 紧贴标题右侧（`.window-frame-title-group` 内、与标题同行垂直居中，容器 `no-drag` 保证可点击）——settings 面在此放「打开配置文件夹」公共组件 `OpenConfigDirButton`（`App.vue` 接入），未来标题右侧功能统一在此 slot 扩展；`titlePointerDown` prop 透传标题栏点击（workbench 熄灭闪烁）。**终端窗例外（2026-09-21）**：terminal 面 `App.vue` 将 `title-actions` 设为 `flex:1` 撑满空白（把「清空」按钮推至右侧），并对容器加 `pointer-events: none`、子元素 `pointer-events: auto`——空白区鼠标穿透到标题栏 OS 拖拽区、元素本体保持可点击，否则「已连接」与「清空」之间的空白无法拖动窗口。**终端连接状态按钮（2026-09-21）**：终端窗 title-actions 由 `TerminalTitleActions.vue` 渲染连接信息 + 连接状态按钮（lucide `Link`/`Unlink` 成对图标）+ 清空按钮：已连接点两下确认断开（发送 exit）、未连接/断开点一下直接重连、连接中静态展示；`TerminalSurface` 传 `titleReconnect` 使独立终端窗隐藏面板内「选择连接预设」表单（工作台文件区 Terminal 标签保留原表单）。
- `windowControls.less`（`web/src/styles/`）：共享三键样式，从 ConsoleShell / WorkbenchDialog 抽取，统一来源。

settings / workbench 原生窗均包 `WindowFrame` 公共外壳。`WorkbenchDialog` 浏览器路径保留自身 `.workbench-titlebar` 外观（逐字节不变）；`native` 路径隐藏自身标题栏、由外壳承载，仅保留驱动语义：8 向 resize handles 隐藏、`mode` 恒 `'fullscreen'` 铺满、`attentionBlink` → 外壳标题栏闪烁 + `bridge.flashFrame()`。灰边锁定统一由 `WindowFrame.onMounted` 调 `lockWindowRootColorScheme()`。

### 灰边修复（三层统一方案）

1. **color-scheme 锁定**：`lockWindowRootColorScheme()`（settings / workbench 面统一由 `WindowFrame.vue` onMounted 调）对 settings / workbench 面 mount 时锁 `color-scheme:light`（DesktopSurface 既有机制扩展到全部 Electron 窗）。
2. **根画布兜底**（`theme.css`）：`html.window-surface, html.window-surface body, html.window-surface #app { background: var(--bg); }` —— 窗口边缘/圆角/拖拽残影显示主题底色而非系统灰/白。
3. **main 层 backgroundColor**：`theme.ts apply()` 在 Electron 面读当前主题 bg（`#16181d` 暗 / 亮色值）→ `bridge.setBackgroundColor()` → `win.setBackgroundColor()`，兜底首帧与 resize 边缘。

**跨窗主题同步**：`theme.toggle()` 成功后 `bridge.emitThemeChanged()` → main 广播 `theme:set` → 各 Electron 面订阅 `onThemeSet` → `applyFrom(theme)` + 重设 backgroundColor。此前各窗只在启动读 localStorage 不互相同步，本次补齐。**范围边界**：广播仅发 managedWindows（settings / workbench）；desktop 透明窗不接主题桥（`bindElectronThemeBridge` 对 `surface==='desktop'` 直接 return，避免 `setBackgroundColor` 铺不透明底色），主题独立。

### 跨进程盲点修复

desktop 面（桌面透明窗 renderer）此前有三处**直接调 store 打开工作台**，而工作台渲染在 console 窗（另一 renderer、另一 Pinia store）→ 点了无反应。迁移后统一经 `bridge.openWindow({kind:'workbench',...})` → main 建原生窗：

- `PetToolbar.vue` 工作台按钮
- `AgentDialog.openWorkspaceTree`（待处理抽屉「打开节点树」）
- `NyxusCore.openWorkbench` / `openSettings`（本就走 bridge，改新 API）

浏览器 fallback 全部保留现 store 路径（`desktopBridge()` 非 Electron 返回 undefined）。

### 改动文件清单（Part 3）

| 文件                                                   | 变更                                                                                                                                                                                           |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web/electron/main.ts`                                 | 删 console 全套；`ManagedWindow` 注册表 + settings/workbench 工厂 + `window:open/control/set-background/flash`/`theme:changed` IPC + bounds 持久化；托盘/activate/second-instance → 打开设置窗 |
| `web/electron/preload.ts`                              | 删 `ConsoleTarget`；新 bridge（openWindow/windowControl/onWindowMaximized/onWindowFocused/onWorkbenchFocus/onOpenChat/flashFrame/setBackgroundColor/emitThemeChanged/onThemeSet）              |
| `web/src/features/desktop/desktopBridge.ts`            | 同上镜像类型                                                                                                                                                                                   |
| `web/src/features/desktop/useWindowFrame.ts`           | 新：通用窗口外壳 composable + `lockWindowRootColorScheme`                                                                                                                                      |
| `web/src/features/desktop/WindowFrame.vue`             | 新：自绘标题栏外壳                                                                                                                                                                             |
| `web/src/styles/windowControls.less`                   | 新：共享三键样式                                                                                                                                                                               |
| `web/src/App.vue`                                      | surface 四分发；workbench 面同步注册 + focus/open-chat/flashFrame/主题订阅；删 console 分支与 `bindConsoleNavigation`                                                                          |
| `web/src/features/agent/settings/SettingsDialog.vue`   | `native` prop（铺满窗、去自拖拽/自三键、close→windowControl、mounted 加载）                                                                                                                    |
| `web/src/features/agent/workbench/WorkbenchDialog.vue` | `native` prop（fullscreen 恒置、三键走 windowControl、titlebar drag、resize 隐藏、attentionBlink→flashFrame）                                                                                  |
| `web/src/features/pets/nyxus/components/NyxusCore.vue` | 入口改 `openWindow`                                                                                                                                                                            |
| `web/src/features/agent/chat/AgentDialog.vue`          | 入口改 `openWindow`（含 `openWorkspaceTree` 盲点修复）                                                                                                                                         |
| `web/src/features/agent/toolbar/PetToolbar.vue`        | 入口改 `openWindow`（盲点修复）                                                                                                                                                                |
| `web/src/features/desktop/ConsoleShell.vue`            | 删除                                                                                                                                                                                           |
| `web/src/stores/theme.ts`                              | `applyFrom(theme)` + Electron 面 `setBackgroundColor` + `emitThemeChanged`                                                                                                                     |
| `web/src/styles/theme.css`                             | `html.window-surface` 兜底背景                                                                                                                                                                 |

浏览器面（无 surface）不受影响：`uiState.ts` workbenchWindows 注册表 / capsule / 几何 / `settingsOpen` 全部保留（浏览器多窗口模式照常），Electron 原生面下这些字段自然休眠。

## 最小化任务栏化与胶囊移除（2026-09-03）

> 本节取代上文 Phase D「`WorkbenchCapsule.vue` 胶囊最小化 UI」章节及「目标」中的胶囊描述。胶囊组件与配套字段已删除。

赛博桌面（`CyberDesktopHost`）底部任务栏（「◫ 活动窗口」）本就展示全部 workspace 窗（`workspaceWindowsTaskbarList` 不滤 `lifecycle==='minimized'`），工作台最小化后旧胶囊与之重复，故统一收敛：

- **`WorkbenchCapsule.vue` 删除**：App.vue 不再渲染胶囊；`WorkbenchWindowState.capsulePos` 字段与 `setWorkbenchWindowCapsulePos` action 移除。
- **`minimizeWorkbench` 去掉缩后置焦**：旧逻辑缩后 `focusWorkbenchWindow` 让胶囊处于层叠最上层，任务栏化后最小化窗不应保持 focused（否则任务栏 tag 的 `active` 高亮失真），直接 `setWorkbenchWindowMinimized(id, true)` 即可（该 action 内部已联动 `minimizeWorkspaceWindow` 转移焦点到下一个可见窗）。
- **任务栏 tag 点击 = Windows 三态**（`CyberDesktopHost.activate`）：
  - `lifecycle === 'minimized'` → 还原+聚焦（graph 类经 `setWorkbenchWindowMinimized(presetId, false)`，其余经 `restoreWorkspaceWindow`）；
  - 已聚焦 → 最小化（graph 经 `setWorkbenchWindowMinimized(presetId, true)`，其余经 `minimizeWorkspaceWindow`）；
  - 打开未聚焦 → 仅聚焦（沿用原 activate 的会话/设置/历史/树定位副作用）。
- **不涉及 Electron 原生工作台面**：native 窗最小化走 OS 三键/任务栏，无胶囊也无 web 任务栏，本变更不触达。

## 卡牌阅读与图谱方向联动（2026-09-02 返工）

工作台图谱展示模式由**卡牌阅读开关单一入口**决定，不再提供独立的方向切换按钮：

- `useWorkbenchViewPreferences.ts`：`presentationMode` 改为由 `paperMode` **派生**（卡牌开 → `vertical-classic`，卡牌关 → `horizontal-signal`），不再独立持久化；load 时忽略旧持久化字段完成迁移（存量 `presentationMode='vertical-classic' && paperMode=false` 迁移为横向）。
- `WorkbenchDialog.vue`：删除独立 ⇥ 方向切换按钮；卡牌按钮是唯一方向入口，tooltip/aria 为「切换卡牌纵向视图 / 切换信号横向视图」。两种展示模式（纵向 Classic 渲染 / 横向 Signal Grid）共存，随卡牌开关切换。
- **fallback 豁免（实现结论：无需额外守卫）**：`fallbackToClassic`（`useWorkbenchDialogController.ts`）直接写 `presentationMode.value = 'vertical-classic'`，而联动 `watch` 只监听 `paperMode`，回退值不会被反向翻转；用户下次手动切换卡牌时联动按派生规则恢复，重载后派生值按 `paperMode` 重算（自然重试 Signal）。回退提示由既有 `graph.fallback` 视觉事件承担（「警告 // 图谱回退：Signal Grid 初始化失败，已回退 Classic」）。
- 投影/渲染契约见 [pet/nyxus-node-tree-maintenance.md#signal-grid-展示投影2026-09-02-返工契约](pet/nyxus-node-tree-maintenance.md#signal-grid-展示投影2026-09-02-返工契约)。

## 标题栏任务切换（2026-09-17）

工作台标题栏以 `WorkbenchSessionStrip.vue` 提供稳定任务快捷位，现行位置、状态和 tip 规则见下节。旧 rail「会话列表」按钮及 popout 已移除，不再作为切换入口。

- **双 surface 挂载**：浏览器工作台挂在 `CyberWindow #title-actions`，Electron 原生工作台挂在 `WindowFrame #title-actions`；两处都由 `WorkbenchSessionBar.vue` 组合，切换目标使用任务概要的活动主流程 `openChatId`，既有 draft、树订阅和窗口生命周期不变。浏览器面额外传入工作台前台状态，原生面使用文档可见性与窗口焦点，后台不持续闪烁。
- **数据与偏好**：实时状态只读应用级 `chat.overview` 订阅；稳定快捷位由 `useSessionStripPreferences.ts` 按预设持久化，并通过同源存储事件与 BroadcastChannel 跨 renderer 同步。组件不自行建立任务订阅，也不清除未查看记录。
- **全部任务入口**：`WorkbenchSessionBar.vue` 通过按 `windowId` 隔离的 `useTaskBrowserOverlay.ts` 打开所属工作台覆盖页；标题栏不再挂载会话下拉，`SessionDropdown.vue` 与专用分页逻辑已删除。

### 标题栏与全部任务页替换契约（2026-09-17 已确认）

任务目录接口、未查看记录、任务级概要字段、稳定标题栏和全部任务覆盖页均已接入浏览器与 Electron 工作台。任务页从 `TaskBrowser.vue` 进入，`useTaskBrowserController` 按工作台隔离查询与恢复状态，`taskBrowserModel.ts` 负责筛选请求、实时原位更新及纯文本命中片段，`useTaskBrowserOverlay.ts` 负责按窗口隔离开关、归档后的当前任务处理和查看确认前置判断。覆盖页打开时底层树、输入区、工具栏和离线操作不可接收交互，但工作台控制器、草稿状态与树订阅保持；结果查看只在目标树加载完成、窗口处于前台且覆盖页关闭后按 `resultId` 确认。定向验证见 `web/test/workbench/taskBrowser.test.ts`、`web/test/workbench/taskBrowserIntegration.test.ts` 与 `web/test/taskCenter/taskCatalogStore.test.ts`。

#### 稳定标题栏

- 标题栏保持纯图标，不做水平滚动。每个预设保存 5 个稳定快捷位，并额外预留 1 个当前任务补位；宽窗口因此最多显示 6 个任务图标。当前任务已经占有可见快捷位时只高亮，不重复显示。
- 快捷位按 `taskKey` 持久化在前端工作台偏好中，以稳定 `presetId` 分区，legacy 场景才回退预设名；通过既有同源存储通知或 BroadcastChannel 同步浏览器与 Electron renderer。它不进入聊天协议，也不与任务中心“关注任务”混为同一状态。
- 新任务在首次满足“当前任务、运行中、待处理或存在未查看结果”且有空位时追加到末尾。任务状态变化、普通步骤推进、运行结束、查看结果和切换任务均不重排，也不自动移除；快捷位满时只更新“全部任务”入口提醒，不挤掉现有任务。
- 手动收起记录任务当时的 `attentionKey`。同一 key 下的普通进度更新不能重新加入；新 run、新待处理事项或新终态结果产生新的 key 后，若有空位才可重新加入。手动收起当前任务只移除其稳定快捷位，当前任务补位在离开该任务前仍保留。
- 窗口缩窄只改变可见数量，不修改持久顺序：从末尾暂时隐藏；当前任务的原槽被隐藏时，以当前任务补位显示且不形成第二份逻辑记录；恢复宽度后各项回到原位。至少保留当前任务补位与“全部任务”入口。
- 主图标由稳定 `taskKey`（即最初根会话 id）确定性映射到项目内固定线性图标集合，同一任务跨刷新、重启和窗口保持不变，不再随模型、工具或当前步骤改变。实时步骤、结果与时间只进入 tip。
- 运行中仅在主图标角落显示小状态图标并做轻微明暗闪烁，不使用 loading 或旋转。`prefers-reduced-motion` 下保持静态高亮；窗口不在前台时停止持续闪烁。待处理、暂停、停止、失败、完成和未查看使用静态小标记，颜色只作辅助，均需有可读名称。
- tip 可由鼠标与键盘进入，显示完整标题、最近要求、当前步骤或真实最新结果、更新时间和状态，并提供“从标题栏收起”。打开 tip 不清除未查看。

#### 全部任务入口与覆盖页

- 原标题栏下拉入口替换为“全部任务”图标。点击后只覆盖所属工作台的节点树内容区，标题栏保留可操作；输入区、底层节点树和其他工作台在覆盖期间不能误接收指针或键盘操作。
- 一张卡片对应一个任务，任务内分支合并。卡片通过 `chat.taskUsage.summaries` 批量读取真实累计 Token、轮次、模型请求和参与 Agent 数；空任务显示真实零值或未知值，请求失败显示缺失状态，不得根据 `taskKey` 分配演示统计。当前上下文快照没有长期记录时明确显示“暂无快照”。更多菜单提供标题栏显示/收起和归档。**卡片高度（2026-09-21）**：不固定高度（不再 200px + overflow:hidden），内容多时卡片随内容撑开、全部区块可见；同网格行内的卡片仍等高（grid 拉伸）。**状态表达（2026-09-21）**：状态由卡片内状态徽章 + 整卡 4% 极淡状态底色表达，不使用顶部彩色描边线或左侧未读亮条；未查看由标题旁「未查看结果」徽章表达。
- 普通卡片点击打开任务活动主流程；解释分支不作为默认打开目标。任务与分支身份、状态、未查看和完整历史查询以[共享协议](../shared/protocol/websocket.md#工作台任务目录与结果查看记录)为准。
- 页面首次打开为三列/两列/一列响应式等高网格。搜索覆盖当前预设完整非归档历史的任务标题、用户提问和结果，返回来源明确的纯文本命中片段；状态、最近活动时间和排序使用相同的下拉按钮样式。“清除筛选”始终占位，未选择条件时禁用，并显示结果总数。
- 一次浏览期间冻结卡片顺序。实时状态只原位更新卡片；新任务显示“有新内容”提示，不再符合筛选的卡片暂留。用户主动刷新或改变筛选后才建立新结果快照。
- 普通打开恢复该工作台上次筛选、排序和滚动位置；从标题栏状态角标进入时使用对应筛选，但不覆盖普通入口的已保存条件。关闭覆盖页恢复原节点树位置和焦点。
- 浏览卡片、打开 tip 和后台预载均不算查看。只有任务切换完成、对应最新结果成功显示、窗口处于前台且覆盖页已关闭时才确认查看；迟到加载只能确认其携带的旧 `resultId`，不得清除期间产生的新结果。

#### 上下文与统计只读面板

概览无跳转至上下文的交互；分类图例为 ECharts Legend，支持开关系列与悬停联动，环图扇区使用原生放大。步骤图默认显示最近 48 步（窄窗 30 步），范围滑块高 28px，整列 axisPointer 阴影；无图表横向浏览器滚动条。工具调用为固定列的紧凑表格，数量不限，不使用独立方块。

阅读样式参考 [Microsoft Fluent 2 Typography](https://fluent2.microsoft.design/typography) 的基线对齐与正文/辅助信息层级；保留项目 12px 下限和正常字重。具体标题增加轻量标识、章节细分隔、参数隔行底色，长文用排版而非大卡片分割。ECharts 图例行为参考 [官方图例说明](https://echarts.apache.org/handbook/en/concepts/legend/)。

运行摘要并入左上上下文模块。小统计块使用可整除条目数的列数，等宽等高填满每一行；操作与媒体合计八项，采用四/二/一列。柱状图使用 ECharts Canvas 和 dataZoom 在固定宽度容器展示，按窗口宽度增加可见柱数，少量记录时按类别填满横轴；同一步的所有分类同时高亮。未来真实大数据查询必须先聚合或分段加载，当前 Demo 不承担亿级原始记录渲染。

上下文阅读采用嵌入分隔线的轻量分类标签，不保留左侧分类栏或分类大外壳。具体条目名称使用 15px 正常字重，来源在旁侧弱化；正文行高 1.55，宽窗长文自动双栏连续排版，窄窗单栏，标题与后文尽量保持同栏。工具与技能各条内容直接列出，不再添加分类卡片边框。

图表使用 ECharts 绘制。步骤柱关联只读操作记录，悬停、点击或键盘选择后在图下显示轮次、步骤、输入占比及操作；汇总区点击统计数字可筛选操作明细。工具耗时、调用与失败合并为自适应多列卡片。正文按类别使用规则排版、技能说明与工具参数卡，无分类定位或复制按钮。缓存命中率仅以已报告请求为分母；未知图片、语音和操作数量不能补成零。Demo 操作只供展示，命令与路径不得执行。

- 工作台右侧“查看上下文”进入两页签的上下文与统计面板。面板打开后按任务根身份读取 `chat.taskUsage.detail` 与 `chat.contextContent`；列表页和每日热力图分别使用批量摘要、日统计和日期任务查询。服务端失败时显示错误或已保存内容状态，不用演示数据掩盖真实失败；仅无真实任务时才保留隔离的开发 fixture。
- 从未发送用户消息的空任务不显示卡片统计或“查看上下文”入口；面板查询也以首个真实模型请求为展示门槛。输入组成暂时为空时仍绘制最近 24 小时到当前时刻的空 X/Y 坐标轴和时间范围条，使“尚无数据”和“图表未加载”可区分。
- 面板只负责查看：统计概览与上下文内容两个页签；纪元选择、原因及交接说明并入上下文内容。它不提供修改配置、启停技能或工具、压缩、恢复、切换运行纪元等操作，也不得因为打开面板而调用模型。
- 已保存请求输入分类时，Token 变化默认按步骤（一次模型请求）显示固定宽度、直角堆叠柱并支持按轮次汇总；分类估算不能当作供应商累计账单。当前长期记录尚不包含完整分类时显示无记录空态，不得沿用 Demo 组成。模型名称仅在真实记录或明确配置来源可用时展示。
- 工具定义列表常驻展示参数名称、类型、必填状态和格式化参数说明；工具长描述与完整定义收进“查看工具详情”弹窗，保存内容中的转义换行须还原为实际段落。没有可选纪元时不显示空的纪元选择框。
- 所有上下文环形图共用主题感知的提示层：提示层限制宽度并留在图表范围内，显示分类、Token、窗口占比及当前窗口汇总；背景、边框和文字随浅色/深色主题变化，不使用固定黑白配色。
- Agent 前三使用第二、第一、第三的卡片排列；后续使用行列表，详情原位增高，当前上下文采用横向堆叠条。正文与标题均用正常字重，最小字号 12px。上下文所有已保存正文按分类直接列出，工具名称突出，描述和参数以次要颜色完整展示。
- 统计范围固定说明为整个任务；Agent 与纪元选择只改变内容查看范围。所有 Agent 名称默认可见，累计消耗前三名默认显示详细卡片，其余可逐项原位展开。
- Demo 数据只用于明确的隔离开发 fixture。真实任务入口必须读取真实接口；接口失败、字段尚未采集或历史缺失均保留错误、未知或空态，不能回退到 Demo。
- 全部任务卡片通过 `context-analytics/public.ts` 将批量真实摘要转换为卡片模型，映射严格按响应 `taskKey` 完成。点击“查看统计”不打开普通任务。
- 全部任务筛选区下方固定显示每日 Token 热力图。统计范围是当前工作台全部非归档任务，不随状态、最近活动或排序筛选改变；日期字段必须来自 Token 消耗记录，不能用任务 `updatedAt` 代替。Demo 默认显示最近 364 天并包含当前周的未来占位，最多不超过 366 个闭区间日期，页面明确显示 IANA 时区。
- 日历使用 ECharts Calendar + Custom + VisualMap，矩形由 ECharts 创建并处理交互。完整、部分、未知、零消耗和未来日期保留数据语义；范围外、未来和无数据在视觉图例中合并为近乎透明的灰色，未知和未来不能补成零。选择日期后通过真实日期任务查询列出当天任务、Token 和覆盖状态，“查看统计”只打开该真实任务的只读统计，不触发普通任务卡片打开。
- 热力图不使用斜线纹理，图例与日历网格必须分开留出空间；颜色使用可区分的低饱和紫色阶梯。保留“最近活动”筛选并与日历联动：全部时间显示完整范围，24 小时、7 天和 30 天只显示对应日期区间；点击日期后，任务卡片按该日已有 Token 记录筛选，不使用 `updatedAt` 冒充消耗日期。卡片中的最近要求和最新结果只显示一行，超出部分省略；任务卡使用自适应紧凑网格和状态跳色，避免长期任务列表中卡片过高。
- 日历几何与独立调色板由 `context-analytics/dailyChart.ts` 维护：高度按容器可用高度分配七行，宽度按全年列数计算且不超过高度；切换日期范围不放大色块，窗口变化才重新分配。矩形圆角明确为 1px，横纵空隙均为 2px。使用 ECharts 官方 Custom 系列的矩形形状设置圆角，避免依赖 roundRect 默认半径；参考 [官方 Custom 文档](https://echarts.apache.org/en/option.html#series-custom)。范围外、未来、无数据共用近乎透明的灰色；零消耗为白色；正值从近白逐步过渡到深紫。图例和色块共用颜色表，悬浮与选中保持不透明。日期范围扩展到完整周，悬浮不触发日期筛选。定向验证见 `web/test/workbench/contextDailyChart.test.ts`，代码验证不代替实际视觉验收。任务卡使用最大 `280px × 200px` 的固定密度网格。
- 任务卡第一行合并标题、状态和未读标记，右侧操作按钮缩小。环图旁只显示当前上下文、累计 Token、轮次、请求数和 Agent 数；最近要求与结果在下方各展示一次，标签与省略正文同行，阅读文字不小于 12px。
- 任务列表和日详情的滚动区域使用统一的细窄自定义滚动条：透明轨道、低对比圆角滑块，悬浮时才使用强调色；不依赖浏览器默认滚动条外观。

## 角色身份卡堆叠交互的分析教训与异议处理

本节记录角色身份卡堆叠重构中暴露出的理解错误，作为后续修改工作台交互时的强制检查依据。它不是某次修改的流水账，以下内容描述当前应遵守的分析方法和不变量。

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

### 之前理解错误的原因

1. **没有先把 A、B、C 的状态写成坐标表。**
   之前直接从已有代码调整 `top`、`peek` 和 `z-index`，没有先列出默认、悬浮 A、悬浮 B、悬浮 C 四种状态。因此“悬浮 B 时 A 下移”被错误翻译成“把 B 置为第一张卡并重新排序”。

2. **把“让卡片露出”误解成“把当前卡片置顶”。**
   目标是移动遮挡当前卡片的前方卡片，实际实现却多次把当前卡片放到 Y 轴最上方，甚至提升到最高 Z 轴。两者的结果相反：前者保持当前卡片的位置，后者改变了整组卡片关系。

3. **混淆了 Y 轴和 Z 轴。**
   “上面的卡片”在不同语境中可能表示页面上的 Y 轴位置，也可能表示 Z 轴遮挡层。之前的算法没有在变量、注释和验收表中明确写出轴向，导致位置重排和层级重排被放进同一个逻辑。

4. **把负间距列表模型当成了标签堆叠模型。**
   `完整卡片高度 - 标签高度`表示两张卡片只在底部重叠一小段，并不表示下一张卡只露出一个标签。卡片默认位置应由 `peek` 直接决定，不能由完整高度减法推导。

5. **错误地把固定 Z 轴方向写成了 `10 + index`。**
   这让 C 覆盖 B、B 覆盖 A，导致悬浮 B 时 B 仍被 C 遮住。后来改成反向数值后又发现名字标签同样被完整卡片遮住，说明只改数字不能解决层级结构问题。

6. **名字标签和完整卡片共用了同一个层级上下文。**
   标签放在各自卡片内部时，最高层卡片会连同自己的主体一起遮住其他卡片的标签。标签必须作为独立覆盖层渲染，不能继续通过子元素 `z-index` 试图穿过父卡片层级。

7. **额外的列表整体位移破坏了单卡规则。**
   `roleStackShift` 会在单卡 Y 位置计算之后再次移动整个列表，使本来应该保持不动的当前卡片和后续卡片也发生变化。边界处理不能改变用户已经明确的卡片移动关系。

8. **在错误模型上连续调参数，延长了错误。**
   多次反馈已经说明“当前卡片置前”的模型不对，但之前仍继续尝试修改偏移量、顺序和层级。出现同类反馈两次时，应立即停止调数值，回到需求状态表和 DOM 层级重新分析。

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
