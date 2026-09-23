# Nyxus 节点树维护、迁移与回滚

> **2026-09-15 主视图契约**：`MessageBranchTree` 是工作台核心主画布，默认使用 Pixi 横向 Signal 纯图标节点。流程图 `RuntimeDiagram` 只通过工作台互斥辅助侧栏按需挂载；卡牌与阅读器共享同一侧栏区域，不能同时显示。节点树侧栏打开时仍保持横向 Signal，不切换纵向 Classic。卡牌、流程图与阅读器统一以右侧抽屉打开（历史对话抽屉同款：遮罩 + 标题栏 + 关闭按钮），覆盖节点树但不压缩画布（画布保持全宽），抽屉宽度可拖拽及键盘调整（默认 50%，最小 300px 或 24% 容器宽，最大 88%，← 变宽 / → 变窄 / Home / End），点遮罩或 ✕ 关闭。

## 模块边界

- `web/src/stores/chats/read-model/rootTimeline.ts` 只维护 canonical snapshot、root transient plane 和 patch 原子应用；revision gap 由 store 触发 resync。
- `web/src/features/pets/nyxus/graph/executionGraph.ts` 只把显式节点、边和 active run facts 投影为 UI-neutral graph，不读取数据库结构，不按正文、时间相邻或角色名称推断关系。`projectActiveTurnNodes` 的 transient 锚点：`dispatch`/`spawn` 节点优先作为其 `target.chatId` 子 chat 的前驱（子 chat 流式回复从派发点连出），普通消息节点按 `createdAt` 取该 chat 最新（不依赖持久图数组遍历顺序）；同 chat 连续 stream 节点在单次投影内串联成链；子 chat 无任何持久/stream 节点时才 `?? start` 兜底。
- `web/src/features/pets/nyxus/graph/executionLayout.ts` 只处理稳定 lane、全局纵向顺序和坐标缓存；流式正文变化复用坐标，拓扑变化才重算。
- `web/src/features/pets/nyxus/graph/nodeSkins.ts`、`edgeStyles.ts`、`termination.ts` 和 `web/src/styles/overlayLayers.ts` 分别集中 skin、edge、termination 文案和 overlay 层级。
- 连线语义色由 [edgeStyles.ts](../../../web/src/features/pets/nyxus/graph/edgeStyles.ts) 的 `edgeStyle(kind, theme)` 维护深浅两套；[useThemeTokens.ts](../../../web/src/composables/useThemeTokens.ts) 的 `PIXI_CANVAS_PALETTES` 提供边线透明度和分支标记色，沿现有 `setPalette` 重绘入口应用。改变颜色不改变节点、边、布局或聚焦弱化规则；验证用 `pnpm test:web` 加双主题画布截图，关注实际混合后边线对比度。
- `MessageBranchTree.vue` 只编排画布、HTML overlay、输入和可访问性交互，不重新构造 canonical relation。
- 节点树的指针高亮是单实例、非命中视觉层：精细鼠标进入画布后隐藏系统指针，空白处显示半透明直角方框和粗亮描边，进入节点后弹性吸附并完整包住节点，填充与描边均跟随节点语义色；不得抢占透明命中层、画布拖拽或 hover popover。节点本体使用比指针框更细、更亮的常态描边，错误、暂停和选中等状态仍保留更高视觉权重。
- `MessageBranchTree.vue` 向 Pixi 同步场景时，去重签名必须覆盖节点坐标及边的起点、终点和路由坐标；切换折叠或同行布局即使不改变节点 ID，也必须把新的几何位置提交给 GPU 渲染器。
- 同行布局按 lane 感知的最早可用行压缩，但任何直接连线的目标节点都必须比来源节点至少低一行；该规则不区分同列、跨列、派遣、分叉、返回或汇合。只有彼此之间不存在因果约束的节点才允许同行，禁止渲染水平因果连线。
- 极致压缩的参与者过程组不得跨越任何保留的可见节点；用户输入、最终回复和分支锚点既是展示边界也是折叠区间边界，避免过程组同时位于同一锚点的前后两侧而形成投影环。
- 工作台右侧工具栏的运行控制只消费 root snapshot `controlState` 和 `activeRuns`；运行时显示暂停，无运行且暂停集有剩余目标时同槽切换为继续。
- 工作台展示任务聚合快照时，暂停任务树与暂停全部分支均只由该任务 `activeRuns` 中的 `running/waiting` 事实控制；所有分支结束后不得继续读取单会话缓存运行态来显示暂停按钮。

## 四档节点收纳与排列规则

本节是四档节点树的统一显示规则。代码和测试必须按这里描述的收纳关系与排列关系实现；当前代码中的偶然表现不能反过来改变这些规则。

### 先分清三种不同的“收起”

