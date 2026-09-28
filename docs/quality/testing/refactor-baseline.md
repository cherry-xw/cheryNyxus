# 重构结论基线（回归对照）

> 状态：2026-09-27 建立。记录对**当前代码现状**的架构分析结论，作为后续重构与大型任务的**回归对比基线**。
>
> 用途：后续定义工具或流程，按本文各表的「验证方法」逐项检查结论是否仍成立（结论所指问题是否仍存在 / 是否已按预期重构）。每次大型任务结束后统一执行一次回归对照，确保：① 已确认的死代码与冗余被清理；② 相似逻辑按基线合并；③ 超长文件按基线拆分；④ 未被点名的代码未被无关改动破坏。
>
> 维护规则：
> - 结论达成（问题已解决）后，把该行移入「已达成」或标记状态，不保留历史墓碑；确有审计价值时由维护者决定归档。
> - 新增大型分析产生的新结论，按同一编号规则追加到对应小节。
> - 本文档不替代 [baseline.md](./baseline.md)（测试门控）与 [已知问题](../known-issues/README.md)（开放问题）；它只记录「代码现状结论」。

---

## A. 可删除的死代码（后端 `src/`）

这些符号在全项目无任何引用（非协议注册、非字符串调用、非内部自用）。验证方法：在仓库搜索该符号名，仅定义处命中即为「仍存在」，全无命中即为「已清理」。

| 编号 | 符号 | 位置 | 现状证据 | 验证方法（清理后应通过） |
| --- | --- | --- | --- | --- |
| A-01 | `writeGlobalHooks` | `src/agent/hooks/registry.ts:242` | 只有定义，无任何调用/import | 全库 grep 该名 0 命中 |
| A-02 | `findChildChatsWithType` | `src/db/chat.ts:818` | 只有定义，无引用 | 全库 grep 该名 0 命中 |
| A-03 | `getLastUserPrompts` | `src/db/chat.ts:927` | 只有定义，无引用 | 全库 grep 该名 0 命中 |
| A-04 | `deleteWorkflowJournalScope` | `src/db/workflowJournal.ts:646` | 只有定义，无引用 | 全库 grep 该名 0 命中 |
| A-05 | `resolveMediaAsset` | `src/service/media/index.ts:199` | 定义存在，计划文档标注尚未接线，无代码引用 | 全库 grep 该名 0 命中（含注释后确认无代码调用） |
| A-06 | `handleChatSendToChild` | `src/service/chat/handler.ts:1543` | 退休方法，未注册；前端已改用 `chat.open` | 全库 grep 该名 0 命中 |
| A-07 | `handleChatAttach` | `src/service/chat/handler.ts:2310` | 退休方法（`chat.attach`），未注册 | 全库 grep 该名 0 命中 |
| A-08 | `handleSenseApproval` | `src/service/chat/send.ts:495` | 退休路径（`sense.approval`），未注册；前端已改用 `interaction.approval.decide` | 全库 grep 该名 0 命中 |
| A-09 | `handleSenseQuestionAnswer` | `src/service/chat/send.ts:519` | 退休路径（`sense.question.answer`），未注册；前端已改用 `interaction.question.answer` | 全库 grep 该名 0 命中 |
| A-10 | `handleSenseQuestionBatchAnswer` | `src/service/chat/send.ts:556` | 退休路径（`sense.question.batchAnswer`），未注册 | 全库 grep 该名 0 命中 |
| A-11 | `export default` ×3 | `src/agent/middleware/chat.ts:379`、`checkpoint.ts:337`、`tool.ts:634` | 三文件已有具名导出被 `middleware/index.ts` 使用，`export default` 无人 import | 三文件不再有 `export default`（保留具名导出） |
| A-12 | `reloadOneServer`、`reloadMcpServers` | `src/core/mcp/loader.ts:352,381` | 生产无引用，仅 `test/core/mcp/*` 引用；`mcp.reload` 走 `reloadMcpConfiguration` 链路 | 生产 grep 0 命中；若删除需同步处理关联测试 |

> 注意：A-06 至 A-10 删除 handler 函数时，**不要**连带删除 `src/service/message/internalCommand.ts` 与 `types.ts`/`schemas.ts` 中的方法名常量与 schema 条目——`rpcCatalog.test.ts` 要求这些退休方法名「不出现在公开目录中」，且它们仍被 `claimRequest` 幂等日志使用。

---

## B. 可删除的死代码（前端 `web/src/`）

