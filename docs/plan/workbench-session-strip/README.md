# 工作台标题栏与全部任务卡片页

**文档创建时间：** 2026-09-16T12:29:17+08:00

**状态：** 执行中

## 目标与边界

用户已确认本次设计；数据与行为契约、任务目录查询、未查看记录、标题栏和全部任务页双窗口接入均已实现，当前只待综合验证与用户验收。旧版验收结果不能证明新设计通过。

- 标题栏仅图标，主图标固定；运行状态用小图标轻微明暗闪烁，不使用 loading 转圈。详细信息放可进入的 tip 窗口。
- 有限固定快捷位，不水平滚动。后台更新、任务结束、查看结果不重排、不自动移除。满位后新任务进入全部任务页；预留当前任务位，当前任务已在快捷位中时不重复显示。
- 全部任务入口替换标题栏下拉，页面覆盖当前工作台节点树区域，标题栏保留。卡片按任务合并分支，等高排列，宽窗口三列、普通两列、窄窗口一列。
- 卡片展示标题、最近要求、当前进展或最新结果或失败原因、状态、未查看标记、更新时间及分支数；更多操作提供标题栏显示/收起与归档，不添加节点树缩略图。
- 搜索当前工作台全部历史的任务名称、用户提问和结果，展示命中片段；支持状态、时间与排序。浏览期间保持卡片顺序，新任务提示后由用户主动显示。
- 返回列表恢复筛选和滚动位置；仅进入任务并实际显示本次结束结果后清除未查看，列表浏览和 tip 不算查看。

- **数据通道**：复用现有 `chat.overview.open` 订阅（快照 + 细推送，不引入全量 root timeline 订阅，不做 IndexedDB 缓存层——状态数据 KB 级、服务端权威、断线重连快照重放已覆盖同步语义）。
- **边界**：
  - rail ≡ 会话列表 popout 已于 2026-09-16 移除；迁移期标题栏下拉也已由全部任务覆盖页替换，归档入口位于任务卡片菜单。
  - 不改变工作台多窗架构、不改 draft 保持契约、不动 Electron 窗口生命周期。
  - 浏览器面与 Electron 原生面（surface=workbench）双挂载。

## 小任务台账

| 批次 | 小任务 | 复杂度 | 依据 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | ~~后端：overview 状态字段扩展~~ | 2 | 单模块数据映射 | 已完成 |
| 1 | ~~后端：chat.list 分页（scope=preset + limit/offset + total）~~ | 3 | SQL 分页 + 协议契约 + 历史 bug 风险 + 分支排除 | 已完成 |
| 2 | ~~前端：协议类型同步与 store 复用~~ | 1 | 纯类型镜像 + useTaskOverviewStore 既有能力盘点，无行为变更 | 已完成 |
| 2 | ~~前端：WorkbenchSessionStrip 组件（icon 阵列 + 状态 + tooltip）~~ | 3 | 多状态 UI + sense icon 映射 + tooltip 组装 + 点击切换联动，跨组件依赖 | 已完成 |
| 2 | ~~前端：当前预设分页下拉~~ | 2 | 分页列表 + 默认第一个 + 与 strip 联动，单组件有限行为 | 已完成 |
| 2 | ~~前端：双 surface 挂载（native 标题栏 + 浏览器标题栏）~~ | 2 | 两处布局适配 + 空间约束，无协议变更 | 已完成 |
| 3 | ~~文档：协议与工作台文档同步~~ | 1 | 契约/入口变更的权威文档更新 | 已完成 |
| 4 | ~~09 数据与行为约定~~ | 4 | 任务/分支身份、未查看持久化、历史搜索及多窗口边界 | 已完成 |
| 5 | ~~10 历史检索与未查看记录~~ | 4 | 查询分页、异步结果、结束记录与重新连接 | 已完成 |
| 6 | ~~11 稳定标题栏与状态 tip~~ | 3 | 固定位置、溢出与当前任务位、多种状态提醒 | 已完成 |
| 7 | ~~12 全部任务卡片页~~ | 3 | 搜索筛选、稳定列表、任务切换和覆盖页恢复 | 已完成 |
| 8 | ~~13 双窗口接入与旧入口替换~~ | 4 | 浏览器/Electron、草稿保持、焦点和归档竞态 | 已完成 |
| 9 | [08 综合验证与用户验收](./08-final-verification.md) | 3 | 跨模块回归与真实窗口体验 | 未开始 |

