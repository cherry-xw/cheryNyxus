# 主 Agent 运行流程图技术设计

状态：待实施设计。产品节点、样式与布局规则由[需求说明](requirements.md)唯一维护；执行任务见[任务入口](README.md)。下面明确区分已经核对的代码事实和拟新增能力。

## 1. 已核对的实现依据

| 主题 | 代码入口与关键符号 | 设计必须遵循的事实 |
| --- | --- | --- |
| 洋葱链 | [middleware/index.ts](../../../src/agent/middleware/index.ts) `defaultHandlers` | 外到内为 checkpoint、sense、retry、chat；Loop 在外部控制重复执行 |
| Loop | [loop.ts](../../../src/agent/middleware/loop.ts) `createLoopHandler` | 继续、yield、park、abort、失败与循环上限不是同一出口 |
| Agent 创建 | [builder.ts](../../../src/agent/builder.ts) `AgentBuilder`；[runtime.ts](../../../src/service/chat/runtime.ts) `ensureChat` | 构建/配置/初始化分离，既有会话可使用冻结提示词恢复 |
| 模型阶段 | [chat.ts](../../../src/agent/middleware/chat.ts) `chatMiddleware`、`handleStream`、`handleNonStream` | Chat 包含媒体处理、消息适配和请求准备；进入 Chat 不等于 HTTP 已发出 |
| 重试 | [retry.ts](../../../src/agent/middleware/retry.ts) `retryMiddleware` | 当前最多 5 次尝试，含首次；可恢复错误退避，abort 不重试 |
| 工具批次 | [tool.ts](../../../src/agent/middleware/tool.ts) `senseMiddleware`、`executeCollectedCalls`、`executeResumePending` | 先收齐调用，再执行；自动工具顺序执行，审批工具逐个等待并执行；续接可绕过模型和重试 |
| 指令 | [autoCompact.ts](../../../src/service/chat/autoCompact.ts) `injectCommands`；[loadCommand.ts](../../../src/agent/prompt/loadCommand.ts) | 内置指令正文在 send 预检中加载为额外输入；不能把文本注入当作任务已完成 |
| 资源计数 | [prompt/index.ts](../../../src/agent/prompt/index.ts) `buildSystemPromptSegments`、`buildFirstSystemPrompt` | 共用 `buildPromptPieces`；已有 memory/skills 数量来源，可以复用而非解析自由文本 |
| 计数现状限制 | [contextUsage.ts](../../../src/service/chat/contextUsage.ts) `computeContextBreakdown`；[promptSnapshot.ts](../../../src/service/chat/promptSnapshot.ts) `buildLivePromptSnapshot` | 前者会重新读取当前资源；冻结快照当前只保存提示词/工具等，不能假定已有准确的冻结计数 |
| 技能正文 | [skill.ts](../../../src/agent/sense/skill.ts)；[loadSkill.ts](../../../src/agent/prompt/loadSkill.ts) `getSkillRealtime`、`formatSkillActivationContent` | 正文由工具实时加载；未找到也可能返回普通内容而不抛异常，不能用 Promise 成功判定加载成功 |
| 压缩裁剪 | [messageJournal.ts](../../../src/core/middleware/messageJournal.ts) `compactToLatestSummary`；[core/middleware/index.ts](../../../src/core/middleware/index.ts) `AgentSession.send` | pipeline 返回后才裁剪为 system 加最近摘要；不是创建新 Agent，不是数据库删除 |
| 冷恢复 | [runtime.ts](../../../src/service/chat/runtime.ts) `loadHistory` | 从最近摘要与其后的持久消息重建；跨配置纪元不代表丢弃对话历史 |
| 历史代际 | [generations.ts](../../../src/service/chat/generations.ts) `computeGenerations`、`detectBoundaries` | 现有代际依据 `context_compaction` 消息推导；该标志单独不能证明内存裁剪已生效 |
| 派发与回传 | [spawn.ts](../../../src/agent/sense/spawn.ts)、[wake.ts](../../../src/service/chat/wake.ts)、[wakeScheduler.ts](../../../src/service/chat/wakeScheduler.ts) | 派发、子结束、回传入父上下文、唤醒是不同事实；按实际调度决定等待 |
| Hook | [dispatch.ts](../../../src/agent/hooks/dispatch.ts) `dispatch`；[registry.ts](../../../src/agent/hooks/registry.ts) `loadHookRegistry` | 使用实际生效注册表；部分事件仍为 stub；部分 Provider 才接请求前 Hook |
| 长期结果 | [chat.ts](../../../src/db/chat.ts) `MessageRow`；[executionGraph.ts](../../../src/db/executionGraph.ts) `upsertExecutionNode`、`annotateExecutionNode` | messages 与 execution_nodes/edges 可长期读取；节点 JSON 更新保留已有附注 |
| 运行/终止事实 | [executionFacts.ts](../../../src/service/chat/executionFacts.ts) `recordRunFact`、`recordTerminationFact` | 已有持久化运行、工具归属与终止事实，应复用 |
| 现有短期状态 | [currentState.ts](../../../src/service/chat/currentState.ts) `rebuildExecutionSteps` | model/tool 步骤依赖近期 journal，不能作为长期回放唯一来源 |
| 短期日志 | [delivery.ts](../../../src/db/delivery.ts) `RETENTION_MS` | request journal 与 chat/root 事件日志有 24 小时清理；后两者按会话/根写入时清理，并有数量限制 |
| 前端宿主 | [WorkbenchDialog.vue](../../../web/src/features/agent/workbench/WorkbenchDialog.vue)、[useWorkbenchViewPreferences.ts](../../../web/src/features/agent/workbench/useWorkbenchViewPreferences.ts) | `paperMode` 派生横向信号/纵向卡片；流程开关必须独立 |