| 名称      | 它做什么                                                                                     | 它不做什么                                           |
| --------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 四档显示  | 临时减少画面上的节点数量，把若干执行细节放进“过程组”                                         | 不删除消息，不改变任务，不改变模型以后能看到的历史   |
| `compact` | 让模型为一段较长历史写摘要，并从摘要之后继续对话；较早的完整节点在主树上改用“旧历史”节点代表 | 不是四档显示，也不是更换角色、提示词或工具           |
| 纪元      | 记录一段执行使用的是哪套角色、提示词、工具和模型设置                                         | 不压缩消息，不截断对话，也不因为切换纪元而另起一棵树 |

“过程组”和“旧历史”节点必须使用不同名称、不同图标和不同打开方式，不能让用户误以为它们是同一种东西。

### 所有档位共同遵守的规则

1. 时间和执行方向从左向右。任何有直接连接的两个节点，后一个必须位于前一个右侧，不能画成同一列或倒退。
2. 主节点的当前主线放在中间。协作节点从“派出任务”处分出去，各自占用独立横行；协作节点继续派出的下一层协作节点排在更外侧。
3. 协作结果必须沿真实连接回到接收节点。没有明确连接时，不根据文字、时间接近或角色名称猜测返回位置。
4. 彼此没有先后关系的节点可以放在同一列；存在先后关系的节点不能放在同一列。
5. 切换档位只能把一段节点替换成过程组，或把过程组还原。仍然单独显示的节点必须保持原先的先后顺序，分支不能交换上下位置。
6. 一个过程组至少收纳两个“可翻看的步骤”。单个步骤保持为普通节点，不能套一层空壳。
7. 过程组不能跨过用户消息、分支起点、纪元分界或该档明确要求保留的节点。
8. 正在运行、等待用户处理、暂停或刚失败的内容必须直接可见，不能只藏在过程组里；同一轮中已经完成的前段仍按当前档位收纳。包含隐藏失败步骤的过程组仍要明显标红。
9. 尚未回答的提问、尚未处理的审批和其他仍需用户处理的操作始终单独显示；已经回答或处理完成后，可以按当前档位进入过程组。
10. 撤回或终止节点保留自己的状态，不得因为被收进过程组而看起来像正常完成。

这里的“一轮”是指：同一条分支上，从一条用户消息开始，到下一条用户消息之前为止。不同分支分别计算，不能把多个分支按时间混成一轮。

### 第一档：完整展示

这一档不建立过程组。

- 用户消息、主节点回复、协作节点回复、工具执行、派出任务、协作任务入口、结果返回、结果接收、系统提示、失败和终止全部单独显示。
- 一次回复及其随后调用的工具仍按真实先后排列，不为了节省空间合并。
- 主节点和每个协作节点各自沿自己的横行展开；多级协作关系逐层向外展开。
- 这一档用于检查真实执行顺序，也是其他三档是否丢节点、接错线的对照基准。

### 第二档：局部收纳

这一档只收起已经完成的连续执行细节，任务结构仍完整显示。

- 只处理同一条分支、同一个执行者的连续内容，不能跨分支，也不能把主节点和协作节点混在一个过程组里。
- 可收纳内容是已经完成的模型回复和工具执行。一次回复及其对应的工具执行在过程组内算一个可翻看的步骤。
- 至少连续出现两个可翻看的步骤才建立过程组。
- 用户消息、提问、审批、派出任务、协作任务入口、结果返回、结果接收、分支起点、系统事件、终止和仍在运行的内容保持单独显示。
- 当前步骤仍在运行时，只展开当前步骤；它之前已经完整结束的连续步骤可以继续收纳。
- 每个执行者分别形成自己的过程组，原有上下分支位置不变。

### 第三档：按参与者收纳

这一档保留“谁把任务交给谁、结果怎样回来”，收起每个参与者自己的内部过程。

- 每一轮都保留用户消息和本轮最后回复。
- 保留派出任务、每个协作任务的入口、每个结果返回、多个结果汇合后的接收节点，以及所有分支起点。
- 主节点、每个直接协作节点和每个更深层协作节点分别建立过程组，任何过程组只能属于一个参与者。
- 一个参与者在“接到任务—返回结果”之间的内部回复和工具执行可以收进过程组，但不能跨过新的派出任务、结果返回或结果汇合点。
- 多个协作节点并行时，各自保留独立横行；它们不能因为收纳而合并成一条线。
- 本轮仍有参与者正在运行、等待、暂停或失败待处理时，相关节点保持展开；其他已经完成的连续内容继续按参与者收纳。

### 第四档：只看每轮主线

这一档用于快速阅读“用户提出了什么，系统最后怎样回答”，但仍须保留所有分支，而不是只保留当前分支。

- 每条分支、每一轮都保留用户消息、本轮最后回复和分支起点。
- 派出任务、协作任务入口、内部工具执行、结果返回和结果接收都可以收进过程组。
- 同一轮中，两个保留节点之间的所有执行细节可以合成一个过程组；若中间还有分支起点，则必须在分支起点前后拆成两个过程组。
- 没有分叉的一轮通常显示为“用户消息 → 过程组 → 最后回复”。若没有足够内容形成过程组，则直接连接用户消息和最后回复。
- 不同分支仍占用不同横行。为了减少空白，可以把支线向中间靠拢，但不能交换支线顺序、让连线倒退或把两条支线重叠。
- 没有直接先后关系、处于同一进度位置的多个分支节点允许排在同一列；存在直接连接的两个节点必须分列，后一个位于右侧。
- 本轮仍在运行、等待、暂停或失败待处理时，只保持相关节点和必要的用户消息、分支起点直接可见；其他已经完成的部分继续收成主线。

