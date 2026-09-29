# 排队消息三模式虚化展示与撤回

**文档创建时间：** 2026-09-28T22:10:00+08:00

**状态：** 执行中

## 目标与边界

**目标：** 让三种工作台模式（树/对话/精简）对「已接受但尚未被模型采用」的排队用户消息做到：

1. **立即显示**：发送后马上出现在数据流中，不等模型响应（当前精简模式 Bug：发送后直到模型响应回来才显示）；
2. **虚化区分**：排队态用「虚化」视觉与已提交/响应态明显区分；
3. **撤回删除**：排队消息可撤回（已消费、已进入模型请求的不可撤回）；
4. **末尾定位**：对话/精简模式把排队消息强制排到当前响应消息之后；
5. **清理残留**：删除已死亡的 `chat.send`/`chat.resume` 线上 RPC 残留（常量/schema/协议文档行）。

**边界（不做）：**

- 不改变消息采用策略本身（沿用「下一次可采用时加入」：checkpoint 每轮起点批量排空 `soul.userInputs`）；
- 不新增「等本次任务完成再处理」备选策略（设计初稿待讨论项）；
- 不涉及上下文统计、待办进度等其他规划主题；
- 已消费/已进入模型请求的消息不可撤回，只针对排队态。

**设计依据：** [上下文统计、待办进度与连续消息交互](../conversation-observability-and-input/README.md) 的[设计初稿](../conversation-observability-and-input/01-design-draft.md) 第 6、8 节（连续消息采用与三模式展示、撤回排队消息为「有明确需求后追加」项）。

## 批次与小任务台账

| 批次 | 小任务 | 状态 | 复杂度及依据 | 依赖 |
| --- | --- | --- | --- | --- |
| C | [C1 树模式虚化节点与撤回入口](C1-tree-virtual-nodes.md) | 等待用户确认 | 3：在现有排队节点投影上加虚化样式与撤回入口；受 Nyxus `round` 重构未提交修改影响 | B1 |
| C | C2 对话模式虚化气泡与末尾定位 + 撤回 | 已完成 | 3：现有 pendingInputHistory 增强 + 末尾强制排序 + 撤回入口 | B1 |
| C | C3 精简模式虚化行与末尾定位 + 撤回 | 已完成 | 3：A1 确认的链路基础上加虚化样式与撤回入口 | B1、A1 |
| D | [D1 综合验证与用户验收](D1-final-verification.md) | 未开始 | 3：三模式联动、多消息、停止/恢复、撤回竞态、重启恢复 | C 批完成后建立清单 |

## 已完成小任务结果

### A1 精简模式排队消息即时显示链路证实与修复（已完成）

- **验证结论：** 新增集成测试 `web/test/lite/pendingInputChain.test.ts`（真实 Pinia store + `prepareInput` + `useLiteCanonicalView.pendingInputs` + `projectLiteHistory` + `buildLiteRows`，并用 Vue `computed` 验证响应式即时显示）。运行结果：2/2 通过。
  - `prepareInput` 后 `pendingInputs` 立即可见（content/state/messageId 正确）；
  - 响应式投影立即产出 `kind:'user'` 独立行（不等模型响应）；
  - `visibleNodes` lane 过滤不丢弃 user 行（user 恒入 root lane）；
  - 消费后按 messageId/sourceMessageId 去重，不闪出两条用户消息。
- **结论：** 未发现需要修复的代码缺口——发送后即时显示的数据链路已被 `3754369b` 在数据层面解决。真实渲染像素无法在本环境验证（无 DOM/截图，按项目约定由用户人工验收）；若用户当前运行版本仍不显示，属构建未更新或渲染层问题，由 C3 增强与 D1 验收时一并覆盖。
- **完成状态：** 已完成（原文档已删除）。

### A2 死亡 RPC chat.send/chat.resume 清理（已完成）

