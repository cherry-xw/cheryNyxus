# Agent 执行观察与记录

本模块维护执行步骤的后端写者、订阅投影、恢复和失败边界。字段与状态的唯一 owner 是[workflow 协议](../../shared/protocol/workflow.md)，画布行为归[前端专题](../../frontend/runtime-diagram.md)。本能力只观察既有执行，不调用发送、续跑、审批或中止，也不改变中间件顺序与唤醒策略。

## 1. 实施状态

详细执行事实已经落地：`workflowRecorder.ts` 随 run 安装记录 sink，`workflowStepWriter.ts` 为排队、审批、协作等 run 外边界提供相同的受控写入口，二者都独立于 UI 租约。`workflowJournal.ts` 持久化 occurrence/event、root sequence/revision 与 gap；`workflow.ts` 只在提交后向 root 范围租约发布有界增量。旧十节点快照和重建历史继续作为兼容路径。

## 2. 任务定位

| 修改意图 | 当前入口 | 验证重点 |
| --- | --- | --- |
| 租约、多窗口与重连 | [workflow.ts](../../../src/service/chat/workflow.ts) `openWorkflow`、`closeWorkflow`、`publish` | 幂等、连接所有权、栅栏、版本缺口与无执行副作用 |
| 运行边界报告 | [workflowRecorder.ts](../../../src/service/chat/workflowRecorder.ts) `startWorkflowRunRecorder`、[workflowStepWriter.ts](../../../src/service/chat/workflowStepWriter.ts) `recordWorkflowStep` | UI 关闭仍记录；回调与写入异常隔离 |
| 长期读取 | [workflowHistory.ts](../../../src/service/chat/workflowHistory.ts) `readWorkflowHistory` | root/分支/阶段范围、索引分页、固定上界与证据质量 |
| 持久写入 | [workflowJournal.ts](../../../src/db/workflowJournal.ts) `appendWorkflowJournalEvents`、`readWorkflowJournalPage` | 幂等、单调 sequence、短事务、删除/归档生命周期 |
| 内容与状态来源 | [observer.ts](../../../src/service/chat/observer.ts) `observeAgentChunks` 及真实 middleware/Loop/协作边界 | 不复制正文、不猜锚点、不把局部失败提升为 run 失败 |
| 前端推送 | 现有 transport 与 workflow 租约投影 | 只发布已提交增量、批次有界、慢消费者失效重取 |

## 3. 现行实现边界

详细记录随执行边界存在，不随租约创建或销毁。第一个 root 范围租约仍建立兼容快照投影，其他窗口共享投影并持有独立租约；最后一个租约结束只释放界面投影。`connectionManager.onClose` 回收连接租约；观察不注册为执行 owner。

`src/core/middleware/workflowObservation.ts` 允许同一 chat 的记录器与兼容界面投影并存，单个回调失败不会阻断其他观察者或执行。旧兼容历史仍复用：

| 位置 | 已有内容 |
| --- | --- |
| `chat_epoch_snapshots.resources.workflow` | 同次提示词构建冻结的 memory/skill 数量 |
| 执行节点 `workflow.commands` / `skillActivation` | 指令名称和可靠技能正文激活结果 |
| 执行节点 `workflow.outcome` | Loop 的最终结果与 run 关联 |
| 摘要节点 `workflow.compaction` | 已确认采用的摘要关联 |

`upsertExecutionNode` 的 workflow 附注和旧事实重建只服务兼容回放；详细步骤由独立 journal 承载。`readWorkflowHistory` 优先使用索引步骤分页，并仅在 journal 不存在时进入旧重建路径。

## 4. 记录链路

### 4.1 写者与数据流

记录器是 service 运行生命周期的一部分，而不是 UI 租约的副作用。执行开始前为 run 安装受控语义 sink，执行结束时解除；是否打开工作台不影响记录。Core 与各 middleware 只报告协议允许的语义事件，不依赖数据库或前端。

```text
真实执行边界
  -> 语义事件（稳定 occurrence/source key）
  -> service 有界队列或短批次
  -> 独立步骤 journal 事务（event + root sequence + workflow revision）
  -> after-commit 增量
  -> 各 workflow 租约
```

