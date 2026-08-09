# Nexus 节点树重构：现状审计与实施计划

## 1. 结论

当前实现只能视为交互原型，不能继续按“CP2 已完成”向后叠加功能。问题的核心不是 SVG 少画几条线，而是 canonical timeline 尚未提供足以无歧义构造执行图的节点与边。

本轮重构采用以下边界：

- 保留已经可用的 root subscription、root event journal、历史抽屉数据读取、输入框业务能力和曲线脉冲组件。
- 重新定义 root execution graph 的事实协议；历史抽屉继续消费 timeline，节点树消费相同快照中的显式 graph facts。
- `executionGraph.ts`、`executionLayout.ts` 和当前精简后的 `MessageBranchTree.vue` 均按原型处理，可以重写，不背负兼容包袱。
- 每个 checkpoint 完成后停止开发，由用户实际运行验收；只有明确确认后才进入下一阶段。

原需求第 4 点“发送消息只能从暂停节点出发”已经废弃。保持现有队列语义：主 agent 运行中仍可发送，输入先进入 pending，loop 消费后实体化。

## 2. 当前实现审计

### 2.1 数据与拓扑

1. 主 agent 到子 agent 的边必然丢失。后端 `buildRootTimeline()` 把 `message_links.spawnId` 写入 `TimelineNode.parentNodeId`，这个值是 spawn 工具调用 ID；前端却只在它能命中 `TimelineNode.id` 时建边。两种 ID 空间不一致。
2. 子 agent 回主 agent 的关系不完整。`causationId` 有时是相关消息 ID，但当前投影没有完整表达“子末端 → return → 父分支继续节点”。
3. spawn 后的主线 continue 边不存在。当前仅按同 chat 时间顺序连线，不能表达一个 spawn 节点同时扇出子 agent 并继续主线。
4. `TimelineNode.kind` 虽声明 `tool-group`、`spawn`，tree/conversation 快照通常仍只生成 message/return；工具调用嵌在 assistant message 中，spawn 没有稳定图节点。
5. 当前 `ExecutionGraph` 只有 start/message/return/system/input，缺少 tool-batch、spawn、dispatch、termination、fold anchor 和 active CRT anchor；边也缺少 spawn、continue、dispatch、merge/return-continuation。
6. 跨 agent 关系不能靠相邻时间、正文、角色名称或 chat 顺序推断。刷新、并发、多层 spawn 时这些启发式规则都会不稳定。
7. `createdAt + id` 只能给出显示排序，不能完整表示同毫秒内的服务端因果顺序。需要 root 级单调 `orderKey/eventSeq`。

### 2.2 虚拟输入

1. 当前 draft 由 hover 布尔值临时插入，pointer leave 后可能立即销毁，无法稳定承载 composer 的焦点和点击过程。
2. pending 节点使用 `inputId`，实体消息使用 `messageId`，没有建立稳定的视觉身份接替。
3. 当前 draft `foreignObject` 已位于带 `translate(node.x,node.y)` 的 `<g>` 内部，却再次使用 `node.x/node.y`，产生双重偏移。
4. 关闭草稿、发送失败、排队、被 loop claim、提交、取消和重连恢复尚未形成明确状态机。
5. 现在只按时间把虚拟输入接到主 chat 的末尾，尚未保证它始终是主线唯一终点，也未处理 spawn/return 后真正的主线终点。

### 2.3 布局、画布与视觉

1. 当前视觉已经接近 `icon + name`，但仍残留卡片时代尺寸；running dot 仍绘制在 `(65,-22)`，不在 icon 附近。
2. SVG 使用内容宽高并对 SVG 元素做 CSS transform，尚未建立明确的“全页面 viewport + 独立 world layer”坐标模型。节点弹窗、`foreignObject`、CRT 和屏幕碰撞因此难以统一。
3. pan 开始没有 `preventDefault()`，画板也没有 `user-select:none`，拖动画布会选中文字；输入编辑区又需要单独恢复 `user-select:text`。
4. 当前 root chat 固定中央 lane、子 chat 左右按数量分配只是初版。它没有依据真实 spawn 树做子树整体排布，也没有处理多层子树、跨侧连线、节点弹窗占位和稳定重排。
5. 全局时间向下的要求已粗略实现，但开始节点使用负无穷时间、虚拟输入使用本地补时；它们需要独立的排序规则，不能混入持久事件时间。
6. hover 命中目前挂在整个节点 `<g>`，拖拽、点击和 hover 输入可能冲突；也没有 click-after-drag 抑制。
7. 曲线脉冲组件已存在，可复用；但路径方向、spawn 扇出、return 汇入、活动边判定都受错误拓扑影响。

