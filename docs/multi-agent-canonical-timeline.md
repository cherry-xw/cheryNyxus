# 多 Agent 权威时间线实施方案

> **文档状态：当前实现规范（权威）**。本文件是协议和前端实现的唯一落实文档；后续代码变更必须先更新本文件，再同步代码和测试。若与旧协议说明冲突，以本文件和实际代码为准。

> **目标**：后端保留每个 agent 独立的原始会话历史，同时向前端提供可恢复、可分页、可实时增量更新的根会话时间线。前端不再推断消息属于主 agent、子 agent 或工具，也不负责合并子会话、回传消息或工具结果。
>
> **与 Chat Protocol V2 的关系**：本文细化 `chat.timeline.get` / `timeline.patch` 的多 Agent 语义；仍遵循 Command、Timeline、Session 三平面边界。

## 1. 结论与边界

采用“**原始分会话事实 + 后端 canonical projection + 前端纯展示**”的模式。

```text
messages / chats / spawn edges / wake records       (后端事实层)
                         │
                         ▼
              RootTimelineProjector                (后端投影层)
                         │
                         ▼
      chat.timeline.get(rootChatId, view)           (权威快照)
      timeline.patch(rootChatId, revision, ops)     (已提交增量)
                         │
                         ▼
      前端 TimelineStore + 列表/树/单聊渲染          (无业务推断)
```

后端**不需要**把子 agent 消息复制进主 chat 的 `messages` 表。每条原始消息仍归属其实际 `chat_id`；跨 agent 的关系由专门的因果记录表达，projection 按根会话读取整棵 chat 树并形成展示节点。

前端可以把同一份 canonical timeline 显示为：

- 群聊式完整对话列表；
- 按 `parentNodeId` 展开的调用树；
- 某个子 agent 的 1:1 视图；
- 工具调用折叠详情。

前端不得自行根据 `role=assistant`、文本前缀或时间邻近关系猜测 agent 身份、消息方向、工具归属、子任务回传关系。

## 2. 事实模型

### 2.1 原始消息保持单 agent 归属

现有 `messages` 表继续作为 LLM 上下文和审计事实来源：

```ts
interface RawMessage {
  id: string
  chatId: string
  role: 'user' | 'assistant' | 'sense' | 'system' | 'role'
  content: string
  thinking?: string
  senseCalls?: RawSenseCall[]
  createdAt: number
  revoked: boolean
}
```

其中 `sense` 是工具执行的原始结果，不是用户可见对话行；`role` 是父 agent 注入的子任务回传，不得仅靠其文本内容识别来源。

### 2.2 新增消息因果表

新增 `message_links`（或等价 JSON 元数据，但推荐独立表，便于索引和约束）：

```sql
CREATE TABLE message_links (
  message_id TEXT PRIMARY KEY REFERENCES messages(id),
  root_chat_id TEXT NOT NULL REFERENCES chats(id),
  source_chat_id TEXT NOT NULL REFERENCES chats(id),
  parent_chat_id TEXT REFERENCES chats(id),
  spawn_id TEXT REFERENCES spawn_tasks(task_id),
  spawn_call_id TEXT,
  related_message_id TEXT REFERENCES messages(id),
  relation TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_message_links_root_time
  ON message_links(root_chat_id, created_at, message_id);
CREATE INDEX idx_message_links_spawn
  ON message_links(spawn_id, relation);
```

`relation` 枚举：

| 值              | 表示                                 |
| --------------- | ------------------------------------ |
| `root_input`    | 真人输入主会话                       |
| `agent_output`  | agent 正常输出                       |
| `tool_result`   | 工具原始结果，仅供归并               |
| `spawn_request` | 父 agent 派发子任务                  |
| `child_input`   | 父 agent 向子 agent 发送的任务输入   |
| `child_output`  | 子 agent 在自身会话的输出            |
| `child_return`  | 子 agent 回传给父 agent 的持久化注入 |
| `system`        | 系统消息，不默认显示                 |

写入约束：