短期 journal 清理不等于消息、节点树历史被删除；逐 token `turn.delta` 等传输片段本身也不是长期 journal 回放的基础。本任务不更改现有清理逻辑。

## 2. 渲染选型

采用“既有 Pixi 消息树 + 独立 Vue 节点与 SVG 连线”。新增图是数量受控、布局固定的只读流程，不需要通用图编辑器。

| 方案 | 适用性 | 本期结论 |
| --- | --- | --- |
| Vue 组件 + SVG 连线 | 少量节点、原生文本/图标、明确布局、主题与辅助功能容易保持 | 采用；连线依据固定轨道和节点锚点计算 |
| Vue Flow | Vue 成熟节点图方案，适合拖拽、端口、编辑、复杂缩放与交互 | 本期不新增依赖；以后需求确有编辑器能力再评估 |
| AntV G6 等图框架 | 复杂自动布局、大图和专门图交互 | 本期节点数量与交互不足以需要 |
| Mermaid | 文档中的静态架构说明 | 只用于文档示意，不作为实时工作台渲染器 |
| 手写 Canvas/Pixi 新图 | 可做大量绘制，但需额外处理文字、命中、滚动与辅助功能 | 不采用第二套绘制引擎 |
| 两图放同一 Canvas | 需要合并相机、布局、输入和销毁生命周期 | 不采用；会扩大消息树改造范围 |

两个独立区域不等于必须两张 Canvas。既有树保留 Pixi Canvas，新图为 DOM/SVG；不把流程节点混入 `ExecutionGraphPixiRenderer` 的消息节点集合。

方向切换由同一份节点投影生成水平/竖直坐标。用 CSS Grid 管理区域，DOM 表示节点，SVG 只画路径。固定锚点避免每次状态更新重新测量所有节点；尺寸变化可以重算坐标，状态和数量变化不触发树布局。

动画仅需状态过渡与步进定时器。前端 `setTimeout` 或已有调度工具足以驱动回放，不新增动画库、不把业务状态绑定到动画完成回调。

## 3. 状态归属与代码边界

```text
Agent / Core 实际边界
        |
        v
service 主 Agent 流程观察器 --> 当前快照 --> 专用只读通知 --> 前端实时缓存

持久 messages + execution facts + frozen prompt
        |
        v
service 历史事实投影 --> 前端回放步骤 --> 播放器状态
                                           |
前端实时缓存 -------------------------------+--> 同一流程图组件
```

建议后端新增一个小型流程观察模块与一个历史投影模块，归 `src/service/chat/`；Agent/Core 只报告基础边界或通过注入的观察回调传出，不导入 service、WebSocket 或数据库。

前端新增 `web/src/features/agent/workbench/runtime-diagram/` 功能目录，承载图组件、调用行、状态映射和回放控制；RPC 包装继续归 `web/src/services/`。只有多处实际复用的缓存才进入现有 store，不为单图另建通用框架。