### B-1 生产已迁移、仅测试引用的遗留文件

以下文件生产代码已全部改用 `stores/chats`，仅 `web/test/` 引用（knip 项目范围不含 test 故报未使用）。验证方法：确认生产 `src/` 无 import 命中；删除时同步评估对应测试。

| 编号 | 文件 | 现状证据 | 验证方法（清理后应通过） |
| --- | --- | --- | --- |
| B-01 | `web/src/stores/agents/actions/approvalActions.ts` | 生产仅被死文件 `streamRouter.ts` 引用，其余为测试 | 生产 `src/` grep 该路径 0 命中 |
| B-02 | `web/src/stores/agents/actions/questionBatch.ts` | 同上 | 生产 `src/` grep 该路径 0 命中 |
| B-03 | `web/src/stores/agents/data/historyLoading.ts` | 仅测试引用 | 生产 `src/` grep 0 命中 |
| B-04 | `web/src/stores/agents/data/historyLoadState.ts` | 仅测试引用 | 生产 `src/` grep 0 命中 |
| B-05 | `web/src/stores/agents/data/historyMerge.ts` | 仅测试引用 | 生产 `src/` grep 0 命中 |
| B-06 | `web/src/stores/agents/data/sessionCatalog.ts` | 仅测试引用 | 生产 `src/` grep 0 命中 |
| B-07 | `web/src/stores/agents/ui/streamRouter.ts` | 仅测试引用 | 生产 `src/` grep 0 命中 |
| B-08 | `web/src/stores/agents/ui/uiState.ts` | 仅测试引用 | 生产 `src/` grep 0 命中 |

### B-2 完全无引用的死文件/组件

验证方法：全 `web/`（含 test）无 import 命中。

| 编号 | 文件 | 现状证据 | 验证方法（清理后应通过） |
| --- | --- | --- | --- |
| B-09 | `web/src/composables/useCountdown.ts` | 无任何引用 | 全 `web/` grep 0 命中 |
| B-10 | `web/src/features/pets/nyxus/composables/floatingPanel.ts` | 仅测试引用 | 生产 `src/` grep 0 命中（`constrainFloatingOffset` 仅在测试用） |
| B-11 | `web/src/features/pets/nyxus/composables/useDragPan.ts` | 无引用（`useTreeCanvas.ts` 仅注释提及） | 全 `web/` grep 0 命中 |
| B-12 | `web/src/services/relay.ts` | 无引用 | 全 `web/` grep 0 命中 |
| B-13 | `web/src/application/pets/public.ts` | 无引用 | 全 `web/` grep 0 命中 |
| B-14 | `web/src/features/agent/workbench/public.ts` | re-export 多余层（导出物 `WorkbenchDialog` 等经直接路径被用） | 该文件 0 引用，导出物经其它路径仍有消费 |
| B-15 | `web/src/features/agent/workbench/NyxusSessionList.vue` | 无引用 | 全 `web/` grep 0 命中 |
| B-16 | `web/src/features/agent/workbench/WorkbenchReaderSplit.vue` | 无引用（测试断言「不应包含」） | 全 `web/` grep 0 命中 |
| B-17 | `web/src/features/agent/workbench/context-analytics/ContextAnalyticsEpochs.vue` | 无引用 | 全 `web/` grep 0 命中 |
| B-18 | `web/src/features/agent/workbench/runtime-diagram/WorkflowOccurrenceNode.vue` | 无引用 | 全 `web/` grep 0 命中 |
| B-19 | `web/src/features/agent/workbench/runtime-diagram/WorkflowUnresolvedNode.vue` | 无引用 | 全 `web/` grep 0 命中 |
| B-20 | `web/src/features/agent/settings/controls/PillSelector.vue` | 无引用（仅 `shared.less` 有样式） | 全 `web/` grep 0 命中 |
| B-21 | `web/src/features/agent/settings/controls/TagSelect.vue` | 无引用（仅 `shared.less` 有样式） | 全 `web/` grep 0 命中 |
| B-22 | `web/src/features/pets/nyxus/components/FiberPulseLine.vue` | 无引用（测试断言「不应包含」） | 全 `web/` grep 0 命中 |

### B-3 管理模块死代码

| 编号 | 符号 | 位置 | 现状证据 | 验证方法（清理后应通过） |
| --- | --- | --- | --- | --- |
| B-23 | `writeLegacyManagerPage` | `manager/src/server.ts:258-290` | 一整页旧版 HTML 内嵌代码，被 `page.ts` 复古版替代，无人引用 | 全 `manager/` grep 该名 0 命中 |