1. 创建 child chat / spawn task 时，在同一事务确定 `root_chat_id`、`parent_chat_id`、`spawn_id`、`spawn_call_id`。
2. 子 chat 的 user 输入写入 `child_input`，并关联对应的 `spawn_id`。
3. 子 chat 的 assistant 输出写入 `child_output`。
4. `wakeParent` 写父 chat 的 `role` 消息时，必须写 `child_return`，关联 `source_chat_id`、`spawn_id` 和源 child 输出 `related_message_id`。
5. 工具结果关联其所属 assistant message / sense call；不得作为独立默认可见节点。

这样刷新后仍能精确知道“谁发给谁”“这条回传来自哪个子 agent”“某个工具结果属于哪次调用”。

## 3. Canonical Timeline 契约

### 3.1 节点而非裸消息

替换仅带 `role/content` 的 `CanonicalMessage`，使用面向展示、但仍可审计的 `TimelineNode`：

```ts
type Actor =
  | { kind: 'user'; actorId: 'human'; displayName?: string }
  | { kind: 'agent'; chatId: string; roleType?: string; avatarKey?: string }
  | { kind: 'tool'; toolName: string }
  | { kind: 'system' }

type Direction =
  'user-to-agent' | 'agent-to-user' | 'parent-to-child' | 'child-to-parent' | 'internal'

type TimelineNode = {
  id: string
  rootChatId: string
  sourceChatId: string
  sourceMessageId?: string
  kind: 'message' | 'tool-batch' | 'return' | 'dispatch' | 'system'
  actor: Actor
  target?: Actor
  direction: Direction
  visibility: 'conversation' | 'detail' | 'internal'
  content: string
  thinking?: string
  toolCalls?: GraphToolCall[]
  orderKey: number
  termination?: Termination
  createdAt: number
  updatedAt: number
  status: 'committed' | 'revoked'
}
```

关键语义：

- 主 agent 输出：`actor.kind='agent'`，`actor.chatId=rootChatId`，`direction='agent-to-user'`。
- 子 agent 输入：`actor=父 agent`，`target=子 agent`，`direction='parent-to-child'`。
- 子 agent 输出：`actor=子 agent`，`direction='agent-to-user'`；群聊视图也可按 `child-to-parent` 展示其回传节点。
- 子 agent 回传：`kind='return'`，`actor=子 agent`，`target=父 agent`，`direction='child-to-parent'`。
- 工具结果：作为所属 assistant 节点的 `toolCalls[].result`；只有 `view='audit'` 时才产生独立 `tool-group` 节点。

头像、角色名、方向徽章都只从 `actor/target/direction` 读取。UI 不应根据 `sourceChatId === rootChatId` 等规则自行判断。

### 3.2 查询 API

```ts
chat.timeline.get({
  rootChatId: string,
  view: 'conversation' | 'tree' | 'audit',
  before?: Cursor,
  limit?: number,
  knownRevision?: number
})
```

返回：

```ts
interface RootTimelineSnapshot {
  rootChatId: string
  view: 'conversation' | 'tree' | 'audit'
  revision: number
  nodes: TimelineNode[]
  edges: ExecutionEdgeFact[]
  activeRuns: ActiveRunFact[]
  pendingInputs: PendingInputSnapshot[]
  nextCursor?: Cursor
  capturedEventSeq: number
}
```

`conversation` 默认只返回 `visibility='conversation'` 的用户、agent、派发、回传节点；`tree` 与 `audit` 同时携带完整 graph facts，`audit` 可展开系统和工具详情。持久排序键为 `orderKey`；分页 cursor 的兼容展示键仍可包含 `(created_at,id)`，但不得用于推断因果。

### 3.3 原子订阅与增量

目标架构中的 `chat.open` 应以根会话订阅整棵树：

```ts
chat.open({
  rootChatId: string,
  knownRevision?: number,
  knownEventSeq?: number
})
```

服务端必须在一个原子边界中完成：