### 四档必须形成稳定的递进关系

从第一档切到第四档，单独显示的节点只能逐档减少，不能出现“第二档藏起来、第三档又无理由重新出现”的节点。允许重新出现的唯一情况是节点状态发生变化，例如开始运行、进入等待、暂停或失败。

同一份静止历史应满足：

```text
完整展示的单独节点
  包含 局部收纳的单独节点
  包含 按参与者收纳的单独节点
  包含 只看每轮主线的单独节点
```

### `compact` 后的旧历史怎样放入树中

每完成一次 `compact`，就结束一个对话段。摘要消息是这个对话段的最后一个节点；摘要之后开始新的对话段。自动 compact 和手动 compact 的收纳规则相同，“自动/手动”只用于说明它是怎样触发的。

主树按以下方式展示：

1. 当前仍在继续的对话段保留为实际节点，不替换成“旧历史”节点；其中各节点是否收入过程组，仍按用户当前选择的档位处理。
2. 最近一个已经结束的对话段也保留为实际节点，方便用户理解当前内容从哪里接续；其中各节点同样按用户当前选择的档位处理。这里只保留最近一段已经 compact 的历史。
3. 更早的每个对话段各显示为一个“旧历史”节点，按时间从早到晚排在主线开头。
4. 每个已经结束的对话段必须在主树中恰好出现一次：最近一段保留实际节点，更早的段由“旧历史”节点代表，不能遗漏，也不能重复。
5. “旧历史”节点在四个档位中都保留，不能再被放进过程组。
6. 用户点击“旧历史”节点后，打开只读的二层节点树，只展示该对话段的节点和连接；不混入当前输入、当前运行窗口或当前提问，也不再出现下一层“旧历史”节点。
7. 二层节点树沿用主树当前选择的档位。例如主树处于“按参与者收纳”，打开旧历史后也按参与者收纳；用户切换主树档位后，已经打开的二层树同步使用新档位。
8. 已结束并收起的旧历史只允许查看，不允许从其中某个节点创建新分支。

示例：已经完成三次 compact，现在正在第四个对话段中工作。主树应显示：

```text
开始 → 第 1 段旧历史 → 第 2 段旧历史 → 第 3 段实际节点（按当前档位）→ 第 4 段当前节点（按当前档位）
```

当前实现由 [`historyProjection.ts`](../../../web/src/features/pets/nyxus/graph/historyProjection.ts) 统一处理。它按所属根会话分别计算 compact 段：最后一个已结束段继续使用实际节点，更早的每一段各生成一个“旧历史”节点。任务合并数据也携带各分支的旧历史目录；分支中的“旧历史”节点接在该分支真实的分叉线之后，点击时按它所属的根会话加载内容，不会与主分支同编号的节点混淆。

### 纪元怎样影响节点树

纪元记录的是执行设置，不是对话分段。更换系统提示词、角色编制、可用工具或实际选择的模型设置时，可以进入新纪元；只更换连接地址、密钥或超时设置时不进入新纪元。

纪元切换必须遵守以下规则：

1. 切换纪元不删除、不摘要、不复制历史消息。新纪元继续使用此前的完整对话。
2. 纪元切换不另起一棵节点树，也不改变已有节点的先后和分支关系。
3. 旧纪元只读，当前纪元可以继续执行；这与旧历史因 compact 而只读是两种不同原因。
4. 所有四档都必须显示一个轻量的“设置已切换”分界标记，并禁止过程组跨过该标记。这样用户能知道标记前后的节点使用了不同设置。
5. 分界标记只说明设置发生变化，不充当用户消息、模型回复、过程组或“旧历史”节点。
6. compact 可以发生在一个纪元内部，也可以跨越多个纪元；纪元切换也可以发生在两次 compact 之间。两套编号分别计算，互不替代。

当前实现从消息记录和执行节点携带的真实纪元编号判断归属。只有一条明确的前后连接两端都有纪元编号，并且编号确实不同时，才插入“设置已切换”标记；旧数据缺少纪元编号时不按时间猜测。四档收纳都会保留该标记，过程组也不能跨过该标记。

### 实现与验证入口

