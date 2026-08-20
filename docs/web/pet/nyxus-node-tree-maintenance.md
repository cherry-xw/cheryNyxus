# Nyxus 节点树维护、迁移与回滚

## 模块边界

- `web/src/stores/chats/rootTimeline.ts` 只维护 canonical snapshot、root transient plane 和 patch 原子应用；revision gap 由 store 触发 resync。
- `web/src/features/pets/nyxus/graph/executionGraph.ts` 只把显式节点、边和 active run facts 投影为 UI-neutral graph，不读取数据库结构，不按正文、时间相邻或角色名称推断关系。`projectActiveTurnNodes` 的 transient 锚点：`dispatch`/`spawn` 节点优先作为其 `target.chatId` 子 chat 的前驱（子 chat 流式回复从派发点连出），普通消息节点按 `createdAt` 取该 chat 最新（不依赖持久图数组遍历顺序）；同 chat 连续 stream 节点在单次投影内串联成链；子 chat 无任何持久/stream 节点时才 `?? start` 兜底。
- `web/src/features/pets/nyxus/graph/executionLayout.ts` 只处理稳定 lane、全局纵向顺序和坐标缓存；流式正文变化复用坐标，拓扑变化才重算。
- `web/src/features/pets/nyxus/graph/nodeSkins.ts`、`edgeStyles.ts`、`termination.ts` 和 `web/src/styles/overlayLayers.ts` 分别集中 skin、edge、termination 文案和 overlay 层级。
- `MessageBranchTree.vue` 只编排画布、HTML overlay、输入和可访问性交互，不重新构造 canonical relation。
- `MessageBranchTree.vue` 向 Pixi 同步场景时，去重签名必须覆盖节点坐标及边的起点、终点和路由坐标；切换折叠或同行布局即使不改变节点 ID，也必须把新的几何位置提交给 GPU 渲染器。
- 同行布局按 lane 感知的最早可用行压缩，但任何直接连线的目标节点都必须比来源节点至少低一行；该规则不区分同列、跨列、派遣、分叉、返回或汇合。只有彼此之间不存在因果约束的节点才允许同行，禁止渲染水平因果连线。
- 极致压缩的参与者过程组不得跨越任何保留的可见节点；用户输入、最终回复和分支锚点既是展示边界也是折叠区间边界，避免过程组同时位于同一锚点的前后两侧而形成投影环。
- 工作台右侧工具栏的运行控制只消费 root snapshot `controlState` 和 `activeRuns`；运行时显示暂停，无运行且暂停集有剩余目标时同槽切换为继续。
- 工作台展示任务聚合快照时，暂停任务树与暂停全部分支均只由该任务 `activeRuns` 中的 `running/waiting` 事实控制；所有分支结束后不得继续读取单会话缓存运行态来显示暂停按钮。

## 展示语义