1. 注册 root-tree subscription；
2. 读取当前所有后代 chat 集合和 `eventSeq` 边界；
3. 读取 root timeline revision；
4. 返回 snapshot fence；
5. 将边界之后来自任何后代 chat 的事件缓冲并随后按 root `eventSeq` 推送。

已持久化的变化仅通过 root 维度的 patch 发给客户端：

```ts
timeline.patch({
  rootChatId,
  baseRevision,
  revision,
  operations: Array<
    | { type: 'upsert'; node: TimelineNode }
    | { type: 'remove'; nodeId: string }
    | { type: 'upsert-edge'; edge: ExecutionEdgeFact }
    | { type: 'remove-edge'; edgeId: string }
    | { type: 'upsert-run'; run: ActiveRunFact }
    | { type: 'remove-run'; chatId: string; runId: string }
    | { type: 'upsert-input'; input: PendingInputSnapshot }
    | { type: 'remove-input'; inputId: string }
    | { type: 'revoke'; nodeId: string }
  >,
})
```

目标架构中，任何涉及 child chat 的消息、工具结果、派发或回传，只要已提交，均递增**根会话** revision 并发出 root patch；前端无需对每个 child 建立独立 timeline 订阅。

CP2 实施契约：root-tree subscription 与 root graph patch 作为 canonical 实时链路；兼容期 per-chat subscription 仅服务旧展示路径，不再作为 HistoryDrawer root/group 视图的事实源。root open 在同一 fence 返回 nodes、edges、按来源 chat 标识的 pending input、active turn 与 active run；前端以 `(rootChatId, view)` 隔离并原子安装快照。

### 3.4 实时 Session 事件

实时打字机仍是 Session Plane，不进入持久 timeline：

```ts
turn.started({ rootChatId, sourceChatId, turnId, messageId, actor, createdAt })
turn.delta({ rootChatId, sourceChatId, turnId, messageId, channel, offset, delta })
turn.completed({ rootChatId, sourceChatId, turnId, messageId })
```

前端按 `messageId` 建立 transient node，使用 event 的 `actor` 渲染正确的子 agent 头像。数据库提交后收到 `timeline.patch`，用同一 `sourceMessageId/messageId` 原子替换 transient node；禁止同时把 transient 和 committed 节点显示为两条消息。

每个 `messageId` 都拥有独立的实时 CRT 生命周期，而不是由 `chatId` 或 `runId` 共享一台 CRT：

1. `turn.started(A)` 建立节点 A，并打开仅属于 A 的 CRT；后续 `turn.delta(A)` 只更新该 CRT。
2. assistant A 的完整节点事实提交后，服务端立即发送 `turn.completed(A)`；前端关闭 CRT-A，保留实际节点 A，详情改由 hover popover 展示。
3. 同一 run 后续出现 `turn.started(B)` 时创建 CRT-B，不复用 CRT-A 的组件身份、隐藏状态或固定状态。run 结束只补全尚未完成的 turn，不重复完成 A。
4. 不同 child chat 的 active turn 可以并发存在，因此多个节点 CRT 可以同时显示；其中任一 turn 完成不得关闭其他节点的 CRT。

审批/提问弹窗属于节点交互状态，不属于 CRT 生命周期。待审批节点即使启用默认折叠也保持展开，交互弹窗持续显示到用户完成操作；对应流结束只关闭该节点 CRT，不提前关闭审批弹窗。

节点树历史读取不得调用 `chat.sync` 重播已完成 turn 的 delta。`turn.delta` 只服务当前打开的 root subscription；已完成历史只由 `RootTimelineSnapshot.nodes/edges` 返回完整节点。切换 root 时关闭旧 subscription 仅表示停止观察，绝不隐含 pause/abort；旧 root 的 Agent、输入队列和子 Agent 在后台继续运行。

刷新中断后，不保证恢复“已经错过的逐 token 动画”；正确行为是 `chat.open` 返回 active turn 的当前累计文本，随后继续接收新的 delta。最终内容始终以 timeline snapshot/patch 为准。

## 4. Projection 规则