## 依赖与执行顺序

- 本次顺序：09 → 10 → 11 → 12 → 13 → 08。01—07 为旧版已完成工作，保留执行记录，不重新执行。
- 09 在修改代码前更新权威说明；10 的数据供 11/12 使用；13 统一接入两类窗口并替换旧入口。标题栏、工作台、App 与共享状态存在交叉修改，默认串行执行。
- 总体复杂度 4/5。09/10/13 建议使用擅长跨模块数据、异步状态和恢复验证的 Agent；11/12 需要界面交互与无障碍经验；08 需要测试分析能力。具体执行主体在开始实施时按项目约定确认，本次未分配其他 Agent。

## 已收口执行记录

- **01（overview 字段）**：变更 `src/db/chat.ts`（新增 `getLastUserPrompts`）、`src/service/chat/overview.ts`（`currentStepKind`/`lastUserPrompt` 透出）、`src/service/message/types.ts`（两个字段）、`test/service/chat/overview.test.ts`（新增 3 用例）。命令 `pnpm vitest run test/service/chat/overview.test.ts test/service/chat/chatListPagination.test.ts`，退出码 0，11/11 通过（含 lastUserPrompt 取末条、无消息省略、currentStepKind model→tool 随事件更新）。
- **02（chat.list 分页）**：变更 `src/db/chat.ts`（`listRootChatsForPresets` 重构支持 `excludeBranches`/`limit`/`offset` + 新增 `countRootChatsForPresets` + 次级排序 `created_at DESC` 防同毫秒分页重叠）、`src/service/chat/handler.ts`（preset scope 分页/total/limit 1-100 与 offset ≥0 校验）、`src/service/message/types.ts`（请求 limit/offset、响应 total）、`test/service/chat/chatListPagination.test.ts`（新增 5 用例）。命令同上，退出码 0；含无 limit 全量不回归、分页无重叠 total=25、分支排除 total=1、legacy preset-name 命中、非法值拒绝。
- **基线确认**：`pnpm test:backend` 全量 8 个失败（deleteChat/deleteLifecycle/approvalSurfaces/workerContinuity/watcherRecovery）经 git stash 验证为既有失败，与本次改动无关。
- **03（前端类型同步）**：变更 `web/src/services/agentApi.ts`（`TaskAgentOverview.currentStepKind?`/`TaskOverview.lastUserPrompt?` + 新增 `listChatsPaged` 走 scope='preset' 分页返回 `{chats,total}`；既有 `listChats` 数组返回保持不变，4 个调用方零改动）。`pnpm --filter web type-check` 退出码 0。
- **04（strip 组件）**：新增 `web/src/features/agent/workbench/WorkbenchSessionStrip.vue`（icon 阵列：model=思考 spinner / tool=sense 图标，hover tooltip 标题+末次提问+当前节点，needs_user 徽标点 + pendingCount，上限 6 个 + 「+N」溢出 emit expand）+ 纯逻辑 `useSessionStripTasks.ts`（`pickStripTasks` 过滤 `presetId===props.presetId || preset===props.presetName` 且 status∈{running,needs_user}，按 updatedAt DESC，`buildStripTooltip`/`currentNodeLabel`）。测试 `web/test/workbench/sessionStripTasks.test.ts` 6 用例全过。
- **05（分页下拉）**：新增 `SessionDropdown.vue` + `useSessionDropdown.ts`（`chat.list` scope='preset' 分页，limit=20/页，滚动到底/按钮 loadMore，total 驱动 hasMore，chatId 去重防边界重叠，失败可重试，空态「该预设暂无会话」+ 新建会话 emit；默认第一项高亮；行内 preview/时间/轮次/running/待审批/待回答）。测试 `web/test/workbench/sessionDropdown.test.ts` 4 用例全过。
- **06（双 surface 挂载）**：新增组合容器 `WorkbenchSessionBar.vue`（strip + ☰ 按钮 + 弹层 absolute 定位）；浏览器面挂 `App.vue` 的 `CyberWindow #title-actions` slot（ConnectionStatusChip 与 WorkbenchViewToggle 之间，**修正：浏览器工作台窗 embedded 模式自绘 `.workbench-titlebar` 不渲染，标题栏由 CyberWindow 承载**）；native 面挂 `App.vue` workbench surface WindowFrame `#title-actions`（ConnectionStatusChip 与 WorkbenchViewToggle 之间），新增 `workbenchSurfaceChatId` computed + `onWorkbenchSessionSelect`（`setWorkbenchWindowChat`，与 bridge onOpenChat 同语义）+ 通用 `createWorkbenchSession(windowId, presetId, presetName)`（Nyxus/普通预设分流，native/浏览器共用）。**架构边界修正**：新组件一律经 `@/application/public`（store）与 `@/application/backend/public`（agentApi+类型）导入，`dependencyBoundaries.test.ts` 通过。
- **07（文档同步）**：`docs/shared/protocol/websocket.md`——`chat.list` 方法行补分页（limit 1-100/offset ≥0 仅 scope='preset' 生效、分支排除、total、次级排序防重叠）、响应区补 total 说明、新增「chat.overview 订阅（任务中心投影）」小节（open/close 语义 + TaskOverview/TaskAgentOverview 字段表，含 lastUserPrompt/currentStepKind）；`docs/frontend/workbench-multi-window.md` 新增「标题栏会话状态条（2026-09-16）」小节（组成/交互、双 surface 挂载、数据源与生命周期、契约不变）。`pnpm test:protocol` 基线 9 suite 失败（chat.archive/workflow 等另一任务改动所致），本次未引入新失败。
- **用户 5 项精修（2026-09-16）**：① 下拉不显示 → 根因标题栏内 absolute 弹层被工作台 body 更高 z-index 覆盖，修复 = Teleport 到 body + 锚点 fixed + `ownerOverlayZIndex(anchor)`（`WorkbenchSessionBar.vue`）；② 运行中状态 = 节点 icon + 半透明 loading 遮罩（呼吸底 + spinner，底层可见）；③ hover 提示三块分栏（标题/用户消息/当前节点，`session-strip-tip`）；④ 当前会话标记：`pickStripTasks` 第 5 参 `currentChatId` 强制置顶 + 底部指示条 + 高亮；⑤ rail ≡ 会话列表按钮/popout/controller 状态与数据路径（`sessionListOpen`/`rootSessions`/`refreshSessionList`/`onSessionDelete`）全删，归档入口下沉下拉行内（删除竞态保护契约迁移，`web/test/nyxus/workbenchPreferences.test.ts` 同步更新）。验证：type-check 0、全量 web 测试 721 通过（仅余并行任务 AgentDialog/LiteView 行数超限 + performanceRecovery flaky 两个既有失败）、我的改动文件 lint 干净。
- **09（数据与行为约定，2026-09-17）**：更新 `docs/shared/protocol/websocket.md`、`docs/backend/service/chat.md`、`docs/frontend/workbench-multi-window.md`；冻结 `taskKey=originalChatId` 的一任务一卡与活动主流程打开规则、七种任务状态、终态 `resultId` 比较后查看、服务端未查看持久化、`chat.task.list` 固定快照检索、5 个稳定快捷位 + 1 个当前补位、固定主图标及 `attentionKey` 再提醒条件。权威说明明确标注为已确认目标，待 10—13 实现；未修改产品源码。`pnpm plan:lint` 退出码 0，关键断言 `Plan Lint 通过：总入口 3 项、计划目录 3 个`；`git diff --check` 退出码 0；两条新增相对文档链接均解析到现存文件。
- **10（历史检索与未查看记录，2026-09-17）**：新增公共 RPC `chat.task.list` 与 `chat.task.result.view`、任务目录服务、查询快照游标、服务端查看记录表和前端 `useTaskCatalogStore`；按 `taskKey` 先合并全部分支再搜索/筛选/排序/分页，打开活动主流程，搜索任务标题、用户消息与可见结果并返回 UTF-16 命中位置。概要订阅同步任务身份、活动分支、最新结果、未查看状态和稳定提醒键；查看确认比较 `resultId`，旧确认不会清除新结果，记录可跨重启恢复。补充迟到响应隔离、分页去重、深页搜索、跨预设隔离、分支合并、停止说明、真实 `nodeId` 结果关联等测试。验证：后端与前端类型检查、修改文件 ESLint、后端 19 个定向用例、前端 13 个定向用例、本次两个 RPC 的协议响应检查均通过；协议整组仍受既有 archive/workflow 响应样例缺失与临时目录缺配置阻断。
- **11（稳定标题栏与状态 tip，2026-09-17）**：变更 `WorkbenchSessionStrip.vue`、`WorkbenchSessionBar.vue`、`useSessionStripTasks.ts` 与 `App.vue`，新增 `useSessionStripPreferences.ts`；实现按预设持久化的 5 个稳定快捷位、1 个当前补位、窄窗临时隐藏、固定线性主图标、非旋转状态角标、前台运行闪烁、可键盘进入的 tip、手动收起与 `attentionKey` 再提醒、全部任务入口事件。`pnpm --filter web type-check`、修改文件 ESLint、`git diff --check`、`pnpm plan:lint` 退出码 0；4 个定向文件 20 个用例通过，依赖边界 8 个用例通过；Vue 行数门禁仅有并行改动中的 `AgentDialog.vue: 816 > 800`、`LiteView.vue: 880 > 800` 两项既有失败。
- **12（全部任务卡片页，2026-09-18）**：新增 `TaskBrowser.vue`、`TaskBrowser.styles.less`、`useTaskBrowserController.ts`、`taskBrowserModel.ts` 与 `web/test/workbench/taskBrowser.test.ts`，扩展 `useTaskCatalogStore` 为按工作台隔离的查询状态，并从工作台公共入口导出页面；实现完整历史搜索、状态/时间/排序、稳定卡片顺序、实时原位更新、新任务提示、分页去重、筛选与滚动恢复、纯文本命中片段、标题栏快捷位、归档确认及失败重试。`pnpm --filter web type-check`、`pnpm --filter web build`、修改文件 ESLint、`git diff --check` 与 `pnpm plan:lint` 退出码 0；两个定向文件 12 个用例、依赖边界 8 个用例通过。`pnpm test:web` 共 778 项，760 项通过；18 项失败均位于工作区既有并行改动的 `workbenchAttentionScope.test.ts`、`vueSfcSizeBudget.test.ts`、`toolRendering.test.ts`、`treeMotion.test.ts`，本任务新增测试在全量运行中通过。
- **13（双窗口接入与旧入口替换，2026-09-18）**：新增 `useTaskBrowserOverlay.ts` 与 `web/test/workbench/taskBrowserIntegration.test.ts`，由 `WorkbenchSessionBar.vue` 按 `windowId` 控制所属 `WorkbenchDialog.vue` 内的 `TaskBrowser.vue` 覆盖层；覆盖时底层树、输入、工具栏与离线操作设为不可交互，控制器、草稿和树订阅不卸载。卡片与标题栏切换均走既有 `switchSession`/`setWorkbenchWindowChat`，归档前捕获当前会话并在请求返回后防止覆盖用户中途切换；结果查看在目标树已加载、窗口前台、覆盖页关闭后按旧 `resultId` 比较确认，并同步目录与概要本地状态。删除 `SessionDropdown.vue`、`useSessionDropdown.ts` 及专用测试，移除 `App.vue` 的旧新建/清空接线和树会话旧归档死代码。`pnpm --filter web type-check`、`pnpm --filter web build`、修改文件 ESLint、`git diff --check` 与 `pnpm plan:lint` 均通过；任务 13 相关定向回归 42/42、依赖边界 8/8 通过。`pnpm test:web` 共 778 项，775 项通过；剩余 3 项均为任务开始前已有失败：`workbenchAttentionScope.test.ts` 1 项、`vueSfcSizeBudget.test.ts` 1 项（`AgentDialog.vue: 816`、`LiteView.vue: 909`）和 `treeMotion.test.ts` 1 项。本任务新增测试全部通过。

