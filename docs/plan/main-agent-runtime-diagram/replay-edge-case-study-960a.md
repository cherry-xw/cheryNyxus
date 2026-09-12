# 历史回放链路分析 · 真实 chat 案例对照（SQLite 实测修订版）

> 配套阅读：[`replay-edge-gap-analysis.md`](./replay-edge-gap-analysis.md)（上一轮的链路分析）。
> 案例 chat：`960adc9b-7495-4a11-b273-53287b3e2023`，对照 chat：`cc193936-8267-4cb5-baed-e19995bfce61`。
> 数据源：**`.chery/db/soul.db`**（`2026-09.db` 无 workflow 表，workflow journal 只在 soul 库）+ `.chery/logs/2026-09-12.log` 第 3656-3809 行。
> 本版为 v2：v1 的 §1.2/§1.3/§2.5 基于日志+代码推断，多处被真实数据推翻，已按 SQLite 实测逐条修订（✅ 确认 / ❌ 推翻 / ✏️ 修正）。

## 0. 实测方法与数据概貌

用 `better-sqlite3` 把 soul.db 拷贝到 `.tmp/dbcopy/` 后只读打开（探针脚本留在 `.tmp/probe-960a*.cjs`），拉取两张 journal 表的原始行并解析 `payload_json`：

- `workflow_journal_roots`：`next_sequence=49, revision=42, history_generation=0, history_complete=1`；`workflow_journal_gaps` 为空。
- `workflow_occurrences`：**18 条**（两个 run 各 9 条），`workflow_step_events`：**48 条**，全部 `order_quality='exact'`。
- 两个 run：run A `8381cc3c…`（12:30:13 "你有哪些能力？"）、run B `1977fd82…`（12:30:46 "测试一下你的提问能力。"），**各 1 个 iteration** —— 日志时间线里"第 2 轮"其实是**新 run**，不是同 run 的第 2 次迭代（v1 §1.1 第 35 行的标注有误）。

## 1. 960a 实测事实链

### 1.1 顶层执行轨迹（后端日志原文）

| 时间 | 事件 | 对应链路位置 |
| --- | --- | --- |
| 12:30:02.216 | `chat.create` | 接入起点（无独立步骤事件） |
| 12:30:13.528 | `chat.send.start` "你有哪些能力？" | run A 输入进入 |
| 12:30:13.540/.542 | `loop.start max=30` / `loop.iter n=1` | run A 迭代 1 |
| 12:30:13.552 | `message.created` user + `input.consumed` | submission/queue/input |
| 12:30:13.562 | `llm.req` MiniMax-M3 stream | request → model |
| 12:30:22.704 | `llm.resp chunks=137` / `staged content_end` | model 响应完成 |
| 12:30:22.717 | `message.created` assistant 1098 字 | checkpoint（+model anchor） |
| 12:30:22.719 | `loop.decision decision=stop reason=last-assistant` / `loop.end` | loop-decision |
| 12:30:22.726 | `chat.run.done` | result |
| 12:30:46.432 | `chat.send.start` "测试一下你的提问能力。" | **run B（新 run，iteration 重置为 1）** |
| 12:30:58.697/.702 | `loop.decision stop` / `chat.run.done` | run B 同构收尾 |
| 12:32:47.355 | `chat.workflow.history` success | 历史回放取数入口 |

### 1.2 实测 occurrence 因果链（真实行，按 first_sequence）

run A（run B 完全同构，occurrence id 不同）：

```text
seq 1-3   submission  cause=(none)              anchors=message:message-840463ee
seq 4-9   queue       cause=submission          anchors=message:message-840463ee
seq 6-7   context     cause=(none)  ←孤立       anchors=(none)
seq 8-11  input       cause=queue   iter=1 att=1 anchors=message:message-840463ee
seq 12-13 request     cause=input   iter=1 att=1
seq 14-19 model       cause=request iter=1 att=1 anchors=message:335f3bc5（assistant，seq19 追加）
seq 18-20 checkpoint  cause=model   iter=1 att=1
seq 21-22 loop-decision cause=checkpoint iter=1 att=1
seq 23-24 result      cause=loop-decision
```

要点：**主链每一步都有 `causeOccurrenceId`，且与模板路径一一对应**；`context` 是唯一孤立项。事件流里 model 的 reason 序列为 `request(waiting) → response(running) → normal(succeeded)`（`workflowState.ts:183` 的 fold 会用新事件覆盖 reason，succeeded 后 reason='normal'）。

### 1.3 逐边实测结论（对照 `headerTemplate.ts:215-263` + `headerEdgeEvidence.ts` 逐帧推演）

