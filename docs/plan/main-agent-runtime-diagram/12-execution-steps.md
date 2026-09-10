# T12 详细执行步骤事实

**文档创建时间：** 2026-09-10T15:50:56+08:00

状态：未开始（当前仅整理方案）。所属[总任务](README.md)。复杂度 5/5：运行观察、持久化、恢复和跨端关联。依赖 T08。以下均为未来方案，不表示已添加协议或代码。

## 目标与现状

已有 workflow 十类快照、visited 集合和最终结果附注不能恢复全部细节历史；节点树 committed/revoked 是内容持久状态，不是运行成功/失败。目标是补充必要的详细执行证据，并复用现有消息与显式分支关系，不另建消息正文存储。

现有入口：[步骤观察](../../../src/core/middleware/workflowObservation.ts) 的 reportWorkflow/observeWorkflow、[服务观察](../../../src/service/chat/observer.ts) 的 observeAgentChunks、[执行节点存储](../../../src/db/executionGraph.ts) 的 upsertExecutionNode，以及[协议](../../../packages/protocol/src/workflow.ts) 的 WorkflowSnapshot/WorkflowFact。

## 拟定事实模型

区分模板 kind、实际 occurrence、所属 run、iteration、attempt、call，以及内容锚点。实例 ID 全生命周期不变，重复执行生成新 ID，结束事件幂等。开始顺序只用于稳定展示，不把交错或嵌套步骤强制改成串行因果关系。

状态需覆盖执行中、等待、成功、失败、拒绝、取消和中断；等待/暂停不记成功。进程异常结束后无法确认的尾部保持结果未知，不能刷新后自行改成完成。步骤失败不直接覆盖 Agent 总状态。

仅保存受控类别、身份、时序、状态和明确内容关联；不复制提示词、工具参数、返回正文、密钥或原始异常。名称/说明由模板解释步骤含义，实际内容仍由现有详情入口读取。

## 真实流程与覆盖清单

| 环节 | 已核对入口 | 需设计的观察边界与陷阱 |
| --- | --- | --- |
| 提交与排队 | chat/handler 的 handleChatInputSubmit；chat/send 的 handleChatSend | 输入被接受、排队、消费分离；不产生第二条主链 |
| 上下文 | chat/runtime 的 ensureChat；agent/prompt 的 buildPromptPieces | 发生在模型循环之前，复用/恢复/重建分开，不能靠模型阶段补造 |
| 指令 | chat/autoCompact 的 injectCommands | 实际注入才记录，临时正文不得变成用户消息 |
| 输入/记录 | middleware/checkpoint；chat/observer | 逐次明确输入、响应、工具结果记录；token 流不逐帧落库 |
| 请求 | middleware/chat 的 chatMiddleware/handleStream/handleNonStream | 媒体、选项、转换、守卫、真实请求和响应边界；迭代器创建不等于响应完成 |
| 重试 | middleware/retry 的 retryMiddleware | 单次失败、撤回和退避；旧尝试遗留步骤必须收口，不跟随下一次请求成功 |
| 工具 | middleware/tool 的 buildSenseTrigger/doExecuteSense | 校验、授权、审批、执行前检查、执行和结果；控制退出不同于工具失败 |
| Loop | middleware/loop 的 createLoopHandler | 洋葱嵌套而非简单串行；继续/等待/限制/终止分别记录 |
| 协作 | sense/spawn；chat/wakeScheduler、wake | 派发、子完成、结果接收和继续分离；父子/下级均有独立实例 |
| 压缩 | AgentSession.send 的 compactToLatestSummary；chat/observer | 请求、生成摘要、实际采用分离；保留历史代际 |

本表定位沿用已核对源码符号，实施时再确认具体边界。尚为 stub 的 Hook 不作为实际步骤。记录模型提供的可用思考摘要通道，不承诺不可见的内部推理过程。

## 存储与同步方案待论证

候选 A：步骤附着既有 execution node 的 JSON。优点是复用删除、代际和图同步；风险是早期无锚点、单节点无限增长、重试撤回影响、流中消息锚点尚未持久化，以及每次更新触发全图重建。

候选 B：独立执行步骤事实，显式关联已有消息与分支。优点是可单项增量与分页、早期步骤独立保存；风险是新持久生命周期、迁移/删除与跨端同步成本。

不能仅因为 A 不新增表就提前锁定。最终方案必须证明：

- 没有用户消息、模型尚未出内容、子任务刚启动也能留下真实步骤，或明确记录覆盖缺口。
- 消息与工具批次非一对一，不按“最近消息”或时间相邻猜测所属关系。
- UI 未打开也保留应记录的新历史，多个观察者互不覆盖，观察写失败不阻断执行。
- 主/子/继续/解释分支和配置纪元、压缩代际都可确定归属。
- 持久写入、通知和读取有界，长任务不会反复重写无限大的 JSON 或逐步骤重建整图。
- 程序正常/异常退出、取消和恢复均有明确收口和缺口语义。
- 旧数据不补造内部步骤；关闭图不停止任务，读取历史不创建 runtime。
- 不改变执行顺序、审批策略或现有唤醒语义。

## 未来实施步骤

- [ ] 完成存储与增量方案论证，更新唯一权威契约和写者说明。
- [ ] 实现实例类型、纯记录状态机、独立观察通道。
- [ ] 按覆盖清单逐项接入真实边界，并明确条件/未覆盖状态。
- [ ] 接入持久写者、图同步、分页与刷新/代际恢复。
- [ ] 以隔离 fixture 覆盖失败、重试、无锚点、取消、恢复和幂等。
- [ ] 类型检查与定向回归通过后回写结果，不能以代码骨架作为完成。

后端 test/ 冻结期间不得修改或运行该目录。未来纯 fixture 使用任务 verify 隔离配置，不访问用户数据库；长期测试迁移遵循项目政策。本轮不运行产品测试，不安装依赖。