---

## C. 冗余导出（函数在用，仅 `export` 多余）

这些符号在本文件内部被调用，只是导出后无外部 import。**处理方式是去掉 `export`，不是删函数**。验证方法：函数仍存在且有内部调用；不再出现在 `export` 语句中。

| 编号 | 符号 | 位置 | 内部使用证据 |
| --- | --- | --- | --- |
| C-01 | `matchSkillFilter` | `src/agent/prompt/loadSkill.ts:425` | `loadSkill.ts:438,466` 内部调用 |
| C-02 | `prepareSenseReload` | `src/agent/sense/index.ts:382` | `sense/index.ts:403,459` 内部调用 |
| C-03 | `pathFor`、`enumerateWindowsDrives` | `src/service/browse/sandbox.ts:53,63` | `sandbox.ts:84,95,165` 内部调用 |
| C-04 | `isCompactEnabled`、`shouldAutoCompact` | `src/service/chat/autoCompact.ts:52,80` | `autoCompact.ts:176-177,218-219` 内部调用 |
| C-05 | `initialWorkflowSnapshot` | `src/service/chat/workflow.ts:75` | `workflow.ts:377` 内部调用 |
| C-06 | `installSpawnBroadcaster`、`installEagerSpawnStarter` | `src/service/subagent/index.ts:23,65` | 经 `registerRole` 使用（`subagent/index.ts:80-81`，`service/index.ts:128`） |
| C-07 | `encryptString`、`decryptString` | `src/utils/secretStore.ts:87,100` | `secretStore.ts:154,173` 内部调用 |
| C-08 | `sumChatTokens` | `src/utils/token.ts:81` | `token.ts:185` 内部调用 |
| C-09 | `getConfigRevision` | `src/db/epoch.ts:158` | `epoch.ts:155,188` 内部调用 |
| C-10 | `backfillLegacyPendingQuestionBatches` | `src/db/question.ts:188` | `question.ts` 多处内部调用（270/283/334/353/370/387/472/556） |
| C-11 | `ApprovalManager`（class） | `src/service/approval/manager.ts:36` | 外部只 import 单例 `approvalManager`，不 import class 本身 |
| C-12 | `SENSITIVE_KEY_RE`、`getEnvVarMap` | `src/utils/envGuard.ts:11,24` | `envGuard.ts:75,115` 内部使用 |
| C-13 | `isRuleDirPath`、`extractSensePaths` | `src/utils/pathGuard.ts:58,114` | `pathGuard.ts:159,165,167` 内部使用 |
| C-14 | `ROLE_AVATAR_POOL`、`roleAvatarHash`、`defaultRoleAvatar` | `src/utils/roleAvatar.ts:2,22,28` | `roleAvatar.ts:29,43` 内部使用 |

---

## D. 协议注册误报（knip 报未使用，但必须保留）

这些导出不是死代码：经 `router.register(方法名, handler)` 按名称注册，前端按方法名字符串调用，或由生产代码直接 import。验证方法：方法名仍出现在对应注册表且前端仍调用时，**不得删除**。

| 类别 | 位置 | 说明 |
| --- | --- | --- |
| chat 域 handler | `src/service/chat/handler.ts:2357-2374`、`send.ts:737-740`、`usage.ts:244-250`、`workflow.ts:496-497`、`conversationRouter.ts:203` | `handleChatStopChild`/`handleChatRunResume`/`handleUsage*`/`openWorkflow`/`suggestConversationRoute*` 等均在此注册 |
| skills / plugins | `src/service/skill/import.ts:244-247`、`list.ts:61-62`、`sources.ts:389-394`、`plugin/import.ts:406-413` | `handleSkills*`/`handlePlugins*` 全部为协议注册 |
| utils / config / workspace | `src/service/utils/handler.ts:724-730`、`config/handler.ts:104-108`、`workspace/handler.ts:182-183`、`credentials/handler.ts:45-47` | `handleUtils*`/`handleConfig*`/`gitStatus`/`handleCredentials*` 均注册 |
| 其余 list 类 | `src/service/{brain,prompt,rule,sense,runtime,command}/...` | `handleBrainList`/`handlePromptsList`/`handleRulesList`/`handleSenseList`/`handleRuntimeSet`/`handleCommandList` 均注册 |
| hooks / mcp 常量 | `src/service/config/runtimeApply.ts:27,30`、`src/core/mcp/convert.ts:63,97,138` | `prepareHookRegistry`/`publishHookRegistry`/`MCP_PREFIX` 被生产代码直接 import |