| 模板边 | 960a 实测 | 机制 |
| --- | --- | --- |
| `submission → queue` | ✅ 亮 | queue.cause=submission，直接路径 |
| `queue → entry` | ✅ 亮 | input.cause=queue → 路径 `queue→entry→input`；**entry 是可穿越中继**（`headerEdgeEvidence.ts:111` 白名单 `['entry','approval-needed']`），不需要 entry 有 occurrence |
| `entry → input` | ✅ 亮 | 同上（v1 判 ❌，推翻） |
| `context → request`（supply） | ❌ 暗 | context 无 cause、无 anchor、且模板中无入边（visit 永远到不了 context）；现网也无任何 occurrence 的 cause 指向 context → 结构性死边 |
| `input → request` | ✅ 亮 | request.cause=input；`input→command` 分支被剪枝（command 非终点且不可穿越） |
| `request → model` | ✅ 亮 | model.cause=request |
| `model → response` | ✅ 亮 | 双通道：checkpoint 启动帧经 response-condition（`headerEdgeEvidence.ts:112-113`）点亮；seq19 anchor-added 后 `matchesHeaderNode('response')`（succeeded + message anchor）也满足 alias 分支（73-83） |
| `response → checkpoint` | ✅ **稳定亮** | 条件 = cause.kind='model' ∧ cause.status='succeeded' ∧ target.kind∈{checkpoint,tool-list}。checkpoint 一启动（seq18）即满足并持续到末帧。v1 的"只在 model running 那一帧亮、随后熄灭"**错误**（v1 把 headerState 的节点 slot 匹配条件误当成了边证据条件） |
| `checkpoint → decision` | ✅ 亮 | loop-decision.cause=checkpoint |
| `decision → entry` | ⚠️ 本 chat 不亮 | 仅当 input.cause=loop-decision（同 run 迭代≥2）时点亮；本 chat 两轮都是新 run（input.cause=queue）。cc193936 新代码 run 里实测存在 2 例 input←loop-decision，该边会亮 |
| `decision → result`（完成） | ✅ 亮 | result.cause=loop-decision |
| `decision → wait` / `wait → wake` / `wake → entry` | ❌ | 本 chat 无 waiting(answer/child) 与 wake 事实（wake 全库仅 1 例，且 runId=null） |
| `model → channels` / `resume → *` | ❌ 永久暗 | channels/resume 为 `kinds=[]`/不在中继白名单的结构节点，任何路径都无法穿越 |
| `result → 下一 run 的 submission` | ❌ 不存在 | 模板无此边（见 §2.2） |

**结论：960a 在 journal 回放路径下，单个 run 内主链 9 条边全部点亮**；暗边只有 `context:request` 与跨 run 边界（无连接边）。

### 1.4 跨 run 边界的实测行为

- 回放时 `currentRunId` 只取活跃 run（`graphModel.ts:257-259`），历史回放中为 undefined → scope 由 `runs.at(-1)` 决定（`headerState.ts:125`）。
- 回放推进到 run B 的第一个事件（seq25 submission）时，折叠帧里 runs=[A,B]，`runs.at(-1)` 翻转到 B；`headerEdgeEvidence.ts:26-32` 的 `participating` 过滤 `item.runId === scope.runId` → **run A 的全部边证据瞬间清空**，从 submission:queue 重新起链。
- 模板设计上新 turn 从 `submission→queue→entry→input` 进图，与上一 run 的 result/decision **没有任何连接边**——跨 run 的视觉断层是结构性的，不是数据缺失。

## 2. 与 v1 推断的逐条对照

### 2.1 v1 §2.5-(2) "decision→entry→input、wake→entry→input 永远不亮" — ❌ 推翻

`visit()` 允许路径穿过 entry/approval-needed 中继（`headerEdgeEvidence.ts:111`）。实测 `entry:input` 与 `queue:entry` 在两个 run 里都亮。真正需要 input.cause=loop-decision 才亮的只有 `decision:entry`。永久暗的中继边只有 `model:channels`、`resume:*`（不在白名单）与 `wake:entry`（本数据无 wake cause）。

### 2.2 v1 §2.5-(3) "response→checkpoint 只在 model running 帧瞬亮" — ❌ 推翻

边证据不走 headerState 的 slot 匹配，而走 `visit()` 的 response-condition（`headerEdgeEvidence.ts:112-113`）：只要 checkpoint 的 cause 是**已 succeeded 的 model** 即点亮并保留（`record()` 的 running-priority 规则只会阻止降级覆盖，不会移除已有证据）。实测从 checkpoint started 帧起持续亮到回放末帧。v1 附带的"需要放宽 `headerEdgeEvidence.ts:42-48`"这条约束随之作废——现有代码已满足"cursor 推过后保持点亮"。

### 2.3 v1 §2.5-(1) "context 孤立" — ✅ 确认并收紧

实测 context.cause=(none)、无 anchor、无入边，且全库（含 cc193936 232 条）没有任何 occurrence 的 cause 指向 context。`context:request` 在当前数据与 recorder 行为下不可能点亮。

### 2.4 v1 §1.2/§1.3 的事实链预测 — ❌ 大面积推翻

v1 预测"没有 request occurrence、submission:queue 不亮、entry:input 缺 cause"等，实测全部相反：recorder 在 12:30 这一版已写入完整因果链（submission/queue/input/request/model/checkpoint/loop-decision/result 全带 cause），48 事件全 exact、无 gap。