主 Agent 身份由后端的 chat 父子归属、所选主会话与既有 canonical actor 确定，不能按消息文本、角色名或“谁最近在输出”猜测。节点树选中子节点不切换本图的主 Agent；切换实际主会话/分支根时才切观察对象。

## 4. 拟新增 API

以下方法名为本方案的拟用 wire 名称，尚未注册。复用项目 WebSocket RPC、schema、错误与连接鉴权机制，不另建 HTTP 服务。类型最终集中到 `packages/protocol/src/`，同步 service 与前端绑定。

### 4.1 方法与通知

| 名称 | 请求 | 响应/职责 |
| --- | --- | --- |
| `chat.workflow.open` | `chatId`、本窗口稳定的 `observerId` | 校验目标为主 Agent；注册本连接的观察租约，返回 `subscriptionId`、`streamId`、当前完整快照 |
| `chat.workflow.close` | `subscriptionId` | 幂等释放本连接持有的流程订阅；不关闭 chat、原 timeline 订阅或其他窗口 |
| `chat.workflow.history` | `chatId`、可选 `contextStageId`、`cursor`、受限 `limit` | 只读返回阶段索引及所选阶段的主 Agent 历史事实页、下一页游标和完整性信息 |
| `workflow.updated` | 服务端通知 | `subscriptionId`、`streamId`、单调 `revision` 和最新完整流程快照 |

`open` 对同一连接、observerId 和 chatId 幂等；换 chatId 必须先释放旧租约。服务端校验 close 所有权，不能通过别人的 ID 取消订阅。连接断开自动回收本连接租约。

历史读取不创建 Agent、激活纪元、恢复运行或写入配置。不存在、被删除、无权限或不是主 Agent 的目标沿用项目错误体系明确返回；不把子 chat 悄悄转换成不同的观察目标。

### 4.2 最小快照字段

| 字段组 | 拟包含内容 | 用途 |
| --- | --- | --- |
| 身份与版本 | `chatId`、`rootChatId`、`epochId?`、`contextStageId`、`runId?`、`revision` | 区分会话、配置快照、压缩阶段和本次执行 |
| 当前活动 | `status`、`waitReason?`、`activeNodeId?`、`phaseLabel?`、`iteration?`、`attempt?` | 需求中的业务状态及当前节点；可选值缺失不补造 |
| 当轮轨迹 | `visitedNodeIds`、条件节点的参与标志 | 轻量已完成描边，不是无限增长的逐步日志 |
| 当前批次 | `batchId`、`complete`、调用 ID/名称/状态、可选短结果、活动调用 ID | 完整清单先于执行；调用 ID 去重 |
| 未返派发 | 派发/调用关联 ID、角色短名、派发结果、回传状态 | 主 Agent 边界等待；无子 Agent 内部详情 |
| 资源摘要 | 冻结的 memory/skills 计数、当前 loadedSkillCount、各自已知/不完整标记 | 区分未知与真实 0 |
| Hook 挂载 | 节点或调用 ID 对应 `before`/`after` 标记 | 配置关系，不携带执行记录 |
| 质量信息 | 当前短阶段是否已知、历史证据是否完整 | 中途打开/旧历史可诚实降级 |

新观察流的 `streamId` 用于区分连接恢复或观察器重建前后的版本空间；前端只接受当前订阅、streamId、chatId 匹配且 revision 更新的快照，避免旧帧覆盖新会话。

选择完整小快照而不是另一套 delta 操作日志。快照只包含基础节点、当前批次和未返回派发，无消息全文；每个语义边界更新，不按 token 更新。大批次遵从既有传输大小限制，需要分页时必须保持调用清单可遍历，不能静默截掉当前调用。

### 4.3 开关、恢复与竞态