---

## E. 可合并的相似逻辑（重构目标）

验证方法：合并后，原位置的重复实现被单一共享实现替代（相关文件相应瘦身），原行为由既有测试或新定向测试覆盖。

| 编号 | 重复内容 | 位置（现状） | 合并方案 | 验证方法 |
| --- | --- | --- | --- | --- |
| E-01 ✅ | `TimelineNode`/`RootTimelineSnapshot`/`ExecutionEdgeFact`/`ConversationBranchSummary`/`GenerationEntry` 前后端双份维护 | 后端 `src/service/message/types.ts`（如 `TimelineNode` 1978-2013）vs 前端 `web/src/services/agentApi.ts`（如 `TimelineNode` 838-882） | 迁入 `packages/protocol/`，后端 re-export、前端直接 import（沿用 `TerminationFact` 先例） | 单一事实源：上述类型在 `@chery/protocol` 定义，前后端不再各自声明 |
| E-02 ✅ | `ConversationBranchKind` 重复声明 | `src/service/message/types.ts:361` + `src/db/conversationBranch.ts:4`（逐字相同） | 合并为单一定义 | 全库仅 1 处声明 |
| E-03 ✅ | `SenseQuestionAnswerResponseData` 定义两次 | `src/service/message/types.ts:729` 与 `:2370`（形状一致） | 删除其一 | 全库仅 1 处声明 |
| E-04 ✅ | 媒体上传体系 ~180 行重复 | `useAgentDialogOptions.ts:1256-1345` vs `useLiteViewController.ts:927-1005`（`onMediaSelected` 逐行同构） | 抽 `useComposerMedia` composable 共用 | 两文件不再各自维护完整媒体上传；共享实现单一 |
| E-05 ✅ | 角色配置 helper 逐字重复 | `useAgentDialogOptions.ts:1348-1381` vs `RoleConfigPopover.vue:53-124`（7 个 helper 函数体相同） | 抽 `runtime/roleConfigModel.ts` 模块级纯函数 | 两处改为引用同一模块 |
| E-06 ✅ | config/operations 4 对 put/remove 同构 | `src/service/config/operations.ts:119-156`（schema）+ `:203-265`（apply switch） | 表驱动工厂 `makePutOp`/`makeRemoveOp` + 通用 `applyPutRemove` | apply 逻辑减半，新增资源种类零成本 |
| E-07 ✅ | store 单飞/序号守卫手写 7+ 次 | `taskOverview.ts:35`、`configApply.ts:9`、interactions.ts:91、taskCatalog.ts generation、settings seq | 抽 `useSingleFlight` + `useStaleGuard` composable | 各 store 改用共享原语 |
| E-08 ◐ | 分页/游标 4 套独立实现 | `handler.ts:585`（base64url 游标）、`workflowHistory.ts`（带指纹游标）、`db/usage.ts:50`（`page<T>` 泛型但私有）、`chat/usage.ts:203,230`（重写 offset 解析） | 抽共享 `cursor.ts` 编解码 + 提升 `page<T>` | 共享实现单一，无重写 |
| E-09 ✅ | DB 行映射/JSON 列样板 | `src/db/conversationBranch.ts:29-56`、`executionGraph.ts:324`、`treeControl.ts:27`（`xFromRow`）；多处 `SELECT data_json + JSON.parse` | 抽 `db/helpers.ts`：`queryAll/queryOne/jsonRow` | 行映射与 JSON 解析收敛为共享 helper |
| E-10 ✅ | agentApi 列表解包 12 处 `?? []` + HTTP 上传 2 处 | `web/src/services/agentApi.ts`（如 `listSkillSources` 1554、`listPlugins` 1597、`uploadMedia` 2215） | 加 `callList<T>` 泛型解包器 + `uploadFile` helper | 解包/上传模板收敛 |
| E-11 ⏸ | 30 个 `registerXxxHandlers` 壳 | `src/service/*/.../list.ts`、`handler.ts` 等 | 声明式 handler 表 + 共享注册器 | 注册壳收敛为共享注册器 |
| E-12 ✅ | ws 投递循环 8 处 | `handler.ts:1394-1403,1429-1438`、`send.ts:422`、`rootGraphPatch.ts:159`、`spawnEager.ts:40`、`wake.ts:41`、`subagent/index.ts:49`、`websocket/index.ts:48` | 收进公共投递 helper | 共享投递实现单一 |
| E-13 ✅ | `这个会话不见了` 裸抛 18 处、错误码不一致 | `handler.ts` 8 处、`send.ts` 3 处、`promptSnapshot.ts` 2 处等 | 统一 `assertChatExists(chatId)`（带 `NOT_FOUND` 码，对齐 `archive.ts:27`） | 无裸抛，统一错误语义 |
| E-14 ⏸ | skill / plugin git 两阶段导入流程平行 | `src/service/skill/import.ts` vs `src/service/plugin/import.ts`（`preImportUrl→importUrl→commit` 骨架同构） | 抽 `createGitImportFlow({ analyze, commit, manifestKind })` 工厂 | 两处改为共享流程编排 |

