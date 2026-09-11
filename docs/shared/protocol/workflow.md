# Agent 执行观察契约

本文是执行步骤身份、状态、关联、同步与历史质量的唯一 owner。界面投影见[执行生长图](../../frontend/runtime-diagram.md)，后端写者与恢复边界见[观察实现](../../backend/service/workflow.md)。

## 1. 实施状态

`packages/protocol/src/workflow.ts` 已同时提供详细 occurrence/event 契约与旧十节点快照兼容字段。`chat.workflow.open` 会解析请求 chat 所属 root，并返回有界 `steps` 快照；`workflow.updated` 可携带已提交的 `events`、`gaps`、`baseRevision` 与 `revision`；`chat.workflow.history` 使用固定步骤上界分页。旧客户端仍可只消费 `snapshot` 与既有历史字段。

## 2. 现行兼容基线

- `chat.workflow.open` 使用 `chatId` 与窗口稳定的 `observerId` 建立租约，返回 `subscriptionId`、`streamId` 和完整快照；`close` 只释放调用连接持有的租约，断线自动回收。
- `workflow.updated` 保留可选完整快照，同时详细步骤增量只来自 journal 的 after-commit 通知；步骤事件不进入 chat/root journal。
- 旧节点仍为 context、command、input、model、retry、tools、checkpoint、decision、compact、result。没有详细 journal 的旧历史从持久消息、执行节点及少量 workflow 附注重建，细节缺失时不得补造。
- 等待模型、审批、回答或子任务返回属于 running；paused、completed、failed、cancelled 必须有控制事实。生成器退出、断线或暂时没有新事件不能独自证明完成。

## 3. 事实模型

### 3.1 模板、实例与事件

模板 kind 只定义可理解的步骤名称、说明、所属区域与头部槽位，不代表实际执行。只有真实边界发生后才写入步骤实例（occurrence）；同类步骤、同名工具或同一 Loop 再次执行必须产生新的 `occurrenceId`。

每个实例由独立的、追加式生命周期事件描述。协议与持久实现保持以下语义：

| 身份或关联                    | 约束                                                                                           |
| ----------------------------- | ---------------------------------------------------------------------------------------------- |
| `occurrenceId` / `eventId`    | 全局稳定；事件可幂等去重，实例结束后身份不变                                                   |
| `rootChatId` / `chatId`       | 分别确定任务范围与实际执行 Agent 会话；不得靠角色名或消息文本推断                              |
| `taskId` / `branchId`         | 有显式任务/会话分支时随写入冻结；子 Agent 血缘仍使用既有派发关系，不伪装成 conversation branch |
| `runId` / iteration / attempt | 区分运行、Loop 轮次和模型重试；一次尝试失败不能被下一次尝试的成功覆盖                          |
| batch / `callId`              | 批次与每次工具调用分别关联；同名调用不合并，清单顺序不冒充执行因果                             |
| parent / cause                | 容器关系与因果关系分别显式引用；时间相邻只用于稳定展示，不生成因果边                           |
| content anchor                | 可引用既有消息节点、工具调用、分支锚点或压缩边界；正文继续由原 owner 提供                      |
| step sequence                 | 在 root 范围内单调、只增，用于分页与确定性展示；与显式因果关系含义不同                         |

启动时尚无内容节点的步骤允许先以 run 和分支身份存在，内容持久化后再追加关联事件。不得按“最近一条消息”、时间邻近或相同工具名补锚点。一个实例可以有多个有类型的内容关联，消息与工具批次不要求一对一。

步骤事实只保存受控 kind、身份、关系、顺序、时间、状态、等待/错误类别和内容引用；不得复制提示词、工具参数、工具结果正文、密钥、原始异常或不可见推理。模型实际提供且允许展示的文本、思考摘要和工具结果仍保存在既有内容节点，步骤只引用它们。

### 3.2 生命周期

实例投影状态为 `running`、`waiting`、`succeeded`、`failed`、`rejected`、`cancelled`、`interrupted` 或 `unknown`。其中 succeeded 至 interrupted 为终态；终态只接收不改变结果的后补关联，不得被重复回调翻转。骨架的“未开始”是前端模板状态，不是持久步骤事实。

- `waiting` 必须带受控原因，例如模型、审批、用户回答、子任务返回或重试退避；等待和 run 的 paused 均不是成功。
- 单步、工具或一次模型尝试失败不直接决定 Agent/run 的总体状态。总体状态继续使用既有 run、termination 和 Loop 控制事实。
- 显式拒绝、取消和中断分别记录，不能归并成失败。正常收口幂等；程序异常结束且没有终态证据的实例在恢复投影中为 unknown，不自行补成成功。
- 重试撤回或消息 revoke 只改变内容可见性。失败尝试及其步骤仍留在历史，并继续归属于原 attempt。
- 压缩请求、摘要生成、摘要采用分别记录；只有采用事件切换 `contextStageId`。配置 `epochId` 与上下文阶段独立，压缩不删除旧步骤。
- 尚为 stub 或仅有配置声明的 Hook 不产生步骤事件。Hook 挂载提示是展示元数据，不是执行历史。