- 四档选择和提示文字：[`useWorkbenchDialogController.ts`](../../../web/src/features/agent/workbench/useWorkbenchDialogController.ts) 的 `FOLD_TIPS`。
- 四档收纳计算：[`foldProjection.ts`](../../../web/src/features/pets/nyxus/graph/foldProjection.ts) 的 `computeFoldRanges()`、`computeParticipantFoldRanges()` 和 `computeFullFoldRanges()`。
- 节点排列：[`executionLayout.ts`](../../../web/src/features/pets/nyxus/graph/executionLayout.ts)。
- `compact` 旧历史节点和纪元分界：[`historyProjection.ts`](../../../web/src/features/pets/nyxus/graph/historyProjection.ts) 的 `projectPackedGenerations()` 和 `projectEpochBoundaries()`。
- 旧历史只读二层树：[`GenerationTreeDialog.vue`](../../../web/src/features/pets/nyxus/components/GenerationTreeDialog.vue)。
- 纪元事实说明：[配置修订、上下文纪元与删除生命周期](../../shared/architecture/context-epochs.md)。
- 定向验证：[`executionGraph.test.ts`](../../../web/test/nyxus/graph/executionGraph.test.ts)、[`fold.test.ts`](../../../web/test/nyxus/graph/fold.test.ts)、[`graphLayout.test.ts`](../../../web/test/nyxus/graph/graphLayout.test.ts) 和 [`generations.test.ts`](../../../test/service/chat/generations.test.ts)。

## 展示语义