1. 默认无流程订阅，无专用流程事件写库、通知序列化或图动画。已有业务结果仍按原链路保存，少量最终结果附注与展示开关无关。
2. 第一个观察者打开后才启用主 Agent 的细分边界投影；同一主 Agent 多个窗口复用一份当前投影，各有独立租约。
3. 打开时先注册更新接收，再读取带 revision 的快照；前端用版本合并。不能在“取快照”与“开始接收”之间漏状态。
4. 中途打开优先读取已有 active run、model/tool steps、pending interaction 和派发/回传事实。细分阶段不能确定则返回空 activeNodeId 与运行状态，下一真实边界补齐，不能回溯伪造短阶段。
5. 最后一个观察者关闭后释放专用投影缓存和观察绑定，不停止业务任务。重新打开以现有状态补快照。
6. 断线旧 stream 失效；重连重新 open 获取快照，不追读本功能的丢失事件。历史回放另从长期结果构建。
7. 最小化保留租约可继续维护很小的最新缓存，但停止动画；组件销毁、窗口关闭和主会话切换回收租约与定时器。
8. 专用订阅不能登记为 send 的 owner，也不能因观察窗口断开触发审批 park 或 Agent abort；复用连接管理的回收机制时保持这一边界。
9. 流程通知直接走观察者投递，不交给 `appendChatEvent`/`prepareChatEventForDelivery` 形成另一套 chat/root journal。观察回调异常不得阻断 Agent；图状态失效后可重新取快照。

只读/归档主会话可以返回历史摘要快照，不创建活跃观察绑定。使用现有会话生命周期通知使已删除目标退出图视图；不为本功能另建删除广播系统。

## 5. 运行边界映射

| 实际边界 | 流程更新 | 不能推导的内容 |
| --- | --- | --- |
| 首次提示词构建、冻结快照恢复 | `context` 构建/恢复/就绪，资源快照 | 每轮重新构建提示词 |
| send 预检指令加载/入队 | `command` 名称与加载/注入结果 | 指令要求的任务已完成 |
| Checkpoint 消费输入 | `input`，标明输入类型 | 仅依据新消息到达时间判定已被模型读取 |
| Chat 准备适配 | `model: preparing` | HTTP 已发送 |
| 调用 `llmAdapter.chat/chatStream` 并等待 | `model: calling` | 所有 Provider 的网络阶段完全一致；界面用“调用中” |
| 响应处理/流结束 | `model: responding/completed` | 每个 token 一个流程事件 |
| 进入真实退避、下一次尝试 | `retry` 与实际 attempt | 只有最终错误时回填出所有历史尝试 |
| Phase 1 收齐 calls | 原子发布 `batch.complete=true` 与全部调用行 | 未收齐前执行未来未知的调用 |
| doExecuteSense/审批/返回边界 | 对应调用的 running、waitReason、result | 列表顺序必然等于实际执行顺序 |
| resume pending | `input -> tools`，沿用调用归属 | 一定重新调用模型 |
| Checkpoint 汇总、输出 effect | `checkpoint` | 该节点等同 SQL 事务已提交 |
| Loop 判断继续或退出 | `decision`，结合既有 run/wait/termination 投影总体状态 | done 或生成器退出必然任务完成 |
| 子派发与 wake 接入 | 更新派发工具行或待返回行；真正接入输入再激活 `input` | 子 Agent 内部状态，或收到回传必定唤醒 |
| `compactToLatestSummary` 实际改变有效上下文 | `compact` 生效，切 contextStageId，重新投影资源与调用参与 | `auto_compacted` 通知、`contextCompaction` 标签等同成功裁剪 |

观测仅加在已有基础边界，不改中间件顺序、重试次数、工具调度、审批或唤醒策略。若普通模型调用的准备与调用非常快，实时图可直接呈现最新阶段；回放也无需虚构未保留的准备阶段。

## 6. 最小持久化调整

### 6.1 复用结果，而非记录全过程

长期回放主来源仍为 messages、execution_nodes/edges、工具归属、终止事实和冻结提示词。以下只在现有 JSON 结果中增加必要的可选信息，不新增表、不保存逐阶段数组、不新增准确时钟要求。

| 落点 | 最小拟新增信息 | 产生时机与目的 |
| --- | --- | --- |
| `chat_epoch_snapshots.prompt_snapshot_json` | 可选 `resourceSummary: { memoryCount, skillCount }` | 与真实提示词使用同一次结构化构建结果，一起冻结；禁止后来用磁盘最新计数冒充 |
| 技能对应持久执行节点 `payload_json` | 可选 `workflow.skillActivation: { name, bodyLoaded }` | 最终技能正文确实进入有效工具结果时附注，解决“返回 Error 文本也算成功”的歧义 |
| 压缩摘要对应执行节点 `payload_json` | 可选 `workflow.compaction: { applied: true, summaryMessageId }` | 实际裁剪生效后附注；提供可确认的阶段边界 |
| 输入对应执行节点 `payload_json` | 必要时增加 `workflow.commands` 的名称与加载/注入结果 | 自动指令 token 或临时正文未落库时，只保存简短处理结果 |