### 2.4 工具、Fold、暂停与 CRT

1. 多工具 tabs 尚未接入节点树；单工具去 tabs、多工具保持服务端顺序尚未实现。
2. Fold 尚未实现。默认折叠、active 自动展开、结束后自动归并、手动固定展开和重新折叠都缺少状态模型。
3. 全局暂停按钮仍可用，但结构化 termination 没有完整进入 timeline；“用户手动截断”“系统停止”“watchdog/error”“agent redirect”无法可靠刷新恢复。
4. `stop_child` / `send_to_child` 及 running/paused child 的状态转换和持久边尚未实现。
5. 独立 CRT 堆栈虽然从当前模板移除，但 CRT 尚未锚定 running 节点；“合并”目前只是隐藏旧 UI，不是完成新交互。
6. 钢琴弹窗已具备拖动和收缩原型，分割线已隐藏，但层级、拖动边界、持久位置、树手势隔离尚未完整验收。
7. 历史抽屉曾被输入框遮挡，说明 overlay/z-index 尚无统一层级契约。

### 2.5 工程状态

- CP1 的 root timeline 基础设施可以保留，但协议内容仍需在新 CP1B 补齐。
- 旧计划把 CP2 标为“已实现，等待验收”不准确，现回退为未验收原型。
- 当前工作区包含大量既有改动，后续不得 reset 或覆盖无关变更；每阶段只改自己的文件，并保留可独立回退的提交边界。
- 现有测试只证明简单显式 `causationId` 示例和基础左右 lane；没有覆盖真实 `spawnId`、多 spawn、return/continue、pending 身份接替或全屏坐标。

## 3. 对最初需求的逐项状态

| # | 要求 | 当前状态 | 需要补齐 |
|---|---|---|---|
| 1 | 虚拟输入节点，消费后原位实体化 | 临时原型 | 稳定 ID 状态机、唯一主线终点、悬浮框生命周期 |
| 2 | 默认开始节点 | 已有原型 | 纳入统一 icon skin 和正式排序/连线规则 |
| 3 | 点击开始创建“我”，关闭删除 | 部分实现 | draft 实例、关闭/失焦规则、键盘可达性 |
| 4 | 仅暂停节点可发送 | 已废弃 | 保持运行中排队 |
| 5 | 一次响应多工具 tabs | 未实现 | tool batch 与顺序字段 |
| 6 | spawn 为分叉节点 | 未实现 | 稳定 spawn/tool-batch 节点 |
| 7 | spawn 同连主线与多个子线 | 未实现且协议缺失 | 显式 spawn/continue 边 |
| 8 | icon 可替换皮肤层 | 有基础 registry | 语义 key、fallback、状态叠层 |
| 9 | 时间晚的节点一定在下方 | 粗略实现 | root orderKey、虚拟节点独立排序、展开 Fold 校验 |
| 10 | Fold、书签 label、tabs | 未实现 | 完整 fold 投影与交互状态 |
| 11 | 全局暂停与截断尾注 | 部分控制 UI | termination 持久事实和恢复 |
| 12 | 主 agent 向子 agent 发消息/恢复暂停子 | 未实现 | 工具协议、状态机、dispatch 边 |
| 13 | 用户变更需求由主 agent 重定向子 agent | 未实现 | 权限约束与 stop/redispatch 事务 |
| 14 | 用户只能在主线输入 | 原型中默认如此 | 在命令层和 UI 层双重约束 |
| 15 | 主线居中，子树两侧平衡 | 初版 lane | 基于真实 spawn 子树的稳定布局 |
| 16 | CRT 合并进节点树 | 未实现 | running node anchor、避碰、层级 |

后续修订状态：全页面画板、仅 icon+name、icon-to-icon 曲线脉冲、整图 pan/zoom、钢琴可拖动/收缩、隐藏分割线均已出现原型，但尚未作为一个完整 checkpoint 验收；active 工具节点保持展开、结束后默认 fold 尚未实现。

## 4. 新的 canonical graph contract

### 4.1 单一快照，两类消费

`RootTimelineSnapshot` 继续是同一事实源，但明确分成：

