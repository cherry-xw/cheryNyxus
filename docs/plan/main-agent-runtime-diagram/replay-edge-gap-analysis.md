# 历史回放链路断点分析

> 对话 ID：cc193936-8267-4cb5-baed-e19995bfce61
> 分析对象：前端历史回放模块（runtime-diagram 的历史回放路径）
> 分析范围：从 `chat.workflow.history` 读取到 `RuntimeDiagram` 高亮的具体事实，并基于既有契约与代码给出冲突与矛盾点。

本文件只做事实复盘与原因定位，不修改任何代码或持久契约；修复方案与改动列表另起实施计划并先在 T07 / 验证计划登记。

## 1. 数据链路总览

历史回放贯穿三条独立链路，每条链路都有明确 owner：

| 链路 | 写入 owner | 读取入口 | 前端投影 |
| --- | --- | --- | --- |
| 详细 occurrence / event | `service/chat/workflowRecorder.ts`、`workflowStepWriter.ts` | `chat.workflow.history` 走 journal 索引 | `headerState.ts → headerEdgeEvidence.ts → WorkflowHeaderEdge.vue` |
| 旧十节点 fact（兼容路径） | `service/chat/workflowHistory.ts` 的 `readLegacyWorkflowHistory` | 同样 `chat.workflow.history`，在没有 journal 时降级 | `model.ts → replayFrames / replaySnapshot → useWorkflowController.snapshot` |
| 结果树与时间线 | `canonical timeline` 既有 owner | `projectNyxusFoldedGraph`（受 runtime-diagram 调用） | `workflowProjection.ts` 中 `ResultTreeProjection`，与回放链路解耦 |

历史回放把 cursor 推进到 N，对应核心数据是 `WorkflowHistoryResponse`：

- 新路径返回 `events / occurrences / gaps / facts`；
- 旧路径只返回 `facts`，`nodeId ∈ {context, command, input, model, retry, tools, checkpoint, decision, compact, result}`。

新路径是步骤协议（`packages/protocol/src/workflow.ts`）下的 `WorkflowStepEvent` / `WorkflowOccurrence`，由 `projectHeaderEdgeEvidence` 投影到 `WORKFLOW_HEADER_TEMPLATE.edges` 上亮边。旧路径则走十节点快照，是回放断点最集中的入口。

## 2. 完整的拓扑链路（template）

`WORKFLOW_HEADER_TEMPLATE.edges`（`web/src/features/agent/workbench/runtime-diagram/headerTemplate.ts` 第 215-263 行）是头部流程图的"完整链路"来源。亮边规则是 `projectHeaderEdgeEvidence`：在 `WORKFLOW_HEADER_TEMPLATE.edges` 里取每条 `template.id`，并要求 occurrence 落入两端 `node` 匹配且 `chatId / runId / callId` 对齐。

| 区域 | 边（source → target，role） |
| --- | --- |
| 接入 | `submission → queue → entry → input → command（条件）/ request（条件）` |
| 上下文供给 | `context → request（supply）` |
| 模型 | `request → model → response → checkpoint（条件）/ tool-list（条件）/ channels（supply）` |
| 重试 | `model → error（retry）→ retry → request / result` |
| 工具 | `tool-list → validation → authorization → approval-needed → approval/preflight（条件） → preflight → execution → tool-result`；任一节到 `rejection`；`rejection → tool-result` |
| 结果 | `tool-result → checkpoint → decision → entry（loop）/ wait / result` |
| 等待 | `wait → wake → entry` |
| 协作 | `execution → dispatch → child-run → child-return → parent-receive → wake / input` |
| 压缩 | `request → compact-request → compact-summary → compact-applied → request` |
| 续接 | `resume → tool-list / tool-result`（工具失效走 `tool-result`） |

这是**模板声明的完整链路**，是合同模板，不代表任意 run 都会把每条都点亮。

## 3. 实际运行可能产生的事实

### 3.1 详细 occurrence（journal 路径）

`workflowRecorder.ts` 把 middleware 抛出的 `WorkflowBoundary` 折叠成 occurrence，**写入 `causeOccurrenceId` 的入口只有两处**：