## 4. 分支、协作与内容图

步骤事实与 canonical timeline 是两个 owner 明确的事实切片。消息、工具正文、分支边、派发/返回关系、代际与 `conversation_tasks.active_branch_id` 继续由[权威时间线](../architecture/canonical-timeline.md)及既有表维护；步骤流不得复制正文或创建第二套活动主干身份。

- 前端仅通过显式 content anchor 把步骤与内容节点连接。两个流到达顺序不同时暂存未解析引用，不能猜测关系。
- 派发成功、子 Agent 完成、结果回传、父 Agent 接收和继续运行是不同事实。子 Agent 与其下级均拥有独立 chat、run 和 occurrence。
- conversation branch 共享前缀时不复制步骤；新分支只拥有分叉后的实例。活动分支切换不移动、不改写也不重新归属既有事实。
- 根任务归档后事实仍可读；压缩只改变默认窗口。删除根任务时级联删除全部步骤，删除独立分支时原子删除该分支专属步骤；共享前缀保留在原 owner。独立步骤不设置短于任务数据的 TTL。

完整头部身份不由步骤协议另设字段：唯一 `activeBranchId` 对应的 original/continuation 分支使用完整头部；非活动 original/continuation、全部 detail 分支和所有层级子 Agent 使用简略头部。旧数据没有任务身份时，前端可把 root chat 作为唯一兼容主干，但读取不得为此创建任务或修改数据。

## 5. 订阅与分页

`chat.workflow.open/close` 继续使用既有租约语义，详细步骤范围解析为 root task。记录与订阅解耦：没有观察窗口时仍写入步骤，打开或关闭界面不改变历史覆盖率。

实时链路采用“有界快照 + 已提交增量”：

1. open 在订阅栅栏内返回当前非终态实例、有限近期尾部、步骤 revision 和是否存在更早历史；不返回整段无限增长的 JSON。
2. `workflow.updated` 只发送持久提交后的追加事件批次，携 `baseRevision` 与 `revision`。客户端发现版本缺口、stream 变化或批次超限标记时重新取快照，不能忽略缺口继续合并。
3. 通知按数量与帧大小有界批处理；慢观察者不得形成无界队列。溢出时发送失效信号并要求重取，不阻塞 Agent。
4. root timeline 与步骤流各自保持唯一 revision。内容锚点未到达时前端保留待解析状态，待对应内容提交后连接；任一流更新不得触发另一个流的整图重建。

`chat.workflow.history` 的详细步骤直接按 root、分支、`contextStageId` 和单调 sequence 走索引分页，不先读完整步骤历史再切片。第一页固定步骤上界并返回不透明 cursor；后续页沿用同一上界。分页响应分别表达：

- `complete`：该游标方向已无下一页；
- `historyComplete`：固定上界内是否存在记录缺口；
- `orderQuality`：顺序为 exact 还是 reconstructed；
- gap/legacy 范围：哪些 run 或阶段只有旧粗粒度证据。

上界内事实或所引用内容发生影响回放的变化时返回 CONFLICT 并要求重载；跨 root、分支、阶段或快照的游标返回 INVALID_PARAMS。旧十节点历史可作为明确标记的 legacy/reconstructed 摘要展示，但不能展开成不存在的内部步骤。

## 6. 一致性与失败边界

运行边界先产生语义事件，服务层记录器以有界队列或短批次持久化；同一事件的 source key 必须幂等。实时通知只消费已提交事实，不能把仅在内存出现的状态宣称为可恢复历史。

记录、投影或观察失败不得改变 Agent 的执行顺序、审批策略、唤醒策略和最终结果。记录器恢复后应写入可识别的 gap；无法证明完整的 run/阶段返回 `historyComplete=false`。历史查询只读，不创建 Agent/runtime、不激活纪元、不修复旧数据，也不写配置。

## 7. 实现与验证

共享类型与校验由 [`packages/protocol/src/workflow.ts`](../../../packages/protocol/src/workflow.ts) 维护，RPC 名称由 `packages/protocol/src/rpc.ts` 注册。持久写入与分页入口见[后端观察实现](../../backend/service/workflow.md)，前端 reducer、统一图投影、工作台阅读、回放与生长动效见[执行图说明](../../frontend/runtime-diagram.md)；最终跨端验证由[活动计划](../../plan/main-agent-runtime-diagram/README.md)收口。

验证必须覆盖重复事件、终态幂等、交错因果、无内容锚点、重试撤回、审批等待、取消/异常退出、分支切换、子孙 Agent、压缩阶段、分页上界、版本缺口与旧数据降级。后端 `test/` 冻结期间只使用计划内隔离 fixture，不访问用户数据库；真实界面由用户验收。