- 节点树面向用户描述任务过程，不直接暴露 `kind`、会话 ID、方向或因果 ID 等图谱内部字段。
- 任务可包含多个根分支，但 `activeBranchId` 指向唯一活动主干。活动主干固定占 lane 0；从分叉点被替换的旧主干后缀移动到 +1 或 -1，其他 continuation/detail 分支按稳定顺序继续向外扩展。共享前缀保持在中轴，不能仅按 chatId 给整条旧会话固定 lane。
- `fork-continuation`/`fork-detail` 是合法的持久边；其目标分支必须获得区别于来源参与者及既有分支的独立 lane。任务聚合图中的 continuation/detail 分支允许各自的用户入口，不得按“用户直接输入子 Agent”报错。
- 局部精简先按 `branchId + sourceChatId` 分区；参与者档先按主分支切轮次再按参与者折叠；极简档保留所有主分支的分叉点、每轮用户输入和最终回复。禁止跨分支按全图时间顺序合并。
- 细节解释分支作为独立参与者；运行中只展开它自身所在轮次，不解除其他分支的折叠。
- 工作台切入任务投影后以任务级 timeline 查询轮询刷新；组件卸载或离开任务投影时必须清理轮询，异步返回只能更新发起请求时仍处于选中状态的会话。
- Agent 消息节点优先显示 `roleType` 角色名；缺失时，根会话降级为“核心节点”，子会话降级为“协作节点”。界面文案不得出现 `Agent`、`Fold`、`Spawn` 等内部英文类型名。
- 展示名称固定为：`start=任务起点`、`fold=过程组`、`tool-batch=工具执行`、`return=结果返回`、`dispatch=任务委派`、`spawn=创建协作节点`、`system=系统事件`、`input=我的指令`、`unknown=未识别节点`。
- 第三档参与者折叠保留每轮的用户消息、派遣节点、各任务入口、结果返回、返回汇合点和最终回复；主节点与各协作节点的其余执行过程必须按各自分支生成独立过程组，不得跨越派遣、返回或汇合边界合并。
- 任一折叠档位都不得把单个节点包装成“过程组”；一个折叠范围至少包含两个可展示成员，否则保留 canonical 节点。
- 横向 lane 间距固定为 110px；节点标题按紧凑宽度省略，完整信息继续由节点详情承载。该收窄仅为后续侧边信息区留出空间，本阶段不新增侧边区域。
- 参与者折叠只依据 canonical graph 的 `spawn`、`dispatch` 和 `return-continuation` 显式边识别任务入口与返回汇合点，不按正文、时间邻近或角色名称猜测关系。
- 工具节点仅从 `sense.tools` 元数据读取图标和中文名称。单工具显示工具名，多工具显示“工具执行 · N 项”；元数据缺失时降级为通用图标和“工具”，不暴露内部工具 key。
- 同一次 assistant 响应拆出的 `message` 与 `tool-batch` 以显式 `sourceMessageId` 投影为一个工具视觉节点；模型 thinking/content 位于工具区上方，多工具随后显示页签，单工具直接显示详情。不得依靠时间相邻或正文内容配对，且不得因此改变 canonical facts、工具批次 ID 或 spawn/continue 拓扑。
- 说明区只展示大模型返回数据中的 `description` / `explanation` 等真实字段。禁止根据工具元数据、节点类型或前端经验生成说明和占位文案；真实说明不存在时不渲染说明区。
- 节点悬浮卡片采用高密度“固定标题 → 固定工具页签 → 可滚动正文”的结构。正文包含真实说明、类型化指令/参数和结果；文件、询问等特殊工具也必须在这套新版正文内使用原生分区展示，不得嵌入或复用聊天消息的旧工具卡片。
- 卡片根容器禁止滚动；仅正文区域在受视口高度限制时纵向滚动。标题、工具页签和操作按钮始终可见，正文中的代码、表格、结果和终止提示不得产生嵌套纵向滚动条。
- 1920×1080 浏览器基线下，普通详情面板宽度约 480px、可用高度不超过 640px 或 `100vh - 96px`；标题约 38px、页签约 32px，视觉使用 3–4px 小圆角、细分隔线和 6–10px 紧凑间距。
- 指令参数按真实数据类型展示：`command` 使用终端指令块，`path` 使用路径条，`url` 使用地址条，`task` / `prompt` / `query` / `instruction` 使用主要指令区，短标量使用紧凑参数项，对象和数组使用层级化文本。
- 多工具页签只承载图标和工具名称，不展示运行状态；每次调用的执行中、已完成或失败状态必须放在当前页签的内容区，避免状态与工具名称争抢宽度。
- 页签内的图标使用固定尺寸容器，与工具名称单行垂直居中；字形、emoji 或图标宽度不得改变文字基线和页签高度。
- 内容区字段统一采用“标题在上、正文在下”的纵向层级，不再使用标题与正文左右并排的紧凑变体。
- 可复制内容的操作入口归属正文容器：复制图标固定在内容块内侧，标题行不放操作按钮；单行和多行内容使用同一容器规则，文本仍可选择且换行语义不变。
- 文件内容、命令输出、提示词和通用工具结果必须保留原始换行；不得将普通文本中的换行符折叠为空格。
- `ask_user_question` 在历史详情中使用只读的专用视图：显示题目、单选/多选类型、全部选项及说明、已选状态，并将“其他”自由文本作为独立补充回答展示，不直接暴露原始 JSON。
- `search_codebase` 在新版正文中展示搜索方式、搜索内容、搜索范围和真实搜索配置，并将返回文本解析为“汇总 + 文件路径/行号 + 匹配正文”的原生结果列表；空结果和错误保留后端真实提示，完整结果可从内容块复制。
- `skill` 在新版正文中分离技能名称和实际技能指令：移除返回值中重复的激活包装文案，显示真实指令行数并保留 Markdown 与换行；技能不存在或加载失败时显示真实错误，不嵌入聊天消息的旧技能卡片。
- 高频悬浮反馈仅用于空间连续性和状态辨识：进入/退出使用不超过 200ms 的 `opacity/transform`，内容切换使用短淡入；禁止正文持续位移或颗粒抖动。应用不跟随 `prefers-reduced-motion`（见 `docs/web/settings.md` 动效降级约定），动效恒开。
- 暂停后发新消息且存在被中止子 Agent 时，节点树显示一条稳定 ID 的“系统事件”；不得伪装成用户消息，重试、刷新和回放不得重复生成。
- 运行 CRT 与节点详情共用石墨终端色板：深石墨背景、灰白正文、青色交互强调、琥珀运行态、绿色完成态、红色失败态。禁止整卡扫描线、循环边框、噪点位移和逐字输出；流式状态仅允许小状态点低幅反馈，正文页签切换只做短淡入。
- 运行 CRT 默认尺寸较旧版缩小约 15%，标题栏可拖动。CRT 默认以标题栏贴靠所属节点左右侧且不做窗口间避碰；多个 CRT 可重叠，点击窗口提升其局部层级。用户手动拖动的位置保留到下一次节点树 pan/zoom 或布局变化，随后重新吸附到所属节点旁；无需为了让正文底部留在视口内而推远窗口。坐标与层级只保留到当前工作台组件销毁。
- 普通消息提交、流式节点追加和视口 ResizeObserver 不得自动修改用户当前相机；只有初次挂载、切根、切换折叠/布局档位和显式复位允许 fit。
- 工作台历史入口在任务含分支时固定打开 `activeBranchId`；标题栏按活动主干、其他继续分支、解释分支排序。`original` 仅表示最初分支，不再永久标记为“主流程”。用户可把任一 original/continuation 直接设为主干；该操作只切换身份与节点树 lane，不复制消息或启动执行。分支标题取该分支第一条用户消息。
- continuation 的首条用户消息之前必须展示一个持久“结果汇总”系统节点：其前方由来源锚点的 `fork-continuation` 连线接入，继承的已完成任务返回连入该节点；后方再连接新用户消息。迟到的继承任务结果分别显示为独立返回节点并连接到当前活动主干，不合并进旧汇总节点。

## 性能基线

`web/test/nyxus/graph/performanceRecovery.test.ts` 使用 2,000 节点、1,999 边、8 个并发 CRT 和连续 120 次流式正文更新：

- 静态拓扑只允许一次完整 layout；120 次正文更新不得增加重算次数。
- 120 次增量刷新预算为 1,500ms（CI 硬门禁）；真实浏览器要求持续操作无明显掉帧、跳位或持续内存增长。
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