- 同一 source key 重报必须幂等；一次 occurrence 的终态不可翻转。可批量提交相邻小事件，但批处理不能合并不同调用、attempt 或因果身份。
- 持久提交先于实时通知。投影失败可重建，不能把未提交内存事件发送成“可恢复历史”。
- 队列、事务条数、通知条数与帧大小均有硬上限。慢客户端只导致该订阅失效重取；不能反压 Agent，也不能形成无界内存。
- 记录错误被隔离并诊断。恢复后尽可能追加 gap 边界；无法证明完整的 run/阶段通过 history completeness 暴露，不伪造缺失事件。
- 正常 run 收口尽力排空本 run 的有界待写批次；进程异常或写入失败留下 unknown/gap，不能据下一次启动补成功。

### 4.2 观察边界

记录器只在实际语义边界接线：提交/排队/消费、上下文构建或恢复、真实指令注入、请求准备与 adapter 调用、模型可见通道、每次重试、工具校验/授权/审批/预检/执行/结果、Checkpoint 记录、Loop 决策、派发/返回/接收/唤醒以及压缩请求/摘要/采用。

不得为视觉完整性记录未发生的模板槽位。流 token 不逐帧落步骤 journal；可用文本、思考摘要、参数、结果与原始错误继续由既有消息/工具 owner 保存，步骤只写受控类别和显式引用。尚未接线的 Hook 不报告事件。

运行中尚无消息节点时先写无 content anchor 的 occurrence；内容提交后按确定 ID 追加关联事件。`ToolCallOwner`、conversation branch、spawn task、child_return 和 compaction boundary 等现有明确关系应复用；禁止扫描最近消息或文本猜关联。

## 5. 存储与生命周期

步骤事实使用 `workflow_occurrences`、`workflow_step_events`、`workflow_journal_roots` 与 `workflow_journal_gaps` 独立表，不把事件数组附着到 execution node JSON。索引支持按 root + sequence、chat/run、branch/context stage、occurrence 和 call 定向读取；单次追加或分页查询不先加载整段详细历史。

- occurrence 身份与生命周期事件是步骤 journal 的持久事实；可增加可重建的活跃索引或物化投影，但不能把它变成第二个历史 owner。
- 消息正文、工具参数/结果、执行图边、分支身份和代际继续留在既有表。步骤 content anchor 使用显式外部引用，不复制载荷。
- 配置 epoch 和压缩 context stage 分开保存。压缩不删除事实，更早阶段通过分页读取。
- root 归档保留可读；root 删除在同一业务删除流程级联步骤。独立 branch 删除时清除其专属 chat/branch 步骤，不能删除共享前缀；失败不得留下可被投影为另一分支的孤儿记录。
- 新存储沿用任务数据保留期，不建立更短 TTL。旧数据不迁移、不补写详细步骤，继续以 legacy/reconstructed 质量读取已有粗粒度证据。

## 6. 投影、同步与恢复

`chat.workflow.open/close` 负责连接租约，步骤投影按 root task 聚合。open 建立通知栅栏并返回有界活跃快照、有限尾部与 workflow revision；`workflow.updated` 只发布已提交的追加事件批次及 base/revision。版本不连续、流更换或溢出后要求重取。

步骤增量不写 chat/root journal，也不为每个步骤调用 `buildRootTimeline` 或 `emitTimelinePatch`。前端分别接收 canonical timeline 与步骤流，再以显式 anchor 合成图。内容尚未到达时引用保持 unresolved；内容删除、revoke 或分支切换改变展示，不改写步骤归属。

历史读取直接走索引和不透明 cursor，第一页固定 `upperSequence`；每页只访问所需范围并保持批次/occurrence 边界可恢复。上界内事实或已引用内容变更导致 CONFLICT；读取不创建 runtime、conversation task、epoch 或修复记录。归档 root 可读，子 chat 作为过滤条件而不是独立历史根。

恢复时从持久事件折叠 occurrence。没有终态的旧 run 显示 unknown，明确 waiting/cancelled/interrupted 按原事实恢复。只有 compaction applied 事件切换 context stage；不能用当前配置或新的 active branch 重写旧事实。

## 7. 扩展与验证

新增步骤 kind 前先确认真实边界、隐私预算、幂等 source key、所属 run/attempt/call、终态和内容 owner。协议 Zod、持久 schema、记录器、分页与前端降级必须同批演进；不能只添加视觉节点。

计划内隔离 fixture 覆盖无观察者运行、多观察者、重复事件、写失败/gap、终态幂等、无锚点后补、审批与子任务等待、子孙 Agent、索引分页、固定上界、删除和版本失配；入口为 `pnpm exec vitest run --config docs/plan/main-agent-runtime-diagram/verify/vitest.config.ts`。后端 `test/` 冻结期间不得修改或运行，也不得访问用户数据库。最终跨端回归由[活动计划](../../plan/main-agent-runtime-diagram/README.md)收口。