先核对现有结构化字段是否已经足以表达，能复用则不写重复字段。`workflow` 为一小段结果附注，不允许塞入 Hook、逐 token 内容、各内部阶段或完整参数。

execution_nodes 现有 `upsertExecutionNode` 会保留先前附注，但嵌套 `workflow` 更新仍须明确合并，不能被后续投影覆盖。补充类型/schema、读取投影、历史分页、恢复与删除测试；若某个恢复入口真的重建并丢弃附注，必须修复该入口的保留方式，不能以新建追踪表规避。

压缩附注在 service 观察到裁剪实际完成后写入已有摘要节点。Core 可以返回“实际采用的摘要 ID/是否改变上下文”等极小结果，service 负责持久化。重复采用同一摘要幂等，不因重发通知切两次阶段。

进程在“裁剪生效”和“结果附注写入”之间崩溃时，不宣称已有精确记录：冷恢复依据 `loadHistory` 实际采用的摘要确认当前阶段；过去那次发生时刻仍为未确认。只读历史查询不得为了补标志触发上下文重建。

最终结果附注可以在图关闭时写入，和普通结果保存一致；这不意味着开启细粒度实时追踪。图开关只控制观察、推送与渲染。

### 6.2 计数与阶段身份

- `contextStageId` 由主 chatId 与最近实际采用的压缩摘要消息 ID 组成；首次阶段使用稳定起点标识。复用现有代际的摘要关联，不另建自增阶段表。
- `epochId` 是配置边界，独立传递，不用来替代压缩阶段。纪元切换重新采用冻结资源摘要，技能正文按实际保留消息重算。
- 新建快照的计数从 `buildPromptPieces` 同源结果提取；不能先构建提示词，再独立扫描一次目录计算另一个时间点的数字。
- M 从当前有效上下文中已确认的 skillActivation 去重获得，排除撤回、裁剪与不再包含正文的替换；不能只把历史工具成功次数累加。
- 缺失旧快照计数不回写当前配置值。旧正文只有能通过既有结构化结果或可靠的技能加载格式解析确认时才计入，否则标记不完整。
- 每次新技能返回不要求扫描整个数据库；维护当前有效调用集合，压缩/恢复/撤回等边界再重建。

### 6.3 旧数据兼容

旧记录没有新字段仍可回放模型结果、工具结果和派发/回传主路径。只有 `context_compaction` 标签的旧摘要可作为“重建阶段”候选，必须标明依据不完整；不能在实时压缩请求尚未完成时据此清空资源。

已有长期节点关系和终止事实优先于短期事件；`original_content` 只用于必要的已存在结果还原，不作为未经关联的技能正文猜测入口。不改变消息内容、不回填伪造执行顺序、不扫描更新全库。

## 7. 历史投影与前端回放

后端负责主 Agent 归属、批次/调用关系、子回传关系、结果状态和压缩证据的归一化；前端只负责把已确定的事实映射为基础节点和播放顺序，不复制 canonical timeline 的业务归属推断。

| 长期事实 | 前端回放步骤 | 证据不足时 |
| --- | --- | --- |
| 主 Agent 用户输入或明确续接事实 | 输入接入 | 不把子输入当主输入 |
| 已持久化的内置指令处理摘要 | 执行指令，随后输入接入 | 仅有正文 token 时最多表示请求过该指令，不标记加载成功 |
| 主 Agent 模型响应节点 | 模型调用、响应结果 | 没有开始时刻也可播放一次逻辑调用；不伪造请求准备或重试 |
| assistant 调用集合与工具 owner | 批次清单，随后每项调用/结果 | 不能按同名字符串合并；缺失项使用未知结果 |
| 工具结果与终止/拒绝事实 | 完成、失败、拒绝、取消或未完成 | 内容存在不代表成功，不通过 Error 文本泛化所有工具错误 |
| spawn 关联、父会话接收 child_return | 派发、返回 | 只有派发不补“已返回”；不播放 child_output 内部模型步骤 |
| 已确认的继续/暂停/终止事实 | 循环判断、等待或本轮结果 | 仅无新消息不能推定暂停或结束 |
| 已确认的压缩生效附注 | 压缩生效与阶段转换 | 旧摘要候选使用重建质量，不假装精确确认 |

流程图中的初始化、记录汇总、Hook 等不一定在旧历史中有独立事实。可以画静态结构，不要求逐个播放；不得为了让箭头看起来连贯就把这些节点涂成历史完成状态。

