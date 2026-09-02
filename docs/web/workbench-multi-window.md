# 节点树工作台多窗口化（Part 2）实现汇总

> 本文档记录节点树工作台从**单实例**改造为**每预设一窗**多窗口架构的完整实现细节。需求确认见记忆 `workbench-multi-window-plan`；Part 1（待处理交互右侧抽屉）已单独落地，见 `AgentDialog.vue`/`overlayLayers.ts`。

> **2026-08 迁移（Part 3）**：Electron 面工作台/设置改为**原生独立窗**，console 窗废弃，新增跨窗主题同步与深色灰边修复。详见文末 [Electron 原生独立窗迁移（Part 3）](#electron-原生独立窗迁移part-3)。

## 目标

- **每预设一窗**：窗口内经**会话列表**切换根会话（钢琴已降级为节点树彩蛋，切换语义由会话列表承接，见 [pet/rendering.md#工作台会话列表nyxussessionlist](./pet/rendering.md#工作台会话列表nyxussessionlist)）。
- **多窗口布局**：窗口模式可拖动/缩放，多窗口层叠/平铺同时可见，后开的盖前开的。
- **最小化**：缩成「小胶囊」——可拖摆放、多胶囊**层叠**（后缩盖前缩，前一个只露标题）、hover 调整 z 轴悬浮最上、可关闭或还原。
- **标题栏高亮**：收到需用户操作的通知时，窗口标题栏 + 胶囊加高亮闪烁。

## 架构

### Store：窗口注册表（`web/src/stores/agents/ui/uiState.ts`）

新增 `WorkbenchWindowState` 与 per-window actions，窗口 id = **presetId**（每预设一窗，重开复用状态）：

```ts
interface WorkbenchWindowState {
  id: string; presetId: string
  presetName: string | null   // 入口携带的预设名（空白工作台/会话未水合时角色编制据此解析，不靠会话推导）
  chatId: string | null       // 当前根会话（会话列表切换）
  view; minimized              // 胶囊态
  mode; position; size        // 窗口几何
  capsulePos                  // 胶囊摆放位置（可拖，持久化）
  historyDrawerStack; historyDrawerMode; historyDrawerAnchor
  focused; zOrder; attentionBlink
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

自包含窗口组件，`defineProps<{ windowId; presetId }>`。整段 `.workbench-shell` 子树从 AgentDialog 迁入：titlebar、MessageBranchTree、rail、会话列表/角色 popout、右侧待处理抽屉、composer dock、resize handles。rail 的钢琴按钮已移除——钢琴仅经**节点树彩蛋**触发浮层出现（见 [pet/rendering.md#nyxus-钢琴彩蛋nyxuspianostrip](./pet/rendering.md#nyxus-钢琴彩蛋nyxuspianostrip)）。

**rail 工具栏分组与 lite 显隐（2026-08-28）**：右侧工具栏按三组划分——**主操作**（发送消息 / 暂停·继续任务树 / 暂停全部分支）、**会话**（新建会话 / 会话列表 / 对话历史 / 查看上下文）、**视图与配置**（布局切换 / 卡牌阅读 / 折叠档位 / 角色配置）；布局切换按钮从标题栏下独立顶部位置挪入视图与配置组。会话组 icon 区分：对话历史用 ↺（回看）、查看上下文用 ❐（内容快照），替换原 ◷/◍ 双圆点避免混淆。**lite 极简模式下**隐藏无对应界面的按钮：树视图类（布局切换 / 卡牌阅读 / 折叠档位）与「暂停全部分支」；「暂停·继续任务树」保留（lite 顶部的停止/继续是 abort/resume，与任务树 pause/resume 互补，用户拍板保留）。**角色 popout（rail ♟）只读**：仅展示角色大脑/器官组信息，不提供编辑（`RoleConfigPopover` 传 `readonly`，选择区隐藏，资料卡 🔒 只读标）；编辑入口只在发送消息 composer 的角色卡片中。**会话列表 popout** 背景由硬编码深棕改主题 token（浅色适配，不再深底深字）。

- chatId 来源：`useAgentDialogOptions({ chatId: () => win.chatId ?? null })`，不再读全局单例。
- **presetName 来源**：`useAgentDialogOptions` 同传 `presetName: () => win.presetName ?? null`——窗口打开时由**入口携带**（Nyxus 传预设名 `'cheryNyxus'`、Pet 传历史 summary 的 `preset` 名），不依赖 pet/session/history 推导。空白工作台（无历史会话、会话未水合）下角色编制、Nyxus 判定、`quickTargetRequired`、`roleMentions` 等据此立即正确。
- 几何/视图/最小化写回 per-window store actions。
- 树订阅：`observeRootTimeline(win.chatId, 'tree')`，close 清理。
- 最小化按钮写 `minimized=true`，shell `v-show` 隐藏。

### 分支创建后的工作台切换契约（2026-08-24）

composer 在 `branchTarget` 存在时经 `chat.branch.create` 创建新根 Chat（`WorkbenchDialog.sendFromComposer`），创建成功后的切换行为**按分支类型区分**：

- **`continuation`（从此处继续）**：切换工作台到新分支——`setWorkbenchWindowChat(windowId, created.chatId)` + `treeRootChatId = created.chatId`，新分支成为当前主流程，后续发送/交互落在新分支。
- **`detail`（解释该节点）**：**不切换**工作台会话/树——`setWorkbenchWindowChat` 与 `treeRootChatId` 均不更新，解释分支只作为轻量子分支渲染在当前树上（与子分支同级），核心主流程保持不变。
- 两种类型创建成功后都**无条件刷新** `taskTimeline`（`getTaskTimeline({ taskId, view: 'tree' })`，让新分支出现在树上）并 `openSession(created.chatId)` 打开会话。

与后端语义对齐：`detail` 永远不能成为 `active_branch_id` 主干（见 `src/service/chat/conversationBranch.ts` 与 [docs/service/chat.md](../service/chat.md#任务分支语义)「任务分支语义」），故前端只在 `continuation` 时切换工作台身份。

### 历史抽屉分支管理契约（2026-08-24）

工作台历史抽屉（`openHistory` 经 `openHistoryRoot(id, 'workbench-docked', anchor)` 打开）标题栏的级联下拉与「设为主流程」按钮（`HistoryDrawerPanel.vue`）：

- **级联下拉结构与显示条件**（`cascadeOptions` / `dropdownAsTitle`，`HistoryDrawerPanel.vue`）按 `historyDrawerMode` 分家：
  - **workbench-docked（工作台）**：下拉**恒显示**（`dropdownAsTitle` 恒 true，即使单分支）；选项平铺当前任务分支为**一级**（`orderedTaskBranches` 按 `branchOptionLabel` 打标：主流程/继续/解释，`checkStrictly` 可点解释分支切换查看）。解释分支对话仅经此一级选项可达。**无任务分支的会话**（非任务会话 / 分支已清空）仅显示当前会话单选项，绝不退化两级跨任务；`taskBranches` 注入值按 `branch.taskId` 归属过滤（`switchSession` 切会话不更新全局 `historyDrawerTaskBranches`，残留分支不泄漏到别的任务）。
  - **overlay（全局抽屉）**：保持**两级**（一级=任务组、二级=分支会话）；**二级去除解释分支**——当前任务二级 `orderedTaskBranches` 过滤 `kind !== 'detail'`，其他任务二级过滤 `branchKind !== 'detail'`。解释分支对话不在此入口显示，仍可经节点树 / 工作台等入口访问。
  - **显示条件**：dock 恒显；overlay 为 `layout === 'group'` 且（同 preset 可切换 root 会话 >1 **或** 任务分支数 >1），且当前 chat 非解释分支（overlay 打开解释分支会话时值不在二级选项中，降为静态标题 `titleText`）。
- **下拉切换保持锚定**：`onSwitchCascade` 切根时透传当前 `historyDrawerMode` + `historyDrawerAnchor`（`manager.openRoot(cid, mode, anchor)`），dock 抽屉切分支后仍保持 dock 锚定，不回退 overlay。
- **「设为主流程」按钮**（`activateCurrentBranch`）：当前打开分支 `kind !== 'detail'` 且 `branchId !== activeBranchId` 时显示；点击经 `chat.branch.activate` 切换主干后刷新 `getTaskTimeline({ view: 'conversation' })`。`detail` 永远不能设为主干（对齐后端语义）。
- **native 面抽屉锚定**：`workbenchDrawerAnchor` 的标题栏偏移在 native 面（Electron 原生窗，标题栏由 WindowFrame 外壳承载于 shell 之外）为 0，浏览器面为 40px——保证抽屉顶部紧贴标题栏下沿，不留空白。
- **关闭工作台清理 docked 抽屉（2026-08-25）**：`closeWorkbench()`（窗口内关闭按钮，浏览器 + native 两路）与 `WorkbenchCapsule.close()`（胶囊关闭）在 `historyDrawerMode === 'workbench-docked'` 时先调 `closeAllHistory()` 清空全局单例抽屉栈/锚定——否则工作台关闭后历史抽屉及其遮罩残留页面（HistoryDrawer 读全局单例）。overlay 全局抽屉（可能属于 PetStage 等其他入口）保留不清。

### `WorkbenchCapsule.vue`（新，`web/src/features/agent/workbench/`）

胶囊最小化 UI，`defineProps<{ windowId }>`。App.vue 按 `workbenchWindowsList` 中 `minimized===true` 渲染。

- **可拖**：指针捕获模式（复用 `useWorkbenchWindow.beginPointerInteraction` 风格），写 `setWorkbenchWindowCapsulePos`。
- **层叠**：`stackIndex` = minimized 列表位置，渲染 pos = capsulePos + index×偏移，后缩盖前缩，只露前标题。
- **hover z**：`focusWorkbenchWindow` 提 z 到顶。
- **还原**：`setWorkbenchWindowMinimized(false)` + `focusWorkbenchWindow`（mode/pos/size 保留）。
- **关闭**：`closeWorkbenchWindow`；若全局单例处于 `workbench-docked`（历史抽屉归属本窗）则先 `closeAllHistory()` 清空抽屉与遮罩，overlay 抽屉不受影响。

### `AgentDialog.vue`（精简）

仅保留「快速发送 composer」单例面板（Pet 单击打开）。移除全部 workbench 子树/脚本/样式。head 的 ⑂ 按钮与待处理抽屉 `@tree` 改为 `openWorkbenchWindow(presetId)`。

### `App.vue`（多渲染）

authenticated 分支保留 `<AgentDialog />`，新增：

```vue
<WorkbenchDialog v-for="win in agents.workbenchWindowsList"
  :key="win.id" :window-id="win.id" :preset-id="win.presetId" />
<WorkbenchCapsule v-for="win in agents.workbenchWindowsList.filter(w=>w.minimized)" ... />
```

（胶囊渲染用 `template v-for` 包裹，避免 `v-for`+`v-if` 同元素作用域问题。）

### 入口：`PetToolbar.vue`

工具栏**第一个按钮**（🌳「工作台」）调 `agents.openWorkbenchWindow(presetId, presetName)`。presetId 回退链：`pet.presetId` → `historyList[].presetId`；**presetName 顺带取同条 `summary.preset`**（Pet 工作台以真实 presetId 开窗，预设名必须随窗携带——角色编制解析需要预设名）。无 preset 时按钮 `:disabled`。工具栏容器已有 `@click.stop`，不触发生单击 composer。

**打开即恢复会话**：新建窗口初始 `chatId: null`，空树不渲染。入口须在新建窗口时恢复该 preset 活跃根会话——Pet 用 `activeRootForPet(pet)`（`activeRootByPreset` 优先，回退 pet 当前会话），Nyxus 用 `activeNyxusChatId`（空则 `getActiveNyxus()` 取最近/新建）。仅当窗口 `chatId` 为空时设置，已存在窗口重开复用不覆盖当前浏览。

**入口统一携带预设名（2026-08-21）**：窗口 id/presetId 语义双通道——Nyxus 入口直接传**预设名** `'cheryNyxus'`（`CHERY_NYXUS_PRESET`），Pet/AgentDialog 入口传**真实 presetId**。为让 `useAgentDialogOptions` 的 `presetName` 不依赖可能为空的会话数据（空白工作台根因），三处入口（`NyxusCore.openWorkbench` / `PetToolbar.openWorkbench` / `AgentDialog` 的 `openWorkbenchForChat`/`openWorkspaceTree`）在 `openWorkbenchWindow` 第二参 / `bridge.openWindow` 的 `OpenWindowRequest.presetName` 统一携带预设名；`WorkbenchWindowState.presetName` 打开时存入，已存在窗口重开时防御性补写（入口解析失败留下的旧窗 presetName 恒 null 也可被后续打开纠正）。Electron 原生窗经 `OpenWindowRequest` → main `extraParams` → URL `?presetName=` → App.vue 读入（见 [electron.md#多-surface-模型桌面宠物--独立原生窗](./electron.md#多-surface-模型桌面宠物--独立原生窗)）。

**空态新建会话**：窗口 `chatId` 为空且无任何会话时渲染空态「新建会话」按钮（`WorkbenchDialog.createSession`）。该场景下 `presetName`/`isNyxus` 不再推导不到——2026-08-21 起入口随窗携带 `presetName`（`win.presetName` 打开即定），预设判定优先用 `win.presetName`：等于 `'cheryNyxus'`（Nyxus 窗口以预设名开窗）→ `createNyxusSession()`；普通预设窗口（稳定 id）→ 复用空白会话或 `createMasterPet({ preset })`，无 preset 名可解析时明确报错而非静默失败（`props.presetId` 与 `win.presetName` 双保险，仍以窗口自身为准而非会话推导）。空白会话匹配键同样按窗口形态区分（Nyxus 用 `preset` 名、普通预设用 `presetId`），避免 Nyxus 空白会话永不命中而重复新建。

## 通知高亮（Phase E）

- **触发**：`streamRouter.routeNotification` 里 `interrupt`（审批）/`question_batch_requested`（提问）→ `setWorkbenchWindowBlinkForChat(chatId,true)`，遍历窗口匹配 `win.chatId===chatId` 或 chatId 属窗口根会话后代（`collectDescendantChatIds`）；**仅非聚焦窗**置 blink（聚焦窗用户正看着，闪烁属噪音）。
- **熄灭**：标题栏 pointerdown / 胶囊还原时清 blink；`accept`/`rejected`/`question_batch_completed` 后仅当该 chat 无挂起审批/提问批次才熄灭。
- **动画**：`.has-attention` 加 accent（深空电光强调色，随主题经 `var(--accent)` 翻转）box-shadow 外发光 + 边框脉冲 `@keyframes` infinite 恒开（应用不跟随 `prefers-reduced-motion`，见 `docs/web/settings.md` 动效降级约定）。

## 待操作面板（PendingOperationsPanel）交互优化（2026-08-22）

工作台右上「待操作」面板收敛全部待确认交互（审批 + 提问批次）。本次优化：

### 工具能力解释

- 后端审批注册时从 senseRegistry 注入 sense 定义 `description` → `ApprovalPayload.senseDescription` → interaction payload（[manager.ts](../../src/service/approval/manager.ts) / [observer.ts](../../src/service/chat/observer.ts)）。
- 审批卡不直接暴露「工具名 + 原始 action」。共享 [approvalPresentation.ts](../../web/src/utils/approvalPresentation.ts) 把 `senseName + arguments` 投影为「大模型需要做什么」、能力、行为、对象和「由你审批后执行」标记；未知自定义工具保留原名安全回退。
- `config_manage` 按实际 `action` 显示「获取/修改/恢复配置参数」或「获取/保存/归档角色资产」；技术值（如 `get`）仅在完整参数中作为追溯信息保留。
- [ParsedArgs.vue](../../web/src/features/agent/cards/ParsedArgs.vue) 与递归 `ArgumentValue.vue` 解析 JSON 字符串、嵌套对象和数组，统一中文字段名；非法 JSON 仍以原文回退，不会丢失审批证据。
- 后端注入的 sense `description` 保留为默认折叠的深入能力说明，不再承担审批主标题。

### 节点展开与动画

- **布局放宽**：面板 `width` 300px → **440px**，内容不再细长。
- **展开限制 1**：`activeId` 状态一次只展开一个节点；点击卡片头切换（再点当前卡收起，`activeInitialized` 哨兵区分手动收起与 active 项移除）。
- **短/长节点**：收起节点仅显示卡片头（kind + 标题 + 状态，固定高度）；active 节点展开完整内容，`grid-template-rows 0fr↔1fr` + opacity CSS 动画。
- **隐藏动画**：`<TransitionGroup name="card">` —— 交互完成（decide/answer 后记录移出 pending）旧卡以 `translateX + scale + opacity` 渐隐消失，watch 自动激活下一个 pending 节点继续交互。
- **标题细字体**：卡片头标题 `font-weight` → 400（全区域去加粗）。
- **超高内容滚动（2026-08-22 修复）**：`.pending-card` 加 `flex-shrink: 0`。列表是 `flex-direction: column` + `max-height: min(52vh, 420px)`，卡片默认 `flex-shrink: 1` 会被 max-height 压缩 → grid 展开轨道 `1fr` 随之收缩、`.card-body` 的 `overflow: hidden` 裁剪超高选项 → 列表不出现滚动条，交互无法完成。`flex-shrink: 0` 令卡片高度 = 内容高度，超高内容撑起列表滚动（`.pending-panel-list` 的 `overflow-y: auto` 生效）。

### 可读性规范（2026-08-22 实测修订）

- **字号**：正文/按钮/选项 ≥ **13px**（卡片头标题 14px、次级/徽章 12px），弱化文字不低于 11px。`nyxusPopoverTheme.less` 节点弹窗同步放大（原 8.5-11px → 12-13px）。
- **字重**：待确认面板与节点树弹窗全部 **400**（原 600/700/800 加粗去除，避免小字号糊字）。
- **工具解释排版**：`.sense-desc` 不设 `max-height` 滚动（避免内容被挤压小空间），随面板列表自然滚动；字号 13px、行高 1.65、正文色。
- **倒计时**：approval 卡头状态旁显示 `剩余 Ns`（后端 `deadlineAt` = createdAt + approval_timeout），归零变红显示「已超时」，`now` 250ms 定时器驱动。
- **语义标题**：待确认标题统一使用 `createApprovalPresentation`，不再只是 sense 英文名的中文替换。
- **同步入口**：节点树工作台、Pet 气泡、设置窗待办与轻量工作台共用 `ApprovalSummary + ParsedArgs`，同一审批在不同入口的标题、参数和审批责任标记一致。

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

## 改动文件清单

| 文件 | 变更 |
|------|------|
| `web/src/stores/agents/ui/uiState.ts` | 窗口注册表 + actions |
| `web/src/stores/agents/ui/streamRouter.ts` | 通知→blink 触发/熄灭 |
| `web/src/stores/chats/index.ts` | 移除根观察单例守卫 |
| `web/src/features/agent/workbench/WorkbenchDialog.vue` | 新：自包含窗口组件 |
| `web/src/features/agent/workbench/WorkbenchCapsule.vue` | 新：胶囊最小化 |
| `web/src/features/agent/composer/useAgentDialogOptions.ts` | 参数化 chatId 来源（2026-08-21 加 presetName 入口） |
| `web/src/features/agent/workbench/useWorkbenchWindow.ts` | 参数化 windowId + per-window key |
| `web/src/features/agent/chat/AgentDialog.vue` | 精简为 composer 单例 |
| `web/src/features/agent/toolbar/PetToolbar.vue` | 工作台 icon 入口（携带 presetName） |
| `web/src/features/pets/nyxus/components/NyxusCore.vue` | 工作台入口携带 `CHERY_NYXUS_PRESET` |
| `web/src/App.vue` | 多窗口/胶囊渲染（workbench 面读 URL `presetName`） |
| `web/src/features/desktop/desktopBridge.ts` + `web/electron/main.ts` + `web/electron/preload.ts` | `OpenWindowRequest` 透传 `presetName` |

## 保留耦合点 / 未来工作

- **HistoryDrawer 仍为全局单例**：`useHistoryDrawerManager` 单注入，WorkbenchDialog 的 `openHistory`/锚点继续写全局。per-window `historyDrawer*` store 字段未接线（最深依赖，建议独立小步）。
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

| surface | 内容 |
|---------|------|
| `?surface=desktop` | 桌面透明宠物窗（不变：PetStage/NyxusCore/AgentDialog） |
| `?surface=settings` | 设置原生窗：`WindowFrame`（标题栏三键/主题边框）内嵌 `<SettingsDialog native/>`（native 面隐藏自身 header，标题 + 打开配置文件夹按钮并入 WindowFrame 标题栏） |
| `?surface=composer&chatId=xx&view=composer|attention` | 发消息（快速发送）原生窗：`WindowFrame` 外壳承载标题栏（标题=当前会话 pet 名，回退预设名），`title-actions` slot 放两个能力按钮——🌳 打开当前会话节点树工作台 + ! 待处理交互（有待处理时充能高亮：accent 金底白字 + 徽标脉动光晕；点击切 attention 视图）。`<AgentDialog native/>` 隐藏自绘标题栏，按钮操作经 `defineExpose` 暴露调用。待处理视图（`WorkspaceSessionBrowser` native 模式）**整窗铺满布局**（无二次内边距，列表区 `flex:1` 内部滚动 + `.inner-scrollbar` 弱化滚动条），按 `rootChatId` 会话分组（分组头显会话名 + 计数），顶部导航 chip 点击滚动定位到对应分组；「需确认 / 需回答」kind 标签全局双色高对比（金/紫实色底白字，native 与浮动窗一致） |
| `?surface=workbench&presetId=xx&chatId=xx&presetName=xx` | 工作台原生窗（每 preset 一窗）：**同用 `WindowFrame` 公共外壳**——`<WorkbenchDialog native/>` 隐藏自身 `.workbench-titlebar`，标题显示预设名、`attentionBlink` → 标题栏闪烁、关闭经 `defineExpose(closeWorkbench)` 由 WindowFrame `close` handler 接管（先释放根时间线订阅），另渲染 `HistoryDrawer`。`presetName` 由入口经 `OpenWindowRequest` 携带 → main `extraParams` 拼入 URL → App.vue 读 `?presetName=` 写 `win.presetName`（空白工作台角色编制解析必需） |
| 无 surface | 浏览器单页（**逐字节不变**：应用内多工作台窗 + 胶囊 + overlay 设置 + 抽屉） |

每个原生窗是独立 renderer，各连一条 WS（后端 `ConnectionManager` 支持多连接）；跨窗状态只经 query（chatId/presetId）+ 少量 IPC（`workbench:open-chat` / `workbench:focus` / `window:focused` / `theme:set`）。

### 窗口生命周期

| 操作 | 设置窗 | 工作台窗 |
|------|--------|----------|
| 点 X 关闭 | **destroy**（无运行状态，重开重载 config） | **hide 不销毁**：WS 与 run 保持、任务继续；重开同 preset → show+focus 还原（任务可见/可继续） |
| 最小化 | 任务栏 | 任务栏，run 继续 |
| 最大化/还原 | 原生（双击标题栏 / Win+↑ / 拖边缘均可） | 同左 |

托盘点击 / `app.activate` / `second-instance`：原打开 console 壳窗 → **改为打开设置窗**（应用主界面锚点）。

### 通用窗口外壳能力（三件套）

- `useWindowFrame.ts`（`web/src/features/desktop/`）：composable，封装 `windowControl` / `onWindowMaximized` / `onWindowFocused` / `flashFrame` / `setBackgroundColor`；含 `lockWindowRootColorScheme()`（置 `documentElement.style.colorScheme='light'` + `<html>` 加 `window-surface` class —— 灰边修复核心）。
- `WindowFrame.vue`：**settings / workbench 公共外壳**。自绘 40px 标题栏（`-webkit-app-region: drag` + 双击最大化）+ 三键 + 主题边框，body slot 铺满；三键行为默认 `windowControl`，可经 `minimize`/`maximize`/`close` prop 覆盖（workbench 关闭先释放订阅），`attention` prop 驱动标题栏闪烁。**标题位置扩展点**：`title-actions` slot 紧贴标题右侧（`.window-frame-title-group` 内、与标题同行垂直居中，容器 `no-drag` 保证可点击）——settings 面在此放「打开配置文件夹」公共组件 `OpenConfigDirButton`（`App.vue` 接入），未来标题右侧功能统一在此 slot 扩展；`titlePointerDown` prop 透传标题栏点击（workbench 熄灭闪烁）。
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

| 文件 | 变更 |
|------|------|
| `web/electron/main.ts` | 删 console 全套；`ManagedWindow` 注册表 + settings/workbench 工厂 + `window:open/control/set-background/flash`/`theme:changed` IPC + bounds 持久化；托盘/activate/second-instance → 打开设置窗 |
| `web/electron/preload.ts` | 删 `ConsoleTarget`；新 bridge（openWindow/windowControl/onWindowMaximized/onWindowFocused/onWorkbenchFocus/onOpenChat/flashFrame/setBackgroundColor/emitThemeChanged/onThemeSet） |
| `web/src/features/desktop/desktopBridge.ts` | 同上镜像类型 |
| `web/src/features/desktop/useWindowFrame.ts` | 新：通用窗口外壳 composable + `lockWindowRootColorScheme` |
| `web/src/features/desktop/WindowFrame.vue` | 新：自绘标题栏外壳 |
| `web/src/styles/windowControls.less` | 新：共享三键样式 |
| `web/src/App.vue` | surface 四分发；workbench 面同步注册 + focus/open-chat/flashFrame/主题订阅；删 console 分支与 `bindConsoleNavigation` |
| `web/src/features/agent/settings/SettingsDialog.vue` | `native` prop（铺满窗、去自拖拽/自三键、close→windowControl、mounted 加载） |
| `web/src/features/agent/workbench/WorkbenchDialog.vue` | `native` prop（fullscreen 恒置、三键走 windowControl、titlebar drag、resize 隐藏、attentionBlink→flashFrame） |
| `web/src/features/pets/nyxus/components/NyxusCore.vue` | 入口改 `openWindow` |
| `web/src/features/agent/chat/AgentDialog.vue` | 入口改 `openWindow`（含 `openWorkspaceTree` 盲点修复） |
| `web/src/features/agent/toolbar/PetToolbar.vue` | 入口改 `openWindow`（盲点修复） |
| `web/src/features/desktop/ConsoleShell.vue` | 删除 |
| `web/src/stores/theme.ts` | `applyFrom(theme)` + Electron 面 `setBackgroundColor` + `emitThemeChanged` |
| `web/src/styles/theme.css` | `html.window-surface` 兜底背景 |

浏览器面（无 surface）不受影响：`uiState.ts` workbenchWindows 注册表 / capsule / 几何 / `settingsOpen` 全部保留（浏览器多窗口模式照常），Electron 原生面下这些字段自然休眠。

## 卡牌阅读与图谱方向联动（2026-09-02 返工）

工作台图谱展示模式由**卡牌阅读开关单一入口**决定，不再提供独立的方向切换按钮：

- `useWorkbenchViewPreferences.ts`：`presentationMode` 改为由 `paperMode` **派生**（卡牌开 → `vertical-classic`，卡牌关 → `horizontal-signal`），不再独立持久化；load 时忽略旧持久化字段完成迁移（存量 `presentationMode='vertical-classic' && paperMode=false` 迁移为横向）。
- `WorkbenchDialog.vue`：删除独立 ⇥ 方向切换按钮；卡牌按钮是唯一方向入口，tooltip/aria 为「切换卡牌纵向视图 / 切换信号横向视图」。两种展示模式（纵向 Classic 渲染 / 横向 Signal Grid）共存，随卡牌开关切换。
- **fallback 豁免**：Signal 投影初始化失败自动回退 `vertical-classic`（`presentation-fallback`）时置 `signalFallback` 标志，`paperMode` watch 在该标志下**不反向翻转**卡牌状态；用户下次手动切换卡牌或重载后清除标志，并以轻提示告知「信号投影初始化失败，已回退纵向渲染」。
- 投影/渲染契约见 [pet/nyxus-node-tree-maintenance.md#signal-grid-展示投影2026-09-02-返工契约](./pet/nyxus-node-tree-maintenance.md#signal-grid-展示投影2026-09-02-返工契约)。
