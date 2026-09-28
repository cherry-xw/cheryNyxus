# Agent 执行观察与记录

本模块维护执行步骤的后端写者与持久记录。字段与状态的唯一 owner 是[workflow 协议](../../shared/protocol/workflow.md)。本能力只观察既有执行，不调用发送、续跑、审批或中止，也不改变中间件顺序与唤醒策略。

## 1. 实施状态

详细执行事实已经落地：`workflowRecorder.ts` 随 run 安装记录 sink，`workflowStepWriter.ts` 为排队、审批、协作等 run 外边界提供相同的受控写入口，二者都独立于界面。`workflowJournal.ts` 持久化 occurrence/event、root sequence/revision 与 gap；`publishWorkflowJournalInvalidation` 在聊天删除后递增存续 root 的 revision。旧十节点快照和重建历史继续作为兼容读取路径，只读、不写入。

## 2. 任务定位

| 修改意图 | 当前入口 | 验证重点 |
| --- | --- | --- |
| 运行边界报告 | [workflowRecorder.ts](../../../src/service/chat/workflowRecorder.ts) `startWorkflowRunRecorder`、[workflowStepWriter.ts](../../../src/service/chat/workflowStepWriter.ts) `recordWorkflowStep` | UI 关闭仍记录；回调与写入异常隔离 |
| 持久写入 | [workflowJournal.ts](../../../src/db/workflowJournal.ts) `appendWorkflowJournalEvents`、`recordWorkflowJournalGap`、`readWorkflowStepSnapshot` | 幂等、单调 sequence、短事务、删除/归档生命周期 |
| 内容与状态来源 | [observer.ts](../../../src/service/chat/observer.ts) `observeAgentChunks` 及真实 middleware/Loop/协作边界 | 不复制正文、不猜锚点、不把局部失败提升为 run 失败 |
| 界面资源摘要 | [workflowHistory.ts](../../../src/service/chat/workflowHistory.ts) `workflowResources`、`workflowStageId` | 复用冻结资源快照，不新造数据源 |

## 3. 现行实现边界

详细记录随执行边界存在，不随任何界面开关创建或销毁。记录器在请求、模型、批次、逐调用校验/审批/执行/结果、记录及 Loop 边界维护明确的前驱身份，写入既有 `causeOccurrenceId`。批次关联可以在清单确定后补入；同一调用的身份不能因另一个调用交错而改变。实际输入落库将提交、队列和消费关联起来；消息后补锚点复用原模型实例。请求保留消费/指令作为执行前驱；同一 run 内已完成的 context 与 request 由前端投影为并行资源供给，不替换单一 cause。旧测试数据不迁移，可清空后重新生成。

`src/core/middleware/workflowObservation.ts` 提供只读边界回调，单个回调失败不会阻断其他观察者或执行。旧兼容历史仍复用：

| 位置 | 已有内容 |
| --- | --- |
| `chat_epoch_snapshots.resources.workflow` | 同次提示词构建冻结的 memory/skill 数量 |
| 执行节点 `workflow.commands` / `skillActivation` | 指令名称和可靠技能正文激活结果 |
| 执行节点 `workflow.outcome` | Loop 的最终结果与 run 关联 |
| 摘要节点 `workflow.compaction` | 已确认采用的摘要关联 |

`upsertExecutionNode` 的 workflow 附注和旧事实重建只服务兼容读取；详细步骤由独立 journal 承载，不反向写入旧附注。

## 4. 记录链路

### 4.1 写者与数据流

记录器是 service 运行生命周期的一部分，而不是界面的副作用。执行开始前为 run 安装受控语义 sink，执行结束时解除；是否打开任何界面不影响记录。Core 与各 middleware 只报告协议允许的语义事件，不依赖数据库或前端。

```text
真实执行边界
  -> 语义事件（稳定 occurrence/source key）
  -> service 有界队列或短批次
  -> 独立步骤 journal 事务（event + root sequence + workflow revision）
  -> after-commit 通知（记录体系订阅方，如删除失效通知）
```

- 同一 source key 重报必须幂等；一次 occurrence 的终态不可翻转。可批量提交相邻小事件，但批处理不能合并不同调用、attempt 或因果身份。
- 队列与事务条数有硬上限。记录错误被隔离并诊断。恢复后尽可能追加 gap 边界；无法证明完整的 run/阶段通过 history completeness 暴露，不伪造缺失事件。
- 正常 run 收口尽力排空本 run 的有界待写批次；进程异常或写入失败留下 unknown/gap，不能据下一次启动补成功。

### 4.2 观察边界

记录器只在实际语义边界接线：提交/排队/消费、上下文构建或恢复、真实指令注入、请求准备与 adapter 调用、大模型响应、每次重试、工具校验/授权/审批/预检/执行/结果、Checkpoint 记录、Loop 决策、派发/返回/接收/唤醒以及压缩请求/摘要/采用。模型 occurrence 的请求、响应和终态阶段由前端映射为“模型请求 → 大模型响应 → 响应分流”，不新增虚假 occurrence。