- 节点树面向用户描述任务过程，不直接暴露 `kind`、会话 ID、方向或因果 ID 等图谱内部字段。
- 任务可包含多个根分支，但 `activeBranchId` 指向唯一活动主干。活动主干固定占 lane 0；从分叉点被替换的旧主干后缀移动到 +1 或 -1，其他 continuation/detail 分支按稳定顺序继续向外扩展。共享前缀保持在中轴，不能仅按 chatId 给整条旧会话固定 lane。
- `fork-continuation`/`fork-detail` 是合法的持久边；其目标分支必须获得区别于来源参与者及既有分支的独立 lane。任务聚合图中的 continuation/detail 分支允许各自的用户入口，不得按“用户直接输入子 Agent”报错。
- 细节解释分支作为独立参与者；运行中只展开它自身所在轮次，不解除其他分支的折叠。
- 工作台任务树以 `chatSessions.rootTimeline(rootChatId, 'tree')` 的订阅快照作为实时 canonical 数据源；`getTaskTimeline` 的任务聚合快照只在 live 快照缺失或 revision 落后时兜底。live revision 追平或更新后，[`useWorkbenchDialogController.ts`](../../../web/src/features/agent/workbench/useWorkbenchDialogController.ts) 不得继续向 `MessageBranchTree` 传入 `timelineOverride`，避免旧 canonical 拓扑与当前 transient 输入、运行态及 CRT 混合。代际二层弹窗的 `staticView` 不受此规则影响。
- Agent 消息节点优先显示 `roleType` 角色名；缺失时，根会话降级为“核心节点”，子会话降级为“协作节点”。界面文案不得出现 `Agent`、`Fold`、`Spawn` 等内部英文类型名。
- 展示名称固定为：`start=任务起点`、`fold=过程组`、`tool-batch=工具执行`、`return=结果返回`、`dispatch=任务委派`、`spawn=创建协作节点`、`system=系统事件`、`input=我的指令`、`unknown=未识别节点`。
- **过程组含错误红框（2026-09-04）**：过程组（fold）折叠范围内含隐藏错误消息时（`foldContainsErrorMessage`：fold 成员存在 `termination.code === 'error'` 的 message），该组外框在三种呈现形态一致显示红色且须醒目——vertical-classic 节点外圈加粗红描边 + 外圈光晕；horizontal-signal 主体外扩 4px 外框加粗红描边 + 光晕；paperMode 卡牌（`is-error-group`）亮色外圈层替换为红色 + 光晕、四角角饰同步变红，深棕内框不变。红色沿用各子系统错误色相（画布 `stateError`；卡牌经 color-mix 融入纸面）。
- 横向 lane 间距固定为 110px；节点标题按紧凑宽度省略，完整信息继续由节点详情承载。该收窄仅为后续侧边信息区留出空间，本阶段不新增侧边区域。
- 工具节点仅从 `sense.tools` 元数据读取图标和中文名称。单工具显示工具名，多工具显示“工具执行 · N 项”；元数据缺失时降级为通用图标和“工具”，不暴露内部工具 key。
- 同一次 assistant 响应拆出的 `message` 与 `tool-batch` 以显式 `sourceMessageId` 投影为一个工具视觉节点；模型 thinking/content 位于工具区上方，多工具随后显示页签，单工具直接显示详情。不得依靠时间相邻或正文内容配对，且不得因此改变 canonical facts、工具批次 ID 或 spawn/continue 拓扑。
- 说明区只展示大模型返回数据中的 `description` / `explanation` 等真实字段。禁止根据工具元数据、节点类型或前端经验生成说明和占位文案；真实说明不存在时不渲染说明区。
- 节点悬浮卡片采用高密度“固定标题 → 固定工具页签 → 可滚动正文”的结构。正文包含真实说明、类型化指令/参数和结果；文件、询问等特殊工具也必须在这套新版正文内使用原生分区展示，不得嵌入或复用聊天消息的旧工具卡片。
- 卡片根容器禁止滚动；仅正文区域在受视口高度限制时纵向滚动。标题、工具页签和操作按钮始终可见，正文中的代码、表格、结果和终止提示不得产生嵌套纵向滚动条。
- 1920×1080 浏览器基线下，普通详情面板宽度约 520px、可用高度不超过 640px 或 `100vh - 96px`；标题约 38px、页签约 32px，视觉使用 3–4px 小圆角、细分隔线和 6–10px 紧凑间距。**用户阅读性质的内容（中文正文、说明、参数值、结果、错误提示等）字号不得低于 12px**；仅装饰性字形（✓/ⓘ/✦ 等 aria-hidden 图形）与纯数字徽标可保留更小字号，规格详见 [设计语言规范 §3.1](../../standards/frontend/design-language.md#31-字重与字号)。
- 指令参数按真实数据类型展示：`command` 使用终端指令块，`path` 使用路径条，`url` 使用地址条，`task` / `prompt` / `query` / `instruction` 使用主要指令区，短标量使用紧凑参数项，对象和数组使用层级化文本。
- 多工具页签只承载图标和工具名称，不展示运行状态；每次调用的执行中、已完成或失败状态必须放在当前页签的内容区，避免状态与工具名称争抢宽度。**询问类（`ask_user_question`）页签省略 ❓ 图标**（提问批次页签以文字为主，与运行中工具图标展示互不影响）；**页签右上角以小色点呈现安全判定**（安全=绿 / 中=黄 / 高=红 / 未知=灰），无文字、无底色，替代原先的 RiskBadge 文字徽章。
- 页签内的图标使用固定尺寸容器，与工具名称单行垂直居中；字形、emoji 或图标宽度不得改变文字基线和页签高度。
- 内容区字段统一采用“标题在上、正文在下”的纵向层级，不再使用标题与正文左右并排的紧凑变体。
- 可复制内容的操作入口归属正文容器：复制图标固定在内容块内侧，标题行不放操作按钮；单行和多行内容使用同一容器规则，文本仍可选择且换行语义不变。
- 文件内容、命令输出、提示词和通用工具结果必须保留原始换行；不得将普通文本中的换行符折叠为空格。
- `ask_user_question` 在历史详情使用专用视图：显示题目、单选/多选类型、全部选项及说明和已选状态，不直接暴露原始 JSON。已选选项的用户补充描述（`label（补充: note）`）解析后显示在对应选项框内；**单选时「其他」自由文本作为一条勾选选项展示**（外框虚线差异化，区别于预置选项），无输入则不显示该条；**多选时「其他」自由文本仍作为独立补充回答展示**。**等待中且命中 pending 提问批时（`call.id`=questionId，见 workbench-multi-window.md 对话模式节）切换为列表内可交互形态**：选项可点选（单选互斥/多选叠加）、「补充」输入、「其他」也作为选项项（与单选/多选视觉一致，点击展开自由文本输入；单选互斥/多选共存）、底部「提交回答」，提交走 `interactions.answer`（整批原子提交，草稿全局共享），提交后自动回退只读展示。
- `search_codebase` 在新版正文中展示搜索方式、搜索内容、搜索范围和真实搜索配置，并将返回文本解析为“汇总 + 文件路径/行号 + 匹配正文”的原生结果列表；空结果和错误保留后端真实提示，完整结果可从内容块复制。
- `skill` 在新版正文中分离技能名称和实际技能指令：移除返回值中重复的激活包装文案，显示真实指令行数并保留 Markdown 与换行；技能不存在或加载失败时显示真实错误，不嵌入聊天消息的旧技能卡片。
- `update_todo` 在新版正文使用待办列表原生分区（📋 待办 + 完成数 + ✓▣☐ 状态字形列表，与对话页同款渲染），经 `.popover-tool` 包装套用 CRT 主题；参数不再落入嵌套字段树，结果文本「任务列表已更新」不单独展示（待办列表已承载状态）。卡牌阅读模式情报卡同款以待办列表呈现。
- 高频悬浮反馈仅用于空间连续性和状态辨识：进入/退出使用不超过 200ms 的 `opacity/transform`，内容切换使用短淡入；禁止正文持续位移或颗粒抖动。应用不跟随 `prefers-reduced-motion`（见 `docs/frontend/settings.md` 动效降级约定），动效恒开。
- 暂停后发新消息且存在被中止子 Agent 时，节点树显示一条稳定 ID 的“系统事件”；不得伪装成用户消息，重试、刷新和回放不得重复生成。
- 运行 CRT 与节点详情共用石墨终端色板：深石墨背景、灰白正文、青色交互强调、琥珀运行态、绿色完成态、红色失败态。禁止整卡扫描线、循环边框、噪点位移和逐字输出；流式状态仅允许小状态点低幅反馈，正文页签切换只做短淡入。
- 运行 CRT 默认尺寸较旧版缩小约 15%，标题栏可拖动。CRT 默认以标题栏贴靠所属节点左右侧且不做窗口间避碰；多个 CRT 可重叠，点击窗口提升其局部层级。用户手动拖动的位置保留到下一次节点树 pan/zoom 或布局变化，随后重新吸附到所属节点旁；无需为了让正文底部留在视口内而推远窗口。坐标与层级只保留到当前工作台组件销毁。
- 节点悬浮框（hover 详情 / 常驻审批气泡 / 提问气泡）统一定位（2026-09-02 调整，横竖排版一致）：hover 详情弹窗优先出现在所属节点**正下方**（水平锚点取节点底沿中点居中；下方放不下时回退右侧优先的侧贴逻辑）。**过程组左轮（FoldTabRail）与弹窗并排、顶对齐，统一落在节点下方区域**：默认贴弹窗左侧（右缘距弹窗左缘 18px），左侧视口空间不足时改贴弹窗右侧；两侧都放不下时钳制在视口内（极窄视口才与弹窗轻微重叠）。左轮随弹窗容器移动（pinned 拖动弹窗时保持相对位置）。审批/提问等 action 弹窗仍走右侧优先侧贴。**定位高度一律使用实测内容高度**（未测量前用合理小初始值），不得用视口上限高度参与垂直钳制——否则矮窗会被 `viewport - 上限` 顶到视口顶部（“飘高”）。**详情弹窗定位一次显示只求值一次（2026-09-02 冻结契约）**：显示会话开始（hover 换到新节点，或弹窗关闭后重新显示）时一次性求值弹窗位置与左轮贴边并冻结；此后实测高度回填、画布缩放/平移、视口 resize 均不改变弹窗位置（屏幕坐标完全冻结，节点可能随相机移走）。hover → pinned 切换不算新显示会话，不重定位；pinned 手动拖拽经 `detailManualPos`、尺寸档位切换经 `detailSize` 覆盖冻结位置。求值时刻内容高度未实测则用初始值参与本次决策，不再随实测回填重排。悬浮框**不绘制锚点连线**：连线仅运行 CRT 保留（`crtPlacements`），审批/提问等 action 弹窗与详情弹窗均无连线。
- 常驻悬浮框（pinned 详情 / 审批 / 提问气泡）标题栏可拖动：拖动后固定在用户放置的位置（钳制在视口内、保留标题栏可见），关闭重开即清除手动位置重新吸附回自动定位；hover 临时详情不参与拖拽。实现复用 CRT 的 pointer-capture 拖拽模式（`AnchoredRunCrt`），不走窗口间避碰。
- **详情弹窗入场与拖拽直写（2026-09-02 返工契约）**：详情锚点容器经 `useOverlayTransitionHooks('panel')` 接入 Vue `<Transition :css="false">`（替代 CSS `node-detail` 过渡，参数收敛 MOTION token）；弹窗内部入场时间线为标题栏→页签→正文 stagger（总时长 ≤320ms，`useGsap` scoped、只动 transform/autoAlpha，组件挂载时执行一次，hover 切换节点不重放）。pinned 拖拽在 pointermove 期间用 `gsap.quickSetter` 直写元素（拖拽写 transform x/y，与树平移的 CSS `translate` 属性分属不同通道可叠加），**不触发每帧响应式 patch**；pointerup 才把终值一次性落回 `detailManualPos` 并清除直写 transform（落回与清写在同一帧内完成，无闪烁）。为此弹窗 emits 新增 `dragEnd`。**常驻窗口尺寸改由头部「尺寸切换」按钮在 S/M/L 三档间循环（`cycleDetailSize`/`detailSizeLabel`，2026-09-15 变更）**：取代原 8 向拖拽 resize 手柄，换档只更新 `detailSize`，未拖过位置的窗口继续自动定位、拖过的位置回收进视口；`detail-resize-handle` 样式与 `startDetailResize` 已删除。**档位定义（`detailSizePresets()`，2026-09-15 二次调整）**：S = 当前默认尺寸（640×520，即原 M 档，实测“刚刚好”）；M = S 宽度 +25%（800×650）；L = S 宽度 +50%（960×780）。**常驻窗口内容可点切（2026-09-15）**：窗口固定（拖拽/点击过某节点）后，点击任意有详情内容的节点，窗口内容即切换到该节点，窗口停留在手动放置位置；未固定时点击固定仍限 `canPinNodeDetail`（含终止/工具批/过程组/返回/委派）节点。**正文最小字号随档位缩放（--popover-content-font，2026-09-15 变更）**：S=12px / M=13px / L=13px，只作用于常驻（pinned）窗口正文，hover 临时弹窗始终 12px；头部/页签等窗口外壳字号固定。**常驻过程组标题分页器（2026-09-16）**：常驻（pinned）详情窗口展示过程组（fold）时，标题保持「过程组」文字，其右侧的数字以分页器呈现——`‹ X/Y ›`，前后箭头只围绕数字、按步进切换折叠成员页（popover `stepFold` emit → 树 `stepFoldDetail` → `selectFoldMember`，与左轮共用同一选中态 `selectedFoldMembers`）；hover 临时弹窗保持纯文本标题，左轮（FoldTabRail）仍同时可用。
- 普通消息提交、流式节点追加和视口 ResizeObserver 不得自动修改用户当前相机；只有初次挂载、切根、切换折叠/布局档位和显式复位允许 fit。**横向 Signal 例外（新增节点跟随）**：初次挂载/切根/切换折叠/显式复位时保持节点默认尺寸（scale 1），最右节点右缘停在视口宽度 80% 处（距右缘 20%），树不 fit 铺满全宽、节点不缩小；此后新增节点不再重新 fit（避免节点随数量增多缩小），最右节点越过同一 80% 警戒线（距右缘不足 20%）时保持当前缩放整体左移，让新节点继续从右侧出现；用户手动平移/缩放后暂停自动跟随，仍由「回到最新」手动复位。实现入口为 [`useTreeCanvas.ts`](../../../web/src/features/pets/nyxus/composables/useTreeCanvas.ts) 的 `followContentEndX` 与 `calculateFitTransform` 的固定 `scale`/`tailRatio`，由 [`useMessageBranchTreeController.ts`](../../../web/src/features/pets/nyxus/components/useMessageBranchTreeController.ts) 在横向 Signal 下按 `TREE_TAIL_EDGE_RATIO` 触发，定向验证见 `web/test/nyxus/canvas/treeCanvas.test.ts` 与 `treeMotion.test.ts`。
- 工作台历史入口在任务含分支时固定打开 `activeBranchId`；标题栏按活动主干、其他继续分支、解释分支排序。`original` 仅表示最初分支，不再永久标记为“主流程”。用户可把任一 original/continuation 直接设为主干；该操作只切换身份与节点树 lane，不复制消息或启动执行。分支标题取该分支第一条用户消息。工作台会话列表不随主干切换增减条目：列表恒只列 `original` 分支（复用 `isPianoRootSession`，约定见 [rendering.md#工作台会话列表nyxussessionlist](rendering.md#工作台会话列表nyxussessionlist)），continuation/detail 一律经工作台标题栏访问。
- continuation 的首条用户消息之前必须展示一个持久“结果汇总”系统节点：其前方由来源锚点的 `fork-continuation` 连线接入，继承的已完成任务返回连入该节点；后方再连接新用户消息。迟到的继承任务结果分别显示为独立返回节点并连接到当前活动主干，不合并进旧汇总节点。

## Signal Grid 展示投影（2026-09-02 返工契约，二轮修订）

Signal（横向）模式是在 `executionLayout.ts` 纵向布局**之后**的纯展示投影（`executionPresentation.ts`），只做坐标旋转与视觉增强，不改 lane/行事实。返工后生效的投影契约：

- **零文本原则（二轮返工）**：节点上不渲染任何文字（协议码/摘要/标题/glyph 全部不上节点），类型辨识 100% 靠图形；用户看到节点即知类型。
- **统一紧凑方框（三轮重构）**：所有节点固定为 40×40 方框和 24×24 icon；主体外扩 4px 的完整外框、内缩细框和端口座共同形成参考图的双层线框。节点内不渲染任何文字。边框按语义分为角线、上下导轨、分段顶边和侧缺口四种克制变体，节点尺寸保持不变。
- **类型图标矩阵（三轮重构）**：基础 9 类和工具 20 类均映射到 `vue-icons-plus/lu` 的独立 Lucide 图标。图标组件只在纹理初始化时渲染一次，节点实例复用 Pixi Sprite；未知或单图标加载失败降级到 `LuWrench`。
- **颜色双通道（三轮重构）**：Signal 的 29 类使用独立深浅主题色；危险程度覆盖优先于类型色（error 红 > paused 琥珀 > revoked 灰），running/detailActive 提亮描边。
- **正交总线（三轮重构）**：同 lane 从端口水平直连；跨 lane 使用 8px 圆角 `H-Q-V-Q-H` 路径。普通分叉共享来源侧干线，return 共享目标侧汇合干线，接点由小圆点标识。路由存入 `routeX`，`routeY` 在 Signal 投影清空，全边保持 `to.x > from.x`。
- **禁止水平因果连线**在 Signal 下等价为：任何直接连线的目标列必须严格在来源列右侧（`to.x > from.x`）；投影保持"纵向行序→横向列序"映射，该不变量恒成立。
- **间距**：列间净距为 72px，投影 lane 间距 `SIGNAL_LANE_GAP` 为 88px；这些值只属于 Signal 展示，与 `EXECUTION_LANE_GAP`=110px 的 canonical 红线无关。
- **标签**：Signal 模式不创建任何 Text 标签（`rebuildLabels` signal 分支空转），`signalLabelBudget`/`SIGNAL_LABEL_*`/`protocolCode`/`summary` 投影链摘除；可访问性文本由 HTML `aria-label` 承载。
- **过程组交互（左轮原样回归，2026-09-02 二轮返工）**：折叠过程组的展开导航原样回归 143af38 之前的"左轮"形态——`FoldTabRail.vue`/`foldTabs.ts` 整体回退至 143af38~1 版本（弹链轮盘重做与 `bulletKind` 判定废弃），行为排版零改动；仅两项样式适配：卡项全直角（组件内无任何 `border-radius`）与卡内事件驱动动效（步进通电 220ms / hover ≤160ms / unread pop 220ms，无常驻循环）。规格见 [rendering.md#过程组左轮foldtabrail-原样回归2026-09-02-二轮返工](rendering.md#过程组左轮foldtabrail-原样回归2026-09-02-二轮返工)。旧三环卫星轨道（orbit-ring-visual 等）保持移除。
- **回退**：Signal 投影初始化异常仍走 `presentation-fallback` 自动回退 Classic；该回退不受卡牌/方向联动（见 [workbench-multi-window.md](../workbench-multi-window.md)）反向翻转。
- 经典（Classic 纵向）渲染分支与本投影互不影响；本章节任何规则不适用于 Classic 分支。

## 节点树钢琴彩蛋

钢琴降级为纯键盘弹奏彩蛋后，入口完全藏在节点树内（无任何 rail/工具栏按钮）。触发为**多节点连点序列**，整段流程须在 8 秒时间窗内完成，错步或超时立即复位：

1. 点击**开始节点**（`start`）；
2. 依次点击三个**不同特征节点**——顺序为 `tool-batch`（工具执行）→ `dispatch`（任务委派）→ `fold`（过程组），且每个都必须是**未点过的新节点**（`seenIds` 防重复点同一节点刷序列）；
3. 最后点击**主流程最后一个节点**（`mainExecutionEndpoint(graph.value).id`，取**渲染图**投影——折叠档位下视觉尾节点可能是 fold 卡，仍可点）。

序列由 `usePianoEasterEgg.ts` 状态机维护：`consume(node)` 在 `activateNode` 顶部消费，返回 `true` 即 `emit('easter-egg')` 并吞掉本次点击（不触发节点正常点击行为）；时间窗 `PIANO_EASTER_EGG_WINDOW_MS=8000`，每次成功推进重置，超时/错步复位并清 `seenIds`。

**开始节点可点化**：`start` 本不在 `NODE_HOVER_DETAIL_KINDS`（纯装饰节点），`visibleInteractiveNodes` 默认过滤。为承载彩蛋首步，工作台（非 `staticView`）下把 `start` 加入命中层（`isInteractiveNode(node) || (!props.staticView && node.kind === 'start')`），`onNodePointerDown` 同条件 `stopPropagation()` 防画布 pointer capture 抢点击；`showNodeDetail` 已有 `hasNodeHoverDetail` 守卫，start 悬停不弹详情。**GenerationTreeDialog 二层（`static-view`）不挂命中层、状态机 `enabled: () => !props.staticView` 禁用**，彩蛋只在工作台主树生效。

触发后 `MessageBranchTree` 上抛 `@easter-egg`，工作台打开节点树视口中央浮层钢琴（`openPiano`，见 [rendering.md#nyxus-钢琴彩蛋nyxuspianostrip](rendering.md#nyxus-钢琴彩蛋nyxuspianostrip)）。

## 性能基线

`web/test/nyxus/graph/performanceRecovery.test.ts` 使用 2,000 节点、1,999 边、8 个并发 CRT 和连续 120 次流式正文更新：

- 静态拓扑只允许一次完整 layout；120 次正文更新不得增加重算次数。
- 120 次增量刷新预算为 1,500ms（CI 硬门禁）；门禁计时取 3 轮循环的最小值——衡量投影本身的开销而非机器负载（全量套件并行时其他 worker 争核会抬高 wall-clock），空闲 CI 上与单轮等价。真实浏览器要求持续操作无明显掉帧、跳位或持续内存增长。
- 普通 CRT 最多显示 5 个，额外 3 个聚合；审批与提问等 actionable overlay 不受普通上限隐藏。

## 兼容字段

- `TimelineNode.parentNodeId` 与 `causationId` 仅用于旧数据诊断和服务端 backfill，不参与前端建边。
- 新写入必须生成显式 `ExecutionEdgeFact`；兼容读取计划保留至 2026-12-31，届时在真实数据审计无残余后移除字段。
- `createdAt` 仅用于展示和 transient 排序；持久因果顺序使用 root 单调 `orderKey`。

## 数据迁移

1. 导出目标 root 的 audit/tree snapshot，并保存原始数据库备份。
2. 服务端根据持久 tool-call owner、spawn task 和 message link 生成显式 edge facts。
3. 运行 `vitest run --config web/vite.config.ts web/test/nyxus/graph/executionGraph.test.ts web/test/nyxus/graph/executionGraphFixtures.test.ts`，确认无 `legacy-relation-unresolved` 或 dangling diagnostics。
4. 打开真实 root，验证历史抽屉仍消费 conversation timeline，节点树只消费 tree facts。

## 回滚

1. 停止写入新 graph facts，保留数据库备份与 CP0/CP2 真实 fixture。
2. 回滚 CP10 增量布局和诊断 UI 时无需回滚协议或数据库；`layoutExecutionGraph()` 仍可直接执行完整布局。
3. 若服务端 graph facts 异常，恢复数据库备份并重新打开 root subscription；前端诊断条的“重新同步”不会修改数据库。
4. 禁止恢复已删除的客户端因果猜测、旧 branch layout、独立工作气泡或 CRT stack。