- `onBoundary` 里 `predecessor(kind, callId)` 返回上一节点身份（行 122-176）。
- `recordChunk` / `recordCommittedMessage` 显式补 `causeOccurrenceId`（例如 input → queue、tool-result → checkpoint、submission → queue 等）。

`predecessor` 是关键：

```text
input  ← 上轮 loop-decision
command ← 当前轮 input
request ← 当前轮 retry | command | input | context
model   ← 当前轮 request（同 attempt）
retry   ← 当前轮 model（同 attempt）
tool-list ← 当前轮 model（同 attempt）
checkpoint ← 当前轮 model（同 attempt）
loop-decision ← checkpoint
result  ← loop-decision | retry | model
```

这套规则覆盖单一 Loop 内串行，但**两个边界会让链路在 detail 投影上"断"**：

1. **多 iteration 跨边界**：仅 `input` 关心"上一轮 loop-decision"。其它节点只看同 iteration 内 "latest"。一旦 compaction 切换 `contextStageId` 或新建 run，新的 occurrence 几乎无 `causeOccurrenceId`（只能指向同 attempt 的旧项），而旧 run 的最近 occurrence 还停留在原 attempt。
2. **工具批次的失败/拒绝汇入**：`tool-result` 的 predecessor 退到 `tool-execution` / `tool-preflight` / `tool-approval` 等多个分支。`recordChunk` 中 `sense_reject` 还会再补 `tool-approval` / `tool-preflight` 的终态。`projectHeaderEdgeEvidence` 选择这条边时使用 `targetSequence` 最新原则，**但若 `tool-approval` 与 `tool-execution` 都存在且 sequence 接近，会出现同 target 上一节点闪烁**。

### 3.2 旧十节点 fact（兼容路径）

`workflowHistory.ts` 的 `readLegacyWorkflowHistory` 直接消费 `getMessages` 与 `listExecutionNodes`，按行追加 `WorkflowFact`：

```text
for row in messages:
  if row.revoked || row.role === 'sense': continue
  append user input / command fact           (nodeId ∈ {command, input})
  append assistant fact                       (nodeId = model)
  append tool-batch fact（从 row.sense_calls 重建）(nodeId = tools)
  append termination / outcome fact           (nodeId ∈ {decision, result})
  append context compaction fact              (nodeId = compact)
```

返回的 `facts` **只有 `nodeId / status / runId / batch / callId / orderKey / orderQuality`**。`WorkflowFactSchema` 本身（`packages/protocol/src/workflow.ts` 第 310-322 行）**没有 `causeOccurrenceId` 字段**，因此"上一个节点 / 下一个节点"的因果关系只能由 `nodeId` 与 `orderKey` 推导。

前端 `replayFrames` 把每个 fact 摊成多帧，`replaySnapshot` 用 `nodeId` 序列生成 `visitedNodeIds / activeNodeId / phaseLabel`，但**没有任何阶段把 `nodeId` 与 `WORKFLOW_HEADER_TEMPLATE.edges` 对齐**，旧路径下 `WorkflowHeaderEdge.vue` 的 `evidenced` 始终为 `false`——只有 detail path 才会经过 `projectHeaderEdgeEvidence`。

## 4. 历史回放的渲染链路

历史回放由 `useWorkflowController`（`runtime-diagram/useWorkflowController.ts`）触发：

```text
loadHistory(stage?)
  → readWorkflowHistoryPages(...workflowApi.history...)
  → history = WorkflowHistoryResponse
  → snapshot     = replaySnapshot(...)       // 旧路径
  → workflowState = buildWorkflowReplayState(...) // 新路径
  → 经 headerGraph.ts → projectHeaderEdgeEvidence → edges[*].evidenced
```

`useWorkflowController.snapshot` 仅在 fact 模式生效（行 67-92），`projectedWorkflowState` 则在新 occurrence 模式生效（行 93-96）。`RuntimeDiagram.vue` 模板根据 `controller.replay.value` 走两条分支：
- `controller.replay.value && history.value` → 进入回放状态，挂在 `replayTimelineChange` 上的 `RootTimelineSnapshot` 是受 timeline 数据驱动而非 workflow 数据驱动。
- 旧路径进入 `controller.snapshot` 不会回写 `replayTimelineChange`。