### 2.5 v1 §2.1-§2.3（对首轮报告的修正）— ✅ 维持

- §5.1（fact 路径缺 cause、无 evidence）仍成立，但注意 journal 路径的适用面比 v1 想的大：cc193936 这类"旧格式"会话**也在 journal 表里**，只是行内没有 `causeOccurrenceId`。
- §5.2（input←loop-decision 跨迭代有覆盖）被数据直接证实（cc193936 新代码 run 实测 2 例）。
- §5.3（legacyHeaderPredecessor 是显示层回退）成立，且其实际作用面比 v1 预期大得多——见 §3。

## 3. 关键新发现：cc193936 的数据断层（用户最初观察的会话）

对 cc193936（232 occurrences / 601 events）按 run 统计 `causeOccurrenceId` 完整度：

| 时间（2026-09-12） | run | occurrences | 带因果链 |
| --- | --- | --- | --- |
| 07:48 ~ 12:31 的全部 9 个 run | （含 4 迭代工具重度 run） | 208 | **0** |
| 12:31:20 起 | ab97bda9 / ba1d1569 | 24 | 24/27、5/7 |

即：**因果链写入能力是 2026-09-12 当天 10:52~12:30 之间的某次更新上线的**；960a 恰好是上线后的第一个会话，而用户观察回放问题的 cc193936 有 215/232 条 occurrence 没有因果链，回放只能依赖 `legacyHeaderPredecessor`（`headerLegacyPredecessor.ts`，显示层推断，从不改写 journal）。

用近似规则对旧 run 主链做可解析率统计（探针 `.tmp/probe-960a-4.cjs`）：

- `model`（要求同 attempt 有 request）、`loop-decision`（同 round 有 checkpoint）：**几乎 100% 可解析**；
- `request`（要求同 round 有 input/command/retry/compact-applied）：**重度失明**（如 run 5fb9ba2a 仅 1/4、run 61ecc097 0/4）——旧 recorder 不为迭代≥2 写 input occurrence，规则无米下锅；
- `checkpoint`（要求唯一 tool-result 共享 anchor，否则回退 model）：**工具重度 run 失明**（5fb9ba2a 2/4、61ecc097 3/4、ece0dc62 0/1）——多工具结果违反 exactly-1 约束；
- `input`（intake 分支要求唯一 queue 共享 message anchor）：旧 run 的 input 仅 4/12 带 anchor，多数失明。

**这就是"上一个节点亮、下一个节点亮、中间隔着很远的暗区"的直接成因**：边级证据是逐边判定的，request/checkpoint/input 的入边在旧数据上成片变暗，而它们下游的 model→request、checkpoint→decision 又靠各自推断亮起——视觉上链路断成数段。另：无 runId 的协作类 occurrence（wake、parent-receive）被 `participating` 的 runId 过滤排除在一切 run 视图之外，永不参与边证据。

## 4. 修正后的总结论（回答"当前数据能否串起整条链路"）

1. **能串起的**：2026-09-12 ~12:30 之后的新格式数据（960a 为证），单 run 内 `submission→queue→entry→input→request→model→response→checkpoint→loop-decision→result` 主链边全部有证据点亮；entry 中继由路径穿越机制补位，无需 occurrence。
2. **串不起的（数据层）**：旧格式数据（cc193936 的 215 条）缺 `causeOccurrenceId`，显示层推断对 request(迭代≥2)/checkpoint(多工具)/input(缺 anchor) 三类规则性失明。其中"迭代≥2 的 request 入边"是**数据缺失不可回放**：模板只允许 `input/command→request` 两条入边，缺 input occurrence 时任何推断都无法构造合法路径，不是投影层 bug。
3. **串不起的（结构层，与数据新旧无关）**：`context:request`（context 永远孤立）、`model:channels`、`resume:*`（不可穿越）、跨 run 边界（result 与下一 run 的 submission 之间无模板边，且回放 scope 切换会清空上一 run 证据）。
4. v1 的两条"新约束"中，"不要为 unobserved 节点写 occurrence"继续有效；"放宽 running-priority 以保持 response→checkpoint 点亮"作废（实测已满足）。

## 5. 若要改进（均需先进 T07 流程登记，本文只记录）

- **旧会话回放体验**：不可回填因果（数据不存在）；可选方向是接受断链现状并在 UI 上把"不可判定"与"未发生"区分开（`coverage` 文案已有基础）。
- **context:request**：唯一正路是 recorder 在 request 创建时把 cause 指向 context occurrence（契约行为变化），或模板降级 context 为注记节点。
- **跨 run 视觉桥**：要么在模板加一条 `result→submission` 语义边（新输入），要么明确两 run 是独立链的设计口径并在文档写死。
- **协议同步**：若改 recorder cause 指向，需同步 `docs/shared` 的 workflow 契约与 `docs/frontend/runtime-diagram.md` 的证据承诺描述。