### E 表执行状态（2026-09-28）

**已完成 11 项**（✅）：

- E-01：时间线类型族迁入 `packages/protocol/src/timeline.ts`（单一事实源），后端 `src/service/message/types.ts` 与前端 `web/src/services/agentApi.ts` 均改为别名 re-export；可选性分歧按宽松方向统一。`RuntimeSelection` 保留前端自有定义，响应壳（`TreeResumeResponse`/`ChatAbortResponse`）不迁。
- E-02/E-03：重复声明各删一处，收敛为单一定义。
- E-04：新建 `web/src/features/agent/composables/useComposerMedia.ts`（`MediaKind`/`MediaAttachment` 定义随迁），AgentDialog 与 lite 两侧共用。
- E-05：新建 `web/src/features/agent/runtime/roleConfigModel.ts` 访问器闭包工厂，两端调用点零改动。
- E-06：`src/service/config/operations.ts` 表驱动 `RESOURCE_OPS` + 通用 apply，错误文案逐字保留。
- E-07：新建 `web/src/utils/asyncGuards.ts`（`runSingleFlight` + `createStaleGuard`）；taskOverview/configApply/interactions/taskCatalog 已接入；settings/archive/suggestions 的 seq 守卫收益低暂缓。
- E-08 第一步：`db/usage.ts` 的 `page<T>` 提升为导出，`chat/usage.ts` 两处手写分页改用共享实现。
- E-09：新建 `src/db/helpers.ts`（`jsonRow`/`jsonRows`），6 个文件 12 处 JSON 列解析接入；4 个 `xFromRow` 保持不动（收益低）。
- E-10：`callList<T>`（保留 Array.isArray 严格语义）+ `uploadFile` 收敛；listSkills/listChatsPaged/listBrains 双字段返回保持手写。
- E-12 保守版：新建 `src/service/websocket/deliver.ts`（`deliverToSockets`），收口 6 处标准形投递循环（handler ×2、send、rootGraphPatch、spawnEager、websocket/index），失败日志事件名与级别逐站点保留；`wake.ts`（返回「是否命中订阅者」语义 + 异常上抛）与 `subagent/index.ts`（单连接、异常上抛）两处非标准形按决策不动。
- E-13：新建 `src/service/chat/guards.ts`（`assertChatExists`，带 `ErrorCode.NOT_FOUND`，文案逐字保留），替换 17 处裸抛（handler 7、send 3、promptSnapshot 2、generations/nodeDetail/wake/session/set 各 1），并将 `workflowHistory.ts` 原本手写字面量 `'NOT_FOUND'` 的 1 处并入同一守卫（语义一致）；`archive.ts` 先例保持不动。

**缓办 3 项**（⏸，理由如下）：

- E-11（30 个注册壳）：动 30 个文件的注册入口，纯结构收益、行为零变化，但 diff 面大、与并行开发冲突概率高；等大版本窗口再统一处理。
- E-14（git 导入工厂）：skill/plugin 导入流程各自仍在演进，抽象过早容易锁错形状；待两侧流程稳定后再抽。
- E-08 第二步（base64url/指纹游标统一）：三类游标语义不同（offset、base64url 分页、带指纹防漂移），强行统一需改协议行为，超出「合并相似逻辑」范畴。

---

## F. 超长文件与上帝函数（拆分目标）

「当前行数」为 2026-09-27 实测；验证方法统一为：目标函数/文件按基线拆分后，原「上帝函数」不再存在（拆为多个职责单一的函数/文件），且行为不变。