排序优先使用已有 orderKey 与因果关系；工具执行有实际顺序事实时遵从它。只有结果、没有严格执行顺序的旧批次按稳定调用顺序播放，并返回 `orderQuality=reconstructed`。时间仅作已有信息的辅助，不要求真实耗时回放。

历史 RPC 按阶段和 cursor 返回，第一页同时返回足够的阶段索引；每一页声明下一游标、是否到末尾和固定的历史上界。开始回放前至少加载一个完整逻辑批次；批次跨页时等待补齐，不能只展示半个批次就开始执行动画。

前端播放器只维护 `stageId / frames / cursor / playing / speed / historyBoundary`。回放帧由同一 renderer 消费；实时 snapshot 独立缓存。跳转通过确定性 reducer 恢复目标步骤，取消旧计时器后再调度，卸载时清理。

基础节点规模小，不引入独立事件溯源框架或每步完整状态持久化。大阶段分批加载、按需构造帧；用户定位到尚未载入位置时先加载并给出忙状态，不把它误认为播放结束。

## 8. Hook 标记计算

后端使用当前已发布的 Hook 注册表和现有 matcher 规则，输出每个可见节点的前/后挂载关系。不得读原始候选配置冒充已经生效配置，也不通过执行 handler 或记录它的结果决定标记。

请求前标记需同时满足真实 Provider 接线和适用注册项；例如不能因为配置了 `PreLLMRequest` 就给所有 Provider 显示该挂载。`UserPromptSubmit`、`PostLLMResponse`、`Stop` 按 Chat 的实际接线归入模型节点前/后位置。工具按名称匹配。

运行时 `if` 可能依赖尚未产生的 payload，此时只表达“条件挂载存在”，不做精细命中判断。省略 stub 的 Session/Compact 事件。历史无挂载快照就省略，不为 Hook 单独新增存储。

## 9. 布局集成与性能边界

空间数值由[需求说明](requirements.md#9-空间分配与模式组合)维护，实现只建立一套容器尺寸计算。工作台负责流程区与消息树区的外层分配，消息树仍拥有卡片选择及树相机。

横向布局把流程区放在树上方；竖向布局把“卡片+树”组合区与右流程栏并排，组合区内部使用明确卡片/树轨道。修改 [MessageBranchTree.styles.less](../../../web/src/features/pets/nyxus/components/MessageBranchTree.styles.less) 的百分比视口与 [NodePaperStack.styles.less](../../../web/src/features/pets/nyxus/components/NodePaperStack.styles.less) 的绝对定位时，使用同源轨道尺寸，不搬走卡片业务逻辑。

输入区展开时预留高度，尺寸变化沿现有容器 resize 路径通知 Pixi，不能调用强制 fit 作为状态更新的副作用。Lite 视图不包含本功能；回到节点树工作台后才显示对应入口，不扩展 MCU Lite UI。

实时只投影最后状态与当轮有限参与集合，不积压回放队列；当前批次和待返回派发是唯一可能增长的动态列表。先使用有界可视列表和内部滚动，不提前引入虚拟图引擎。发生大量列表性能问题后，再针对实际列表评估复用既有虚拟列表能力。

## 10. 权威文档迁移与验证

T01 实施前的文档归属如下，新增正式专题时明确“目标契约/尚未实现”，实现完成后改为现行契约：

| 内容 | 权威归属 |
| --- | --- |
| workflow RPC、通知字段和版本规则 | `docs/shared/protocol/` 的专用专题，协议索引与 websocket 主文档链接 |
| 主 Agent/子返回、压缩阶段与配置纪元关系 | 现有 `docs/shared/architecture/` 主题增补对应规则，避免重复状态机 |
| 观察边界、结果附注写者与恢复方式 | `docs/backend/service/` 与必要的 Agent/Core/DB 模块入口，协议字段只链接 |
| 工作台图、空间与视觉行为 | `docs/frontend/` 的工作台专题，Pet/工作台入口链接 |
| 跨会话实施步骤 | 本任务目录；完成子任务按计划规范删除 |

代码改动前先完成受影响的权威文档更新。验证按任务入口的范围执行：重点覆盖结果事实、状态边界和隔离，不为每个颜色/图标创建镜像测试，也不让浏览器自动化越过项目的人工 UI 验证边界。