- `nodes`：历史抽屉和节点详情使用的持久事件。
- `edges`：节点树使用的持久因果关系，禁止前端猜测跨 agent 边。
- `activeRuns`：当前流式节点、run/turn/tool batch 状态。
- `pendingInputs`：命令面输入状态；可随 root open/recovery 一并恢复。

历史抽屉不必显示每条 graph edge；节点树也不直接复用抽屉 DOM。两者复用同一 store 和稳定 ID，而不是互相抓取展示数据。

### 4.2 持久节点

至少定义以下语义节点：

- `message`：用户或 agent 可见消息。
- `tool-batch`：一次 assistant 响应中的有序工具调用批次；稳定 ID 由服务端给出。
- `return`：子 agent 向父 agent 的持久回传。
- `dispatch`：父 agent 向已存在子 agent 的定向任务。
- `system`：审批、提问或其他必须中断 Fold 的系统事件。

spawn 是 `tool-batch` 的能力标记；只要批次内含 spawn call，该批次即为分叉节点。每个调用必须包含稳定 `callId`、`index`、`name`、`status`、`childChatId?`、`targetChatId?` 和结果。若服务端选择单独生成 `spawn` 节点，也必须保留 batch/call 的显式归属，不能再混用 call ID 与 timeline node ID。

以下是 UI 投影节点，不持久化：

- `start:<rootChatId>`：象征性根节点。
- draft/pending input：主线终点输入状态。
- `fold:<firstBatchId>:<lastBatchId>`：连续已结束工具批次的折叠投影。

termination 是目标节点/turn 的结构化注记，不篡改原始 content：

```ts
type Termination = {
  actor: 'user' | 'system' | 'agent'
  code: 'user_abort' | 'system_stop' | 'watchdog' | 'error' | 'agent_redirect'
  at: number
  detail?: string
}
```

### 4.3 持久边

每条边由服务端分配稳定 ID，并至少包含 `fromNodeId`、`toNodeId`、`kind`、`orderKey`：

- `sequence`：同一 agent 分支的执行顺序。
- `spawn`：spawn/tool-batch → 每个子 agent 起始节点。
- `continue`：spawn/tool-batch → 后续父分支节点；后续节点出现前允许该边暂不存在。
- `dispatch`：父 agent dispatch → 已存在子 agent 的新 turn 起点。
- `return`：子分支末端 → return 节点。
- `return-continuation`：return 节点 → 父分支消费该结果后的节点。

不再使用语义含混的 `parentNodeId` 同时承载 call ID 和 node ID。迁移期需要建立显式 `toolCallId -> owningNodeId` 索引，仅用于旧数据 backfill；新数据直接写正确节点和边。

### 4.4 稳定顺序

所有持久节点和边使用服务端 root 级单调 `orderKey`。布局按 `orderKey` 排列；`createdAt` 只显示时间，不承担并发因果排序。开始节点固定在第一行，draft/pending 固定在当前主线最后，展开 Fold 后的子节点仍使用其原始 orderKey。

## 5. 关键交互状态机

### 5.1 主线输入

```text
endpoint idle
  -> hover/focus: draft visible
  -> click: draft editing
  -> close/Escape with unsent draft: draft removed, endpoint idle
  -> submit accepted: pending(messageId 已预分配，虚化)
  -> loop claimed: consuming(原位，仍可显示虚化过渡)
  -> message committed: entity(沿用 messageId 和坐标锚点)
  -> 新 endpoint idle 出现在其后
```

提交失败回到 editing 并保留正文；cancelled/rejected 节点显示短暂错误后从事实树移除或按产品策略保留，不得伪装成已提交消息。hover 只控制 preview，editing 由显式状态控制，pointer leave 不关闭已激活输入。

### 5.2 工具与 Fold

- 连续两个及以上、同一 agent、已终止的 tool batch 默认投影为一个 fold。
- 用户消息、agent 可见消息、spawn、dispatch、return、审批、提问、termination 或 agent 切换都会切断 fold 区间。
- 任一 batch 为 active 时，它所在区间自动展开；当前响应节点始终可见。
- 区间全部结束后自动折回，除非用户显式固定展开。
- fold 的排序和锚点使用第一个子节点；展开不改变任何节点的纵向相对顺序。
- 单工具详情无 tabs；两个及以上调用按 `index` 显示 tabs。fold 详情把所有子 batch/call 按 `(batch orderKey, call index)` 展平。

### 5.3 暂停与子 agent 重定向