## 旧版探查记录（仅供定位，实施前核对）

下列记录含旧版实施前的字段缺失与已被修正的挂载描述，不能作为当前事实直接采用；以上已收口记录与当前源码优先。

- 标题栏扩展点：native 面 `WindowFrame.vue` `#title-actions` slot（现放 ConnectionStatusChip + WorkbenchViewToggle，App.vue workbench surface）；浏览器面自绘 `.workbench-titlebar`（title + small + ConnectionStatusChip + WorkbenchViewToggle + controls，WorkbenchDialog.vue L184-206）。空间约束：标题栏高 40px，strip icon 建议 ≤24px，上限 6 个 + 「+N」溢出折叠进下拉。
- `useTaskOverviewStore`（web/src/stores/taskOverview.ts）已具备 open/reopen/close/applyChanged/tasks（按 STATUS_PRIORITY 排序）/pendingCount/runningCount，TaskCenterPanel 在用；`TaskOverview` 含 `presetId`/`preset`/`title`（首条 user preview）/`status`/`agents[].currentStep`/`pendingCount`/`updatedAt`。缺 `lastUserPrompt`（末条 user 消息）与 `currentStepKind`（'model'|'tool'）。
- `overview.ts` 的 `agentOverview` 已计算 `activeStep`（executionSteps 反向找 status==='running'），`currentStep` = kind==='model' ? '思考中' : senseName——加 `currentStepKind` 是纯透出。
- 末条 user 消息查询：`getChatPreviews`（src/db/chat.ts L800）只取首条 user 消息 + turnCount，按 messages_month 分组；需新增末条 user 消息查询（同分组模式，ORDER BY created_at DESC LIMIT 1）。
- `chat.list`：`ChatListRequestData`（src/service/message/types.ts L215）无 limit/offset；`handleChatList`（src/service/chat/handler.ts L318）scope='preset' 走 `listRootChatsForPresets`（src/db/chat.ts L288，SQL 已含 presetId OR preset 名回退）。**分页兼容约束**：现有调用方（useWorkbenchDialogController.refreshSessionList L549）用 `scope:'history'` 无 limit 全量 + 前端按预设过滤——limit 缺省必须保持全量语义，不破坏现有调用。
- 分支排除：`isPianoRootSession`（web/src/features/pets/nyxus/composables/pianoNotes.ts L33）剔 parentChatId 非空 + branchKind continuation/detail；分页在后端做时需在 `listRootChatsForPresets` SQL 排除非 original 分支（conversation_branches 表按 chat_id 关联），否则分页数与前端显示不一致。
- 测试设施：后端 `pnpm test:backend`（vitest 根配置，test/ 目录）；前端 `pnpm test:web`（web/vitest.config.ts，web/test/）；协议 `pnpm test:protocol`。现有相关测试：web/test/taskCenter/taskOverviewStore.test.ts、web/test/chats/sessionCatalog.test.ts、web/test/agents/workbenchWindow.test.ts。
- 工具 icon 映射：`senseTool(entry)?.icon`（SenseToolInfo 含 icon），workbench controller 已暴露 `senseTools`；strip 内 tool 节点 icon 按 senseName 查 senseTools，model 节点用思考动画。strip 组件接受 `senseTool` prop 注入（浏览器面传 controller.senseTool），native 面无注入时组件内部自拉 `agentApi.listSenseTools()` 兜底。
- **overview 订阅生命周期（04 探查修正 06 原设想）**：`chat.overview` 订阅由 `startApplicationRuntime`（web/src/application/runtime/startApplicationRuntime.ts）应用级统一管理——connected 时 reopen、应用销毁时 close；组件（TaskCenterPanel / strip / SessionBar）只读 `useTaskOverviewStore.tasks`，**不自行 open/close**，多消费者无互相关闭订阅问题。
- 切换会话路径：浏览器面经 controller `switchSession`（useWorkbenchTreeSession，draft 保持契约既有）；native 面仅 `workspace.setWorkbenchWindowChat(wbId, chatId)`（与 bridge onOpenChat 同语义，WorkbenchDialog 内 watch chatId 驱动树订阅 + draft reset）。