`RootTimelineProjector(rootChatId, view)` 的职责如下：

1. 读取 root chat 与全部递归后代，不以“当前已渲染 pet”决定范围。
2. 读取这些 chat 的消息、`message_links`、spawn task 和角色元数据。
3. 以 `message_links` 建因果图，而不是按文本或时间猜测配对。
4. 归并工具结果：assistant 的 `senseCalls` 与 `tool_result` 关联，生成一个 assistant node 的 `toolCalls`；默认过滤原始 `sense` 节点。
5. 将 child 的输入、输出、回传转换为明确的 actor/target/direction。
6. 对 `revoked`、替换、审批拒绝生成相应 node status，而不改变历史 node ID。
7. 稳定排序：首先按业务发生时间，其次按因果拓扑，再按 node ID；同一事务内不得依赖 SQLite 返回顺序。

特别规则：父 chat 中的 `child_return` 与 child chat 中的最终 `child_output` 是同一业务结果的两个事实，不得在前端根据正文相等来去重。projection 使用 `related_message_id/spawn_id` 显式合并：

- `conversation`：显示一个 `return` 节点；
- `tree`：显示 child output，并把 return 标记为该输出到父 agent 的边；
- `audit`：两个事实都可见，互相引用。

## 5. 前端实现

### 5.1 一个根会话一个 TimelineStore

替代当前“主 chat 与每个 child chat 分别 hydrate，再由 selector 拼接”的方式：

```ts
interface RootTimelineState {
  rootChatId: string
  revision?: number
  eventSeq?: number
  nodesById: Record<string, TimelineNode>
  nodeOrder: string[]
  transientTurns: Record<string, ActiveTurnNode>
  loaded: boolean
  resyncRequired: boolean
}
```

Reducer 只做四件事：安装快照、应用 revision patch、按 offset 累积 turn delta、在序号/版本缺口时重开 root subscription。它不读取 `agents.pets` 来推导消息关系。

### 5.2 纯展示映射

`MessageBubble` 的输入改为 `TimelineNode`：

- 头像取 `node.actor.avatarKey` 或 `actor.chatId` 对应的 catalog 元数据；
- “主→子”“子→主”取 `direction`；
- 子 agent 名称取 `actor.roleType`；
- 工具区取 `node.toolCalls`；
- 树形缩进取 `parentNodeId`。

若角色头像资源尚由 `agents.pets` 管理，可把它作为 `chatId -> avatar` 的只读 catalog；绝不能反向影响 timeline 节点的角色语义。

### 5.3 刷新与缺口处理

目标架构的刷新只执行一次 `chat.open(rootChatId)`，然后按返回 revision 拉取 `chat.timeline.get(rootChatId)`。首页只读取轻量 catalog，不为所有 running root 自动 hydration；用户打开或切换到某个 root 时才建立该 root subscription。后续：

- `eventSeq` 断档：重新 `chat.open(rootChatId)`；
- `baseRevision` 不匹配：重新 `chat.timeline.get(rootChatId)`；
- 订阅重连：用最后已确认的 root `eventSeq/revision` 打开同一 root；
- 新 spawn：其 child 自动属于 root subscription，前端不额外 `attach/open` child。
- 切换/关闭树：`chat.close(subscriptionId)` 只取消观察与重输出路由，后台 run 保持不变；只有显式 `chat.abort` 可以终止。

### 5.4 Nyxus 前端三层边界

Nyxus 实时树固定采用以下单向依赖，组件挂载不能直接拥有 WebSocket 订阅生命周期：

1. **后端 API / LLM 层**输出完整节点事实、父子关系、持久 revision，以及运行期
   `input.updated` / `turn.started` / `turn.delta` / `turn.completed` / 审批事件。历史接口只返回
   完整节点；逐 token delta 只服务当前运行中的 CRT，不作为历史回放单元。
2. **前端消息层**为每个被观察的 `rootChatId` 维护唯一 subscription。`conversation`、`tree`、
   `audit` 是同一订阅下的只读快照视图，不能分别调用 `chat.open`。消息层原子合并 snapshot、
   patch 和 transient event，并向 UI 暴露只读渲染状态。
