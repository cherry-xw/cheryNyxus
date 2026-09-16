# 工作台标题栏会话状态条（WorkbenchSessionStrip）

**文档创建时间：** 2026-09-16T12:29:17+08:00

**状态：** 执行中

## 目标与边界

工作台（每预设一窗）标题栏增加常驻**会话状态条**：运行中/待用户会话以 icon 阵列展示（icon 随当前运行节点变化，hover 提示标题 + 最后一次提问 + 当前节点类型）；未运行会话经**当前预设下拉**切换（分页，默认第一个）。切换入口从右侧 rail 按钮 popout 提升到标题栏，满足「同时多会话、高频来回切换」场景。

- **数据通道**：复用现有 `chat.overview.open` 订阅（快照 + 细推送，不引入全量 root timeline 订阅，不做 IndexedDB 缓存层——状态数据 KB 级、服务端权威、断线重连快照重放已覆盖同步语义）。
- **边界**：
  - rail ≡ 会话列表 popout 已于 2026-09-16 移除（用户精修：切换入口去重，归档入口下沉到标题栏下拉行内）；标题栏条为新主入口。
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
| 4 | [综合验证与用户验收](./08-final-verification.md) | — | 固定收口小任务 | 进行中（反馈修复完成，M1-M5 待执行） |

## 依赖与执行顺序

- `01 → 04`（strip 依赖 lastUserPrompt/currentStepKind）；`02 → 05`（下拉依赖分页参数）；`03` 可在 01/02 完成后随时进行；`04/05 → 06`；全部实现完成 → `07 → 08`。
- 批次 1 内 01 与 02 无共享文件冲突（overview.ts vs handler.ts/types.ts 不同段），可并行；批次 2 内 04/05 组件独立可并行，06 依赖二者。

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

## 关键实现事实（探查结论，恢复时直接采用）

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

- 当前批次：批次 4（08 综合验证）。阶段一（A1-A6 自动验证）已回填完成，全部失败经 stash 隔离归因为既有（并行任务改动/机器负载 flaky），本次 0 引入；A4/A5/A6 退出码 0。用户 5 项精修已实现并随 A 清单重验（type-check 0、定向 + 全量测试通过）。
- 下一条动作：等待用户执行阶段二 M1-M5 手动验证（verify/manual-final.md，5 张卡各 ≤1 分钟，卡 1/3 已按精修更新交互描述），结论回填 08 表格 → 阶段三用户拍板后迁移证据并删除任务目录。

## 最终综合验证

见 [08-final-verification.md](./08-final-verification.md)：自动验证（后端/前端/协议测试 + type-check + lint）+ 手动验证（标题栏双 surface 视觉、icon 随节点变化、hover 提示、分页下拉、多会话切换）按三阶段执行，用户审批后收口。