- 全局暂停对每个受影响 active turn 写入 termination，保留 partial content、thinking 和已经返回的工具结果。
- 用户只向主线提交需求变化。
- 主 agent 通过持久 `stop_child` 和 `send_to_child`/dispatch 操作选择目标子 agent。
- running 子 agent：任务进入其队列；paused 子 agent：创建新 turn 并恢复；finished 子 agent 默认只读，重新激活必须有显式协议。
- stop 与 redispatch 需要幂等 command ID，刷新和重连不得重复执行。

## 6. 画布与层级契约

- 页面可用区域就是 viewport；SVG/world layer 只描述世界坐标，不把内容宽高当页面尺寸。
- 只允许整图 pan/zoom/reset，不允许拖单节点。pointer down 时阻止默认文本选择；composer、popover 和可复制结果区域恢复文本选择并阻断画布手势。
- 节点只渲染 `icon + name + status overlay`。边从 icon 几何边缘到下一个 icon 几何边缘，使用曲线和脉冲；reduced-motion 下保留静态曲线。
- 主 agent 车道固定页面中线。子 agent 以完整 spawn 子树为单位分配左右两侧，以高度/节点数为权重平衡；已出现分支在新增事件时尽量保持侧别和 x 位置稳定。
- 运行 CRT、输入框、工具详情是锚定节点的 HTML overlay，使用 world-to-screen 坐标转换，不嵌入节点 `<g>` 的二次坐标系。
- 统一层级：页面画布 < 节点/边 < 节点 popover/CRT < 可拖动钢琴/主输入编辑浮层 < 历史抽屉 < modal/系统审批。历史抽屉不得被输入框遮挡。
- 钢琴面板可拖动、可收缩为按钮；拖动手势不能传给画布，位置需限制在可视区域，窗口 resize 后自动纠正。

## 7. 新 Checkpoints

以下阶段严格串行。每个阶段只交付它声明的能力，不用后续临时 UI 掩盖协议缺失。

详细开发点、注意点、自动验证和用户验收步骤以 [Checkpoint 执行索引](../../plan/README.md) 及其中的 `cpN.md` 为准。本节只保留摘要；阶段状态只在执行索引和对应 `cpN.md` 中更新。

### CP0：冻结原型并建立回归基线

状态：待实施。

- 将现有 CP2/CP3 标为未验收原型，不继续扩展。
- 为运行 ID `67dabe81-00fd-4021-92e0-f65cd061e94f` 和至少一个多 spawn fixture 固化 root snapshot/graph fixture。
- 记录当前历史抽屉、首次发送、暂停恢复、画板和钢琴的基线行为。

Checkpoint：用户运行现版本并确认基线用例、目标截图/录屏和必须保留的交互范围。

### CP1：canonical timeline 基础验收

状态：已有基础，需重新验收。

- 验证 root subscription、revision/eventSeq 缺口重取、历史抽屉 root timeline 和首次发送实时 patch。
- 修复首次发送无 running 状态、必须刷新才看到已运行/暂停的问题。
- 验证历史抽屉层级高于现有输入弹窗。

Checkpoint：首次发送立即出现运行态；主/子事件实时进入历史抽屉；刷新不丢身份、不重复；抽屉无任何遮挡。

### CP2：执行图事实协议

状态：待实施，是后续阶段的硬前置。

- 增加稳定 node/edge/orderKey/tool batch/active run/termination 契约。
- 新写入显式 spawn、continue、return、return-continuation、dispatch 边。
- 对历史数据建立 `callId -> owning timeline node` backfill，不在前端猜正文。
- Store 以 root revision 原子替换/patch 节点和边。

Checkpoint：使用真实多 spawn、多级子 agent 数据输出可审计 JSON；每条主→子、子→主、spawn→父继续边都有唯一事实来源，刷新前后 ID 与拓扑完全一致。此阶段可以没有最终画布。

### CP3：纯图投影与拓扑测试

状态：待重写。

- 重写 UI-neutral graph projector，覆盖全部节点/边类型。
- start、draft/pending、fold 仅作为明确的 UI projection layer。
- 建立多 spawn、嵌套 spawn、并发 return、无 return、dispatch、暂停、旧数据 backfill 测试。

Checkpoint：fixture 的图快照经用户检查无缺边、无重复边、无跨错 agent；当前“主 agent 没有连入/连出子 agent”的问题在数据测试层先被证明解决。

### CP4：全页面画布与基础视觉

状态：现有代码为未验收原型，需重写收口。