| 编号 | 目标 | 位置 | 当前行数（2026-09-27 实测） | 上帝函数/主要问题 | 拆分方向 | 验证方法 |
| --- | --- | --- | --- | --- | --- | --- |
| F-01 | `streamMapper.ts` | `src/service/chat/streamMapper.ts` | 913 | `streamAgentChunks` 单函数约 877 行；turn 关闭循环 ×6、终态五连发 ×3、3 视图 rootPatches ×2 | 按 chunk 类型拆 `handleStreamChunk`/`handleTerminalChunk` + 抽 `emitTerminalSequence`/`completePendingTurns` | 单函数 <200 行；重复模板收敛（预计减 ~300 行） |
| F-02 | `handler.ts` | `src/service/chat/handler.ts` | 2299 | `buildRootTimeline` 595 行（6 阶段内嵌）；`handleChatList` 176、`handleChatTimelineGet` 184、`handleChatInputSubmit` 187、`handleChatOpen` 183、`buildActiveTurns` 127 | timeline 投影域整体迁出为 `timeline.ts`；`buildRootTimeline` 按 4 阶段拆私有函数；pendingInputs 映射 ×3、runtime 溯源 ×3 下沉 | 文件 <1000 行；`buildRootTimeline` 拆为多私有函数 |
| F-03 | `message/types.ts` | `src/service/message/types.ts` | 3339 | 纯类型单文件；`SenseQuestionAnswerResponseData` 重复（见 E-03）；Chunk/Notification 13 字段重复 | 按域拆 `types/{chat,skills,plugins,terminal,notification}.ts` 后 re-export；抽 `EventEnvelopeBase`/`RunStateSnapshot` | 单文件 <800 行；重复类型收敛 |
| F-04 | `db/chat.ts` | `src/db/chat.ts` | 1296 | `deleteChats` 146 行；metadata 读取前置 ×10；月份路由 ×7；`getChatPreviews`/`getLastUserPrompts` 孪生 | 拆 chat/message/messageLink/pendingInput 仓库；抽 `getChatMetadataField`/`withChatMonthlyDb` | 文件瘦身；模板收敛 |
| F-05 | `liteProjection.ts` | `src/service/websocket/liteProjection.ts` | 924 | `projectTimelineNode` 107、`projectLiteNodeDetailResponse` 105、`applyLiteResponse` 108；数组 pick 投影 ×4 | 抽 `projectArrayByKeys` + 装箱守卫 helper；Lean 类型从 canonical 派生 | 上帝函数拆分；镜像类型收敛 |
| F-06 | `runtime.ts` | `src/service/chat/runtime.ts` | 799 | `ensureChat` 182 行；builder 初始化 8 位置参数调用 ×2 | 拆 runtimeCache/sessionRoleRuntime/ensureChat；初始化改 options 对象 | 单函数 <100 行；位置参数收敛 |
| F-07 | `middleware/chat.ts` | `src/agent/middleware/chat.ts` | 751 | `chatMiddleware` 187 行；`enrichMediaInputsMultimodal` 128 行 | 媒体富化三函数迁出为 `mediaEnrichment.ts`；抽 `runHookFailOpen` | 文件瘦身；媒体逻辑独立 |
| F-08 | `useMessageBranchTreeController.ts` | `web/src/features/pets/nyxus/components/useMessageBranchTreeController.ts` | 2079 | 上帝 composable：40+ computed、15+ watch、80+ 返回字段 | 按关注点拆 6 个 composable（相机/CRT/详情弹窗/折叠/GPU 场景），本文件只编排 | 单 composable <400 行 |
| F-09 | `agentApi.ts` | `web/src/services/agentApi.ts` | 2258 | 约 1340 行类型 + 约 900 行方法混放 | 拆类型文件（按域）+ 拆 `chatApi/skillsApi/pluginsApi` | 类型与方法分离；文件按域拆分 |
| F-10 | `stores/chats/index.ts` | `web/src/stores/chats/index.ts` | 1951 | `applyEvent` 142 行；8 个单飞 Map（`runSingleFlight` 已存在且已有 4 处使用，仍有 4 处手写） | 单飞统一收口 `runSingleFlight`；root 订阅生命周期与审批/提问命令分别抽出 | 单飞统一；子模块拆分 |
| F-11 | `reducer.ts` | `web/src/stores/chats/model/reducer.ts` | 1291 | `reduceNotification` 275 行、`reduceSessionEvent` 144 行、`reduceStaged` 135 行；finalMessage 双写 | 按事件域拆 `reducers/{runOutcome,interaction,timelineV2}.ts` | 上帝函数拆分 |
| F-12 | `useAgentDialogOptions.ts` | `web/src/features/agent/composer/useAgentDialogOptions.ts` | 1447 | `handleSend` 123 行、`onMediaSelected` 89 行 | 拆 `useComposerEditor`/`useComposerMedia`（媒体同时喂 Lite）；角色 helper 迁 `roleConfigModel.ts`（见 E-05） | 文件瘦身；媒体/编辑器独立 |
| F-13 | `RoleConfigPopover.vue` | `web/src/features/agent/runtime/RoleConfigPopover.vue` | 1445 | 思考等级切换整块约 445 行（script+template+样式） | 拆 `ThinkingLevelSwitch.vue` 子组件；角色 helper 抽模型（见 E-05） | 文件 <850 行 |
| F-14 | `useWorkbenchDialogController.ts` | `web/src/features/agent/workbench/useWorkbenchDialogController.ts` | 1152 | 解构 `useAgentDialogOptions` 63 字段 + 166 行 return 透传走廊 | 按语义聚合返回（`controller.composer.xxx`）；拆窗口/注意力子 controller | 透传走廊消除 |
| F-15 | `useHistoryDrawerPanelController.ts` | `web/src/features/agent/drawer/useHistoryDrawerPanelController.ts` | 1233 | `branchHistory` 95 行；group/direct transient 拼接成对重复 | group/direct 拼接抽纯函数；抽 `useEpochSnapshotLoader` | 重复拼接收敛 |
| F-16 | `ExecutionGraphPixiRenderer.ts` | `web/src/features/pets/nyxus/renderer/ExecutionGraphPixiRenderer.ts` | 1098 | `drawMotion` 125 行；节点状态色三目链 ×3 | 5 种特效拆独立方法；抽 `stateAccentFor`；贝塞尔几何抽共享库 | 单函数 <60 行 |
| F-17 | `useLiteViewController.ts` | `web/src/features/lite/useLiteViewController.ts` | 1052 | `computeTrajectoryLayout` 88 行、`onMediaSelected` 78 行（媒体与 AgentDialog 重复，见 E-04） | 媒体抽 `useComposerMedia`；瀑布流布局迁 `executionMonitor.ts` | 文件瘦身；媒体共享 |
| F-18 | `executionLayout.ts` | `web/src/features/pets/nyxus/graph/executionLayout.ts` | 1086 | `assignChildLanes` 208 行、`compactTopologySubtrees` 200 行 | 按阶段拆私有函数；parent 图构建抽共享 | 上帝函数拆分 |
| F-19 | `App.vue` | `web/src/App.vue` | 994 | 6 处 `CyberWindow` 10 个事件 props 模板重复；3 个窗口同步 watch 同构 | 抽 `WorkspaceCyberWindow.vue` + `WorkbenchTitleActions.vue` | 模板重复消除 |