- **变更对象：**
  - `src/service/message/internalCommand.ts`：删除 `CHAT_SEND`/`CHAT_RESUME` 两个不可调用标识。
  - `src/service/message/schemas.ts`：删除 `[InternalCommand.CHAT_SEND]`（z.object）与 `[InternalCommand.CHAT_RESUME]`（chatIdSchema）条目。
  - `src/service/message/types/methods.ts`：删除两条请求/响应映射 + 4 个不再使用的类型 import。
  - `src/service/websocket/index.ts`、`src/service/chat/spawnEager.ts`：`shouldPersistChatEvent` 删除死亡的 `'chat.send'/'chat.resume'` 字面量（保留仍生效的 `'chat.startSpawn'`）。
  - `docs/shared/protocol/websocket.md`：删除合同表中 `chat.send`/`chat.resume` 两行；重放表「跳过发起动作」行去掉 `chat.resume`。
- **验证结论：** `pnpm type-check` 通过；`pnpm docs:check` 仅剩工作区既有 WIP 问题（runtime-diagram 目录删除、workflow.ts 桩、node-tree-fold-round、lite-tool-display、workbench-files-terminal verify 产物），本任务未引入新问题。
- **保留（内部执行仍依赖）：** `handleChatSend`/`handleChatResume`/`launchDetachedResume` 及 `ChatSendRequestData` 等数据类型、send.ts 日志事件名、内部流程注释。
- **已知后续项：** `docs/shared/protocol/interactions.md` 仍以历史帧格式展示 `chat.send`/`chat.resume` 请求示例；按项目约定保留历史帧格式供参考（websocket.md 第 42-43 行声明），不在本任务重写。
- **完成状态：** 已完成（原文档已删除）。

### B1 chat.input.withdraw 撤回 RPC（已完成）

- **变更对象：**
  - 协议包 `packages/protocol`：`rpc.ts` 的 `Method` 增加 `CHAT_INPUT_WITHDRAW: 'chat.input.withdraw'`；`chat.ts` 增加 `ChatInputWithdrawRequestSchema`（inputId/clientMessageId 至少其一）+ `ChatInputWithdrawResponse`。
  - `methods.ts`：Method 枚举 + 请求/响应类型映射；`chat.ts` 类型：`ChatInputWithdrawRequestData`/`ResponseData`；`schemas.ts` 请求 schema；`responseSchemas.ts` 响应 schema（state 固定 `cancelled`）。
  - 核心层：`MessageJournal.removeUserInput`（按 inputId/clientMessageId/commandId 从 `soul.userInputs` 移除）+ `AgentSession.removeInput` + `AgentBuilder.removeInput` 门面。
  - 服务层：`runtimeCache.removeQueuedChatInput`（返回 removed/absent/already-adopted 三态，区分无 runtime 与已被采用）；`pendingInput.ts` 新增 `findPendingInput` + `cancelQueuedPendingInput`（仅 `state='queued'` 可迁移）。
  - `input.ts` 新增 `handleChatInputWithdraw`：claim 幂等 → 查行 → `cancelled` 幂等返回 / 非 `queued` 拒绝 / 已采用拒绝 → 内存移除 + DB cancelled → `finishActiveWorkflowSteps`（kind 'queue'，anchor=message，status cancelled，reason user）终态化排队步骤 → 推 `input.updated {state:'cancelled'}`（前端按 inputId 移除排队消息）。注册于 `handler.ts`。
- **用户确认的关键决策：** 仅 `queued`（运行中排队）可撤回；`started`（正在响应的首条指令）与 `consumed` 拒绝。
- **验证结论：** `pnpm type-check` 通过。
- **无需改动项：** 重启重入队已由 `listPendingInputs` 的 `state IN ('accepted','started','queued')` 过滤天然排除 `cancelled/rejected`。
- **完成状态：** 已完成（原文档已删除）。前端调用入口归 C1-C3。

### C2 对话模式虚化气泡与末尾定位 + 撤回（已完成）