## 5. 冲突与矛盾点（结论）

经过(a) 模板完整链路、(b) 实际可能产生的事实、(c) 历史回放渲染链路三方面事实比对，发现冲突集中在三类：

### 5.1 旧事实 schema 不带因果，回放帧与模板边不可对齐

- `WorkflowFactSchema` 没有 `causeOccurrenceId`。
- `model.ts/replaySnapshot` 推进 `activeNodeId` 时仅依赖"当前帧的 `nodeId` 与上一帧的 `nodeId`"，没有与 `WORKFLOW_HEADER_TEMPLATE.edges` 做交集。
- `projectHeaderEdgeEvidence` 是 detail occurrence 路径独有，旧事实路径根本不调用，因此**所有旧事实回放时 `evidenced` 都是 false**。
- 这意味着：用户看到的"上一个节点亮，下一个节点亮"在旧路径下**根本不会发生**，只能看到 `activeNodeId` 的当前节点本身有"运行"高亮，而节点之间的连线是默认模板边，看起来是"隔着非常远的中间节点"。这是用户描述的断点。

### 5.2 跨 iteration / 跨 run 的 predecessor 缺失

- `predecessor(kind, callId)` 对 `request / model / retry / tool-list / checkpoint / loop-decision / result` 等大多数 kind 都只回看 `latest.get(kind)` 在当前 `(iteration, attempt)` 内的最近值。
- 当一条新 run 进入第一个 occurrence，或 compaction 触发 `contextStageId` 切换时，`latest` 是空的，**大量 occurrence 没有 `causeOccurrenceId`**。
- `projectHeaderEdgeEvidence` 退到 `legacyHeaderPredecessor`：根据 `kind` + `runId` + `iteration` + `attempt` + `firstSequence` 在同一 run 内推断上游。推断规则允许跨 iteration 跳回 `loop-decision`，但**跨 run 直接断开**，因为 `participating` 过滤器要求 `runId === state.scope.runId`。
- 当一个 run 启动后切换了 runId（例如前一轮 paused 之后 user 输入触发新 run），第一个 `model / checkpoint / loop-decision` 找不到 source，于是亮边只能从 `entry` 开始，但 entry 是 `unobserved`，导致 `entry → input` 之后出现"input → model"看似隔了若干层的视觉感受。

### 5.3 旧链路重建逻辑的保守规则让"中间节点缺失"

- `legacyHeaderPredecessor` 在 `request` 的 case 里：

  ```text
  return latest(round.filter(item => item.kind === 'input' || item.kind === 'command' ||
      (item.kind === 'retry' && (item.attempt ?? 0) === (target.attempt ?? 0) - 1) ||
      (item.kind === 'compact-applied' && item.attempt === target.attempt)),
    ['input', 'command', 'retry', 'compact-applied']) ?? latest(attempt, ['context'])
  ```

  这意味着 `request` 的父节点可能是 `compact-applied`，却跳过中间的 `model → response`。在 `WORKFLOW_HEADER_TEMPLATE.edges` 里 `compact-applied → request` 是合法边（role=compact），但视觉上模型/响应链断了一节。

- 旧事实路径走 `replaySnapshot` 时 `visitedNodeIds` 的更新规则：

  ```text
  if frame.nodeId === 'model') visitedNodeIds = []
  else if (activeNodeId && !visitedNodeIds.includes(activeNodeId))
    visitedNodeIds.push(activeNodeId)
  ```

  每次进入 `model` 会清空 visitedNodeIds，然后直到下一节点才把 `model` 推入。**这意味着同一轮循环内 `model → response → checkpoint` 这条链在回放过程中不连续地保留**——也即两帧之间出现"model 消失，response 出现"的瞬态。这与 `activeNodeId` 单点高亮的实现并不冲突，但会让"中间节点缺位"的感受更明显。

### 5.4 用户描述的"上一个节点亮、下一个节点之间隔着非常远的中间节点"的直接成因