- 实现 viewport/world/overlay 三层坐标模型。
- 渲染统一的 icon+name skin、icon-to-icon 曲线脉冲、中心主线和两侧子树。
- 完成整图 pan/zoom/reset、禁止文字误选、click-after-drag 抑制和 reduced-motion。
- 保留钢琴拖动/收缩，统一手势边界与层级；不显示额外画布背景或开始按钮。

Checkpoint：用户在真实会话中验证全页面均可拖拽缩放、无文字误选；开始只是首个 icon 节点；主/子所有双向边可见；钢琴可拖动收缩且不带动画布。

### CP5：主线虚拟输入状态机

状态：现有 hover/Teleport 为未验收原型，需重写。

- 将现有富文本、指令、mention、附件、快捷键能力接入节点 overlay。
- 实现 idle/draft/editing/pending/consuming/entity 状态和 messageId 身份接替。
- 用户只在主线末端操作；运行中发送进入现有队列。

Checkpoint：空树点击开始输入；任意主线末端 hover 出现虚拟“我”；关闭删除 draft；发送后 pending 虚化；loop 消费后原位实体化并生成新终点；刷新过程中不跳位、不重复。

### CP6：工具批次与 spawn 详情

状态：待实施。

- 渲染 tool batch；单工具无 tabs，多工具严格按 index 显示 tabs。
- spawn batch 同时显示父 continue 和多个 child spawn 边。
- 支持嵌套 spawn、dispatch 和 return 详情。

Checkpoint：用户验证单/多工具、同批多 spawn、父主线继续、多个子 agent 并发及回传，详情与历史抽屉数据一致。

### CP7：默认 Fold 与实时展开

状态：待实施。

- 实现本计划定义的 fold 区间、默认折叠、active 自动展开、结束自动折回和手动固定展开。
- 实现首节点重新折叠按钮、左侧书签 label、高亮和 fold 展平 tabs。

Checkpoint：历史已结束工具段默认折叠；当前服务正在返回数据的节点始终显示；结束后自动 fold；新流式数据命中旧段时自动展开；展开前后时间顺序不变。

### CP8：暂停、termination 与子 agent 定向控制

状态：待实施。

- 持久化并渲染用户手动截断、系统停止、watchdog/error、agent redirect 尾注。
- 实现主 agent 停止、向 running/paused 子 agent 分发任务及因果边。
- UI 与服务端双重禁止用户直接给已有子 agent 发消息。

Checkpoint：暂停后 partial 数据和正确尾注保留，刷新仍存在；主 agent 可选择停止和重发指定子 agent；操作幂等且拓扑正确。

### CP9：节点锚定 CRT

状态：待实施。

- 将 running message/tool/approval/question 信息渲染为节点锚定 CRT overlay。
- 处理主/子并发 CRT 的侧向放置、碰撞避让、跟随 pan/zoom、固定/关闭和屏幕边界。
- 删除已被替代的独立 CRT stack。

Checkpoint：多个 agent 并发时 CRT 各自锚定正确节点；拖动/缩放后仍跟随；内容实时更新且完成后不重复；历史抽屉始终位于其上。

### CP10：清理、性能与全量回归

状态：待实施。

- 删除旧跨 session 合并、旧布局、临时 `foreignObject`、无效样式和已替代 CRT 代码。
- 补足协议、projector、layout、store、交互和端到端测试。
- 对长会话做增量布局、overlay 虚拟化和性能验证；保留可访问性、键盘操作和 reduced-motion。

Checkpoint：从空会话覆盖输入、工具、spawn、多级子 agent、dispatch、暂停、恢复、fold、CRT、刷新和断线重连；长历史可操作且无明显掉帧。用户最终确认后结束重构。

## 8. 每个 Checkpoint 的固定交付物

每阶段必须同时提供：

1. 本阶段变更文件和明确未做事项。
2. 自动测试结果及对应真实 fixture。
3. 用户可执行的手工验收步骤、预期结果和失败观察点。
4. 截图或可复现运行 ID（涉及视觉时）。
5. checkpoint 状态只允许“待实施 / 实施中 / 等待用户验收 / 用户已确认”。未获得用户确认不得提前把下一阶段标为实施中。

## 9. 当前下一步

下一步只执行 CP0，不直接修画线或继续做 Fold。CP0 完成并由用户确认后，进入 CP1；CP1 确保事实流可靠后，再在 CP2 一次性解决执行图协议。这样主/子连线、虚拟输入、Fold 和 CRT 都建立在同一套可刷新恢复的事实之上。