3. **UI 投影层**只消费节点事实与实时 turn 状态，自行完成树布局、分支、折叠、CRT、悬浮详情和
   审批弹窗。节点组件不得调用 `chat.open`、持有 `subscriptionId` 或根据协议序号触发重同步。

同一个 root 的视图并发加载必须先共享一次 subscription single-flight，再分别加载缺失快照；旧的
异步 open 响应不得覆盖较新的观察代次。已经由 root reducer 应用成功的 `timeline.patch` 不再通过
session 兼容路径反向触发 `chat.open` 或快照刷新。

兼容期消息层必须向 UI 暴露一份统一的 live view：root subscription 的 transient turn/run 为
权威值；若某个当前 root 会话族的实时事件已经进入 per-chat session、但对应 root transient
尚未安装或在订阅交接窗口暂时缺失，则以该 session 的同一 `chatId + runId + messageId` 状态
补位。补位只作用于当前运行态，不读取历史 delta、不建立额外订阅，也不触发同步。节点瞬态投影
与 CRT 必须消费同一份合并结果，禁止 CRT 单独把空 root transient 数组当成“没有实时响应”。

Root subscription envelope 只能由 root reducer 消费其顺序游标和运行态。即使 envelope 同时携带
`sourceEventSeq`，前端也不得再把它送入 per-chat sequenced reducer；root snapshot 并不提供每个后代
chat 的 per-chat cursor fence，这样做会把正常 source 序号误判为缺口并错误触发 direct
`chat.open(chatId)`。普通 direct subscription 的事件仍由 per-chat reducer 独占处理。

服务端同样隔离两类订阅的所有权：建立 direct subscription 只能替换相同 chat 的旧 direct
subscription，不能删除同连接上的 root subscription。事件路由同时匹配两者时，root envelope 保持
权威并抑制重复 direct envelope。

## 6. 迁移步骤

### Phase 1：建立可审计关联

1. 增加 `message_links` 及迁移脚本。
2. 修改 spawn、child 输入、observer、wake 写入路径，确保新数据完整写 link。
3. 为旧数据提供 best-effort backfill：由 `parent_chat_id`、spawn metadata 和已知 `spawnSenseCallId` 补充；无法可靠关联的记录标记 `relation='legacy_unknown'`，不伪造关系。

### Phase 2：实现只读 projector（implemented）

1. 实现 `RootTimelineProjector` 和单元测试。
2. 扩展现有 `chat.timeline.get`，接受 `rootChatId` 与 `view` 并返回 `rootTimeline`（不另造 `chat.rootTimeline.get` RPC）。
3. 对比旧 UI 与新 projection：工具不独立冒泡、child 消息头像正确、回传不重复。

### Phase 3：root 订阅（in progress）

1. root 维度 event journal 和 revision；
2. `chat.open(rootChatId)` 原子 fence；
3. 子 chat 的 turn / tool / spawn / return 统一路由至 root subscription；
4. 验证刷新中 child 正在输出时可恢复当前文本并继续打字。

### Phase 4：前端切换（partially implemented）

1. 新建 RootTimelineStore 和 `TimelineNode` renderer；
2. HistoryDrawer、Pet 气泡、树视图切到该 store；
3. 删除 V2-to-legacy `StreamState` 展示桥和前端 `mergeChildReplyHistory` 业务去重；
4. 旧 `chat.get/chat.sync/chat.attach` 仅保留兼容期，之后移除。

## 7. 验收标准

必须覆盖以下端到端场景：