不得为视觉完整性记录未发生的模板槽位。流 token 不逐帧落步骤 journal；可用文本、思考摘要、参数、结果与原始错误继续由既有消息/工具 owner 保存，步骤只写受控类别和显式引用。尚未接线的 Hook 不报告事件。

运行中尚无消息节点时先写无 content anchor 的 occurrence；内容提交后按确定 ID 追加关联事件。`ToolCallOwner`、conversation branch、spawn task、child_return 和 compaction boundary 等现有明确关系应复用；禁止扫描最近消息或文本猜关联。

工具链记录时机：`tool-list`（调用清单）在首个工具链事件（`sense_pending`/`sense_end`）到达时提前建立（running，收集中），批次边界只补真实 `batchId` 与 succeeded 终态；`tool-approval` 的 started 记录在 `sense_end`（授权之后），使清单→校验→授权→审批的 firstSequence 顺序与模板链一致。审批注册（`sense_pending`）本身仍在模型流中发生，仅记录时机延后，不改变审批 UI 与执行语义。

模型 occurrence 的终态化时机：模型响应消息（含工具调用）在 checkpoint 中间件提交时（message_created，先于 sense_pending/sense_end）即 succeeded（reason=response），而不是拖到 Phase 2 批次边界。这样“大模型响应”节点与 model→response→channels→tool-list 前驱连线能随工具链同批点亮（前端 response 槽位要求模型已终态、前驱路径证明要求 cause.status === 'succeeded'）。纯文本轮（无工具）由 done 收口，仍以消息 anchor 点亮响应节点。

上下文 occurrence 的时机：不在 recorder 创建时抢占首位（避免流程开始时“上下文构建”先于“消费与输入记录”点亮，与模板链不符）。整个 run 只建立一个 run 级 context occurrence（不携带 iteration/attempt），在第一个“准备请求”边界随 request 一并记录，firstSequence 位于 input 之后、request 之前，使点亮顺序与模板链一致。

Checkpoint（内容记录）只建立一个 occurrence：checkpoint 边界（记录汇总）建立时立即挂接已完成工具结果的关系锚点（message anchor + causeOccurrenceId），工具结果消息提交复用同一 occurrence（current('checkpoint', true) 命中则复用，否则才新建）。前端因此能同时点亮两条入边（模型响应→响应分流→内容记录 与 工具结果→内容记录），不会出现一先一后的两个内容记录实例。

## 5. 存储与生命周期

步骤事实使用 `workflow_occurrences`、`workflow_step_events`、`workflow_journal_roots` 与 `workflow_journal_gaps` 独立表，不把事件数组附着到 execution node JSON。索引支持按 root + sequence、chat/run、branch/context stage、occurrence 和 call 定向读取；单次追加或快照读取不先加载整段详细历史。

- occurrence 身份与生命周期事件是步骤 journal 的持久事实；可增加可重建的活跃索引或物化投影，但不能把它变成第二个历史 owner。
- 消息正文、工具参数/结果、执行图边、分支身份和代际继续留在既有表。步骤 content anchor 使用显式外部引用，不复制载荷。
- 配置 epoch 和压缩 context stage 分开保存。压缩不删除事实，更早阶段通过快照读取。
- root 归档保留可读；root 删除在同一业务删除流程级联步骤。独立 branch 删除时清除其专属 chat/branch 步骤，不能删除共享前缀；失败不得留下可被投影为另一分支的孤儿记录。
- 新存储沿用任务数据保留期，不建立更短 TTL。旧数据不迁移、不补写详细步骤，继续以 legacy/reconstructed 质量读取已有粗粒度证据。

## 6. 删除与失效

聊天删除流程中，对每个存续的受影响 root，在 soul.db 同一事务内递增 `workflow_journal_roots` 的 revision 与 history_generation（[chat.ts `updateWorkflowAfterChatDeletion`](../../../src/db/chat.ts)），并通过 `publishWorkflowJournalInvalidation` 通知记录体系订阅方；没有订阅方时通知为空操作。删除前必须完成同级 chat、消息、epoch、execution 与 branch/task 清理，避免孤儿步骤。

恢复语义：从持久事件折叠 occurrence。没有终态的旧 run 显示 unknown，明确 waiting/cancelled/interrupted 按原事实恢复。只有 compaction applied 事件切换 context stage；不能用当前配置或新的 active branch 重写旧事实。

## 7. 扩展与验证

新增步骤 kind 前先确认真实边界、隐私预算、幂等 source key、所属 run/attempt/call、终态和内容 owner。协议 Zod、持久 schema 与记录器必须同批演进；不能只添加视觉节点。

正式测试覆盖工具链记录顺序与 root 事件流（`test/service/chat/workflowRecorder.test.ts`、`test/service/chat/flowSync.test.ts`，入口 `pnpm test:backend`）。后端 `test/` 冻结期间不得修改或运行，也不得访问用户数据库；真实界面由用户验收。