综合 5.1 / 5.2 / 5.3：

1. 旧事实回放帧只在 `activeNodeId` 上加 running 高亮；
2. `evidenced` 为 false 时所有模板边按 `stroke: var(--border-strong)`（`WorkflowHeaderEdge.vue` 第 35-39 行）渲染默认色，不会亮起；
3. 历史回放主时间线 `displayTimeline`（`RuntimeDiagram.vue` 行 504-509）来自 `replayTimeline`，而 `replayTimeline` 是由 `RootTimelineSnapshot`（canonical 内容时间线）提供，**与 `WORKFLOW_HEADER_TEMPLATE.edges` 完全解耦**。结果树侧有 `head:{laneId}` 这条 attachment 边（`workflowProjection.ts` 第 491-504 行），但它只在内容侧把"最后一个 content node"连到 header，不是模板内多节点链路。

## 6. 可行性结论

仅靠现有数据无法满足用户描述的"上一个亮、下一个亮、中间连线亮"的链路需求，**冲突主要在历史回放模块的实现层**：

- **事实层（旧路径）**：协议 schema 不带 `causeOccurrenceId`，projection 也不消费模板边。这层需要补：
  - 给 `WorkflowFactSchema` 加 `causeOccurrenceId?: string`（向后兼容，旧数据缺字段不破坏）。
  - `readLegacyWorkflowHistory` 在已有 `nodeId / orderKey / runId` 基础上补推导：同 run、相同上下文阶段、按 `nodeId` 与典型链路（input → request → model → checkpoint → decision）写回 `causeOccurrenceId`。`orderQuality='reconstructed'` 的事实允许带 `causeOccurrenceId`，但需要标注"推导得到"。
  - 推导规则要避免"按照模板连通性生成不存在的执行步骤"——这是协议 §6 "不补造缺失步骤"的红线，因此只能补"已有事实之间的桥接"，不能新增事实。

- **渲染层（新 + 旧路径都要支持）**：
  - `replaySnapshot` 应在 fact 模式下也产出"亮边的 source/target"——把 `visitedNodeIds` 替换为"按事实序列累计的可走路径"，并把当前帧到下一帧之间的边视作 "evidenced"。具体做法：把 fact 序列先按 `WORKFLOW_HEADER_TEMPLATE.edges` 投影成 `target → [path]` 表，回放时把 cursor 之前的整条 path 标记为 evidence。
  - `projectHeaderEdgeEvidence` 要在 fact 模式下被同样调用：把每个 fact 映射到最近的 template node（用 `legacyHeaderPredecessor` 同规则的 `nodeId ↔ kind` 表），然后复用既有的"路径唯一性"算法生成 evidence。这样两套回放路径用同一份 evidence 计算，行为一致。

- **跨 run / 跨 iteration 边界**：仍然建议在投影层（不修改 journal）补一条"run / iteration 衔接的占位边"——模板里的 `decision → entry` 与 `wake → entry` 正是为这种衔接而设。当前 `headerEdgeEvidence` 把 `runId` 不一致的 source 直接 `continue`，让这两条模板边永远不点亮。放开这条规则需要文档与契约同步，因为目前的设计明确"按 run 隔离"（`docs/shared/protocol/workflow.md` §3.1）。

- **旧事实 schema 升级的协议影响**：`causeOccurrenceId` 进入 `WorkflowFactSchema` 是协议层变动，**必须在 `packages/protocol/src/workflow.ts` 与 `docs/shared/protocol/workflow.md` 同批修改**。同时 `docs/standards/documentation/content.md` 要求"持久文档影响"必须更新权威说明，故 `workflow.md` §5、§6 与 `runtime-diagram.md` §5 的"实现与验证入口"都要补登记。

按上述路径，可以在不修改历史数据、不引入第二套历史 owner 的前提下让回放帧显示"上→下"亮边并连通中间节点。是否启动实施应进入 [T07 综合验证与用户验收](../plan/main-agent-runtime-diagram/07-final-verification.md) 与工作台历史回放验收流程登记后再决定。