---

## G. 现状基线快照（供回归判定参考）

下列数字为建立基线时实测，重构后应**变小或保持不变**；异常增大时检查是否引入回归。测量命令（PowerShell，排除 `node_modules`/`dist`/`.d.ts`）：

```powershell
foreach($d in @('src','web/src','packages','manager','relay')){
  $files=Get-ChildItem -Recurse -File -Include *.ts,*.tsx,*.vue -Path $d |
    Where-Object { $_.FullName -notmatch 'node_modules|dist|\.d\.ts$' }
  $sum=($files | ForEach-Object { (Get-Content $_.FullName).Count } | Measure-Object -Sum).Sum
  "{0}: files={1} lines={2}" -f $d, $files.Count, $sum
}
```

| 指标 | 基线值（2026-09-27 实测） | 说明 |
| --- | --- | --- |
| 后端源码规模 | `src/` 248 文件 / 57,180 行 | 服务 28k + agent 10k + db 5k + utils 4.6k + core 4.3k + memory 0.6k |
| 前端源码规模 | `web/src/` 481 文件 / 113,809 行 | 不含 `dist-electron`、测试 |
| 协议包 | `packages/` 9 文件 / 1,491 行 | 共享协议 |
| 管理模块 | `manager/` 9 文件 / 997 行 | 本地管理器 |
| 中转模块 | `relay/` 17 文件 / 1,865 行 | 中转进程（含测试） |
| knip 后端「未使用导出」 | 131 个（其中约 50 个为协议注册误报、约 15 个为冗余导出，其余为真死代码） | `npx knip` |
| knip 前端「未使用文件」 | 23 个（B-01 至 B-22 为主） | `npx knip --dir web` |
| jscpd 重复代码 | 22.7 万行 / 299 处克隆 / 重复率 1.90%（typescript 2.18%、less 5.75%） | `pnpm jscpd:dup`（2026-09-27 实测） |
| jscpd 死代码（basta） | 86 处 / 1.6%（unused-file 21、unused-export 38、unused-symbol 26、unused-import 1），覆盖前端 | `pnpm jscpd:deadcode` |
| jscpd 复杂度 | 总 29259 / 均值 40.1；最复杂文件 CX 706（`useMessageBranchTreeController.ts`） | `pnpm jscpd:complexity` |
| jscpd 健康分 | 77 / 100（B 级；duplication 满分、dead code 86、complexity 54） | `pnpm jscpd:health`，dashboard duplication 区为权威重复率 |
| TSC 基线 | `pnpm type-check` 0 错误（无预存） | [baseline.md](./baseline.md) |
| test/ 预存失败 | ≤86 视为通过（当前 `test/` 模块推迟，不跑） | [baseline.md](./baseline.md) |

