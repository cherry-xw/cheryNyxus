# 主 Agent 运行流程观察

本模块提供默认关闭的只读观察和长期结果回放。它不拥有执行权，不调用发送、续跑、审批或中止，不修改中间件顺序与唤醒策略。字段与状态的唯一 owner 是[workflow 协议](../../shared/protocol/workflow.md)，展示规则归[前端专题](../../frontend/runtime-diagram.md)。

## 任务定位

| 修改意图 | 实现入口与关键符号 | 验证重点 |
| --- | --- | --- |
| 订阅、多窗口与重连 | [workflow.ts](../../../src/service/chat/workflow.ts) `openWorkflow`、`closeWorkflow`、`initialWorkflowSnapshot` | 幂等、所有权、版本与无执行副作用 |
| 基础边界 | [workflowObservation.ts](../../../src/core/middleware/workflowObservation.ts) `reportWorkflow`、`observeWorkflow` | 无观察者时不推送，回调异常隔离 |
| 长期回放、分页 | [workflowHistory.ts](../../../src/service/chat/workflowHistory.ts) `readWorkflowHistory` | 根会话范围、完整批次、固定边界与重建质量 |
| 技能结果口径 | [workflowEvidence.ts](../../../src/service/chat/workflowEvidence.ts) `effectiveSkillCount`、`skillActivation` | 正文可靠格式、撤回、替换、去重与未知 |
| 冻结资源摘要 | [promptSnapshot.ts](../../../src/service/chat/promptSnapshot.ts) `buildLivePromptSnapshot`；[runtime.ts](../../../src/service/chat/runtime.ts) `ensureChat` | 同一次提示词构建、冷恢复、不套用当前磁盘配置 |
| 最终结果附注 | [observer.ts](../../../src/service/chat/observer.ts) `observeAgentChunks`；[executionGraph.ts](../../../src/db/executionGraph.ts) `upsertExecutionNode` | 独立附注合并、可选证据写失败不阻断任务 |

## 当前投影

第一个租约建立 chat 级投影，活跃会话才安装 Core 回调；其他窗口共享投影、持有独立租约。最后一个租约结束释放投影与回调。`connectionManager.onClose` 回收连接租约，`onChatLifecycle` 在归档时停止活跃观察，删除时通知失效并释放租约；不注册为执行 owner。

`publish` 直接使用既有 transport 编码发往观察连接，不进入 chat/root journal。输入、模型准备/实际 adapter 调用/响应处理、重试退避、完整工具清单、Checkpoint 和 Loop 决策来自真实边界。工具执行、审批、问题和父子边界消费既有语义通知，不消费逐 token 帧。

中途打开读取现有运行事实、pending interaction、当前阶段工具归属与派发/回传。当前短阶段无法确认时保持未知。`DoneChunk.waitingForChild` 只携带既有 yield 决策，避免将等待子任务误当完成；持久 termination 优先于等待附注。子内部消息不进入主 Agent 投影。

模型 Hook 使用 `resolveBrainAdapterKey` 确认请求前实际接线，再按已发布注册表和 matcher 判断；工具 Hook 按工具名匹配。标记只表达条件挂载，不执行 handler，不保存 Hook 时间线。

## 持久结果与恢复

沿用现有 JSON，没有 schema 迁移、新表或保留期变化：

| 位置 | 内容与写者 |
| --- | --- |
| `chat_epoch_snapshots` 的资源清单 JSON：`resources.workflow` | `memoryCount`、`skillCount` 来自同次 `buildPromptPieces` 构建；runtime 与配置纪元切换冻结时写入 |
| 执行节点 `workflow.commands` | observer 观察到临时指令正文实际进入消息，再给关联用户输入保存名称 |
| 执行节点 `workflow.skillActivation` | 最近一次可靠的技能正文加载结果，含 callId/name/bodyLoaded；不是所有工具的追踪列表，完整计数仍核对有效消息 |
| 执行节点 `workflow.outcome/outcomeRunId/outcomeAt` | Loop 正常出口的 completed/waiting 结果与所属 run；异常和控制退出沿用既有 termination |
| 摘要节点 `workflow.compaction` | observer 在 generator 收口后确认内存采用了新摘要，记录 applied 与 summaryMessageId |

`upsertExecutionNode` 合并 workflow 的一级字段，保留其他独立结果附注；同一键表示该项最新最终结果。旧记录字段可缺失，不回填当前配置。

当前有效上下文优先读取 `peekChatMessages`，该入口不会创建 runtime；冷状态按原有摘要恢复规则投影。实际采用摘要才清批次并切阶段，压缩请求只显示请求状态。配置纪元与压缩阶段独立。技能计数只覆盖可靠关联的 skill 正文，排除撤回、被替换、已裁剪内容；错误文本不计成功，不能因工具 Promise 正常返回就计数。

## 历史读取与降级

历史只读 messages、execution nodes 和 message links，不调用 canonical timeline 修复路径。工具批次作为完整事实分页，前端展开为清单和各调用步骤；缺失工具结果保持 unknown。派发仅接受 actor 为主 Agent 的边界，回传必须有 child_return 关联。没有证据的模型准备、重试和 Hook 不补造。

首次读取固定时间上界；游标包含目标、阶段、上界、位置和所读事实指纹。后续页面拒绝跨目标/阶段游标；上界内事实被撤回、更新或补注时返回 CONFLICT，客户端重新加载；新增上界外事实不混入当前回放。顺序无法严格还原时标记 reconstructed，不声称精确时序。

只有压缩标签的旧摘要可形成重建阶段；活跃纪元末尾尚未确认采用的摘要不单独切阶段。精确附注缺失的历史保持不完整。历史资源按消息所属纪元取冻结值，缺 epoch 或缺冻结计数保持未知；调用结果携带对应步骤的资源摘要，回放不提前显示后续技能正文。

## 扩展与验证

新边界先确认是否已有结果或通知可复用；不要为视觉连续性制造执行事实。新增持久项只能保存无法可靠重建的必要最终结果，协议同步 Zod 校验与两端消费。

自动入口为 `pnpm type-check:all`、`pnpm build`、`pnpm web:build`、`pnpm test:web`。后端 `test/` 冻结期间，当前实现的隔离 fixture 和运行命令登记在[活动计划入口](../../plan/README.md)，不访问用户数据库；解除冻结后再按[测试基线](../../quality/testing/baseline.md)迁入正式后端测试。真实图形界面由用户验收。