- **变更对象：** `HistoryItem` 与 `pendingInputHistory` 保留排队状态、输入 ID、客户端消息 ID 和队列序号；合并历史后将 `queued` 项按队列序号追加至末尾并去重；气泡增加虚化样式、排队标记和撤回按钮；控制器仅对仍为 `queued` 的输入调用撤回，并显示失败提示；历史项顺序或排队状态变化时触发末尾定位。
- **自动验证：** `pnpm exec vitest run --config web/vitest.config.ts web/test/agent/historyTransient.test.ts web/test/lite/executionMonitor.test.ts`，退出码 0；`historyTransient.test.ts` 覆盖保留状态、按队列序号排序、排在当前响应之后及去重。
- **完成状态：** 已完成；小任务文档已删除。

### C3 精简模式虚化行与末尾定位 + 撤回（已完成）

- **变更对象：** Lite pending 行保留原始状态及撤回标识；`queued` 行按队列序号排在当前轨迹之后，增加虚化样式、排队标记和撤回按钮；控制器仅撤回仍处于 `queued` 的输入并显示失败提示；队列内容或状态变化会触发自动跟随（用户关闭自动跟随时沿用原行为）。
- **自动验证：** `pnpm exec vitest run --config web/vitest.config.ts web/test/agent/historyTransient.test.ts web/test/lite/executionMonitor.test.ts`，退出码 0；Lite 投影用例覆盖当前响应之后的 queued 行及其撤回身份字段。`pnpm web:type-check`，退出码 0。
- **完成状态：** 已完成；小任务文档已删除。

## 依赖与恢复检查点

- **已完成事实：**
  - `chat.send`/`chat.resume` 是 `src/service/message/internalCommand.ts` 中「不可调用标识」（`deliberately absent from public Method`），未在任何 router 注册，前端不调用；`schemas.ts`/`methods.ts` 有对应 schema 与类型映射；`websocket.md` 仍按 RPC 方法登记（stale）。
  - 内部执行函数 `handleChatSend`/`handleChatResume` 仍被 `chat.input.submit` / `chat.run.resume` 复用，必须保留。
  - 精简模式 pending 投影已于 2026-09-28 提交（`3754369b`）：`projectLiteHistory` 投影排队输入、`useLiteCanonicalView.pendingInputs` 合并 session+root 的 pending、`useLiteViewController` 传入 `history`。静态链路完整但用户报告发送后仍不显示，根因未证实，由 A1 用集成测试证实/证伪。
  - 三模式现有排队展示基建：树 `executionGraph.projectInputNodes`、对话 `historyTransient.pendingInputHistory`、精简 `executionMonitor`；均无虚化区分、无撤回、对话/精简未强制排末。
- **当前工作：** A1、A2、B1、C2、C3 已完成。C1 等待用户决定如何处理 Nyxus `round` 折叠模式重构的未提交修改；C1 完成后再进行 D1 综合验证。
- **工作区基准：** 工作区存在大量前端/服务和其他计划的未提交修改；继续实施前重新核对相关文件，不覆盖原有改动。
- **验证记录：** `pnpm exec vitest run --config web/vitest.config.ts web/test/agent/historyTransient.test.ts web/test/lite/executionMonitor.test.ts`，退出码 0；`pnpm web:type-check`，退出码 0；`git diff --check`，退出码 0。`pnpm --filter web lint` 退出码 1，报告了多个工作区文件的 Prettier 规则错误，需在最终验证时区分既有工作区错误与本任务。
- **下一步：** 等待用户确认 C1 的 WIP 处理方式；之后执行 C1 和 D1。最终文档检查命令为 `pnpm docs:check`。

## 最终综合验证与用户审批

- D1 完成后运行类型检查、定向测试与 `pnpm docs:check`，输出用户验收操作卡（树/对话/精简三模式：立即显示、虚化区分、撤回、末尾定位、多消息连发、停止/恢复、重启恢复各场景）。
- 全部必要验证通过后进入「待用户审批」；用户批准后将长期事实迁入权威文档（共享时间线/协议/前端模块说明），从计划总入口移除任务并删除本目录，不保留「已完成」台账。