1. 主 agent 连续输入，历史只出现一次用户消息和一次最终 assistant 节点。
2. 主 agent 调工具，工具结果只在该 assistant 节点的工具详情中出现，不产生独立气泡。
3. 主 agent 派发子 agent，列表实时显示 `parent-to-child`；子输出使用子头像。
4. 子 agent 刷新页面期间持续输出；刷新后能显示当前累计文本和后续 delta，最终转 ghost 不丢消息。
5. 子 agent 回传主 agent，只显示一个 `child-to-parent` 结果节点，且刷新前后 avatar/方向一致。
6. 多层子 agent，头像和 caller 徽章按 `actor/target` 正确区分。
7. timeline patch 或 eventSeq 断档时自动全量重取，不能混入重复/错序节点。
8. 服务重启后，持久化的输入队列、child task、已提交 timeline 与因果关系可完整恢复。

## 8. 反模式

- 前端拉取 root + 全部 child 后按时间排序、正文匹配来合并。
- 用 `role='assistant'` 直接决定主 agent 头像。
- 将 `sense` 原始结果直接映射为普通 assistant 气泡。
- 用 `requestId` 或 WebSocket 连接 ID 作为跨刷新消息关联。
- 对每个动态新 child 独立建立前端订阅并让 UI 自行维护订阅树。
- 仅在实时 `role_reply` 事件中携带 child 身份，而不在数据库/快照中持久化该关联。

## 9. 当前实现状态

本轮已落地：

- `message_links` schema、索引、消息写入与 child-return 持久化；
- root timeline revision 随后代消息提交同步推进；
- `TimelineNode` 类型与后端 `buildRootTimeline()` projector；
- `chat.timeline.get({ rootChatId, view })` root projection 查询；
- 前端 root timeline snapshot 缓存、历史抽屉接入和 actor/direction 到头像样式的展示映射；
- 旧数据按 chat 层级懒回填，无法唯一判断的 role return 不伪造关联；
- root projector 的 actor/direction 回归测试。

前端落地范围：

- `agentApi.getRootTimeline()` 调用 `chat.timeline.get({ rootChatId, view })`，并缓存 `RootTimelineSnapshot`；`HistoryDrawerPanel` 的 group 视图直接把 `TimelineNode` 映射为旧气泡所需的展示字段。
- actor、target、direction、causationId 决定子 agent 头像、主→子/子→主样式和工具详情；前端不再用正文匹配来判断来源。
- transient pending input/active turn 仍由 ChatSession reducer 管理，并在 canonical message 到达时按稳定 `messageId` 去重/替换；这部分属于 Session Plane，不写入 root 历史节点。
- 当前 root 查询返回完整快照；`before/limit/nextCursor` 的 root 分页契约虽已写入目标接口，但后端尚未启用，暂不应依赖其分页行为。

兼容说明与未完成项：

- 每个后代 chat 事件同步写入 `soul.db.root_events`。`chat.open({rootChatId})` 以 root eventSeq 建立原子订阅栅栏，覆盖当前和未来后代；direct 视图仍保留每-chat subscription 兼容路径。
- `timeline.patch` 保留单 chat `CanonicalMessage` 操作以兼容 direct 视图，并同时携带 root `TimelineNode` patch。RootTimelineStore 直接应用 root patch；revision 不连续时重取 root snapshot。
- Pet 实时气泡及部分审批/问题组件仍保留 ChatSession/legacy agents store 兼容桥；这不改变 root snapshot 的权威性，但意味着“所有 UI 只读 RootTimelineStore”尚未完成。
- 旧数据回填当前采用按 chat 层级懒回填；无法唯一匹配的旧 role 行保持未关联，不会写入虚假的 `legacy_unknown` 关系。

## 10. 文档先行与版本维护

本方案与代码必须同步演进，执行以下规则：

1. 修改协议字段/API、数据库关系、projector、WebSocket 事件、前端 store/reducer、selector 或 UI 映射前，先更新本文件及相关协议文档，标注 `planned/in_progress/implemented/deferred`。
2. 代码完成后立即回写实际行为、兼容期路径、测试证据和未完成限制；禁止把目标架构误写成当前能力。
3. 若发现文档与代码冲突，暂停后续代码开发，先修正文档并重新确认边界。
4. 每个新增字段/API 都要同时补充请求/响应示例、因果关系和验收场景；删除或延期项必须留下迁移说明。