## 恢复检查点

- 当前工作：13 已完成，检查点恢复到 08“综合验证与用户验收”。
- 工作区：09—13 的权威说明、产品代码、测试和计划记录均未提交；另有此前任务留下的未提交改动，继续实施时不得回退。
- 下一步：进入 08，汇总自动回归并由用户执行浏览器与 Electron 的真实窗口人工验收。
- 下一条计划校验命令：08 开始前按自动清单建立输出目录，并核对 09—13 的定向命令与失败基线。
- 后续不得改变的 10 契约：目录按 `taskKey` 先合并再分页；查看确认比较 `resultId`；完整搜索在服务端覆盖全部历史；同一 cursor 的任务身份和顺序保持不变。

## 最终综合验证

见 [08-final-verification.md](./08-final-verification.md) 与 [人工操作卡](./verify/manual-final.md)。旧版下拉和动态图标验收已被本次新清单替换，旧通过结论不沿用。自动验证不启动浏览器或 Electron，真实视觉、交互和使用体验由用户集中验收。

## 用户确认与审批

- 已确认：标题栏固定主图标、小状态图标闪烁、不水平滚动、5 个稳定快捷位 + 1 个当前补位、手动收起后的再提醒条件，以及全部任务卡片页与数据行为契约。
- 未完成：综合验证、抽样核对和最终交付审批。设计确认不等于产品已通过验收。