---

## H. jscpd 回归检查（工具与命令）

[jscpd](https://github.com/kucherenko/jscpd) v5（Rust 引擎）作为本基线的**自动化回归工具**：重复检测用基线门禁（只拦新增），死代码/复杂度/健康度做报告对照。配置在根 `.jscpd.json`（扫描 `src/`、`web/src/`、`packages/`、`manager/`、`relay/`，排除测试与产物）。重复基线文件为根 `.jscpd-baseline.json`（提交入库，记录「已接受」的重复指纹）。

| 命令 | 作用 | 退出码含义 |
| --- | --- | --- |
| `pnpm jscpd:dup` | 全量重复扫描（报告） | 0：完成（不管有没有旧重复） |
| `pnpm jscpd:dup:check` | **回归门禁**：对比基线，只拦新增重复 | 0：无新增；1：有新增重复（阻断） |
| `pnpm jscpd:baseline` | 刷新重复基线（重构后代码变化、确认接受新状态时手动执行并提交） | 0：完成 |
| `pnpm jscpd:deadcode` | basta 引擎死代码扫描（覆盖前端，补 `deadcode:scan` 后端盲区） | 0：完成（报告） |
| `pnpm jscpd:complexity` | 复杂度排名（对应 F 表拆分目标） | 0：完成（报告） |
| `pnpm jscpd:health` | 健康评分 + 项目/Duplication/Complexity/Dead code 一屏总览 | 0：完成（报告） |
| `pnpm regression:code` | **一键综合回归**：`dup:check`（硬门禁）+ `deadcode` + `complexity` | 任一门禁失败即非 0 |

使用说明：

1. **每次大型任务收尾时**统一执行 `pnpm regression:code`：① 重复门禁若失败，说明引入了新复制粘贴，需合并或用 `pnpm jscpd:baseline` 刷新（仅在确认新重复合理时）；② 对照 deadcode/complexity 输出与 A/B/C/E/F 表，确认点名的清理/合并/拆分是否达成。
2. **复杂度与死代码当前不做硬门禁**（集中开发期误伤风险高），作报告对照；重复门禁为硬性阻断。
3. **health 徽章的 duplication 子项**存在工具口径差异（显示 0.0%），不作为重复率依据；以 `jscpd:dup` 与 dashboard Duplication 区的实际百分比为准。
4. `.jscpd-baseline.json` 与 `.jscpd.json` 一同入库；改动扫描路径、`minTokens`/`minLines` 等配置后，`dup:check` 的基线指纹会失配，需用 `pnpm jscpd:baseline` 重新生成。

---

## 使用约定

1. **每次大型任务收尾时**：先跑 `pnpm regression:code`（见 H 表）做自动化回归，再对照 A/B/C 表检查死代码与冗余是否按预期清理，对照 E/F 表确认点名的合并/拆分是否完成，并核对 G 表指标未异常增大。
2. **结论仍成立 = 问题尚未处理**；结论已达成（问题已解决）后，从对应表移除该行或标记状态。
3. **协议误报（D 表）与既有测试门控（[baseline.md](./baseline.md)）** 不因本基线变化而失效；删除符号前必须重新核实注册表与前端调用方。
4. 后续定义的工具/流程按各表「验证方法」列实现检查；无法机器判定的（如 E/F 的语义拆分）以人工对照 + 定向测试为准。
