# Agent 完整运行头部与 Vue Flow 结果节点树重建

**文档创建时间：** 2026-09-09T01:24:47+08:00（按首次 Git 收录时间补录，实际创建时间未记录）

状态：执行中。T13 投影边界、T14 结果节点树、T15 完整头部、T18 布局整理、T16 工作台接线和 T17 官网参照动效均已完成，下一步为 T07 综合验证。复杂度 5/5：沿用现有跨端事实与新版节点逻辑，完成路径动效、Morphicons 状态图标、实时 CRT 与节点能力视觉系统，并保证当前卡牌模式不受影响。各小任务开发前按项目规则确认执行者，不自动沿用其他任务的执行授权，不分配子 Agent。

## 目标与最新决定

- 头部必须是有独立步骤节点、端口、条件分支和循环回边的完整流程图，不能是平铺功能块。
- 同一 Vue Flow 画布连续生长，结果树呈现消息、工具、分支、派发、返回和过程组；内部执行步骤只在头部与步骤详情查看。
- 节点逻辑以当前新版为基础完善；节点树由 Vue Flow 重绘，不恢复旧 Pixi、旧节点外观或旧节点树逻辑。
- 当前卡牌模式完全冻结：样式、阅读、操作、开关、偏好及数据契约不动；新图适配其现有接口。
- 以 Vue Flow 官网 Animation and Layout / Transition 示例为动效参照，落实流程节点状态切换、沿路径移动的执行指示、连线与节点过渡、生长及回路反馈；不能用少量淡入替代完整动效交付。

完整目标、图示、状态证据、接口和视觉规则唯一维护在[前端展示契约](../../frontend/runtime-diagram.md)。本文件只维护拆分、恢复与验收登记。

## 当前偏差与复用边界

| 现有部分                                                     | 本轮处理                                         |
| ------------------------------------------------------------ | ------------------------------------------------ |
| journal、open/close/history、增量、gap、固定回放上界         | 保留；不新增 schema、RPC、后端埋点或迁移用户数据 |
| workflow reducer/controller、显式 anchor、分支身份           | 沿用新版；为两类投影拆分展示输入                 |
| graphModel 的 occurrence/内容混排                            | 改为结果树只投影业务内容，步骤驱动头部与只读详情 |
| WorkflowHeaderNode 的 sections/slots 网格                    | 替换为真正的 Vue Flow 子图及自定义边             |
| Vue Flow 单相机、当前工作台命令、租约                        | 复用；补齐新子图定位、错误降级与清理             |
| 当前卡牌模式、NyxusContentReader、NodePaperStack、readerOpen | 冻结；不以恢复旧树为由改动这些能力               |
| 旧 occurrence “逐步沉淀为历史节点”的动画                     | 改为官网参照的流程执行动效及真实业务结果生长     |
| 旧自动测试通过记录                                           | 保留历史事实，不认定新版完成；受影响验收全部重跑 |

工作区已有大量未提交实现，不执行整目录回滚、reset 或覆盖用户改动。提交 2a47402 仅供追溯，不能作为恢复目标。当前卡牌基线取本轮开发开始时的工作区，而不是该提交。

## 权威入口与实施规则

- [前端展示](../../frontend/runtime-diagram.md)：本次目标 owner。
- [workflow 协议](../../shared/protocol/workflow.md)与[后端观察](../../backend/service/workflow.md)：保留的事实与失败边界。
- [节点树维护](../../frontend/pet/nyxus-node-tree-maintenance.md)：其他调用方的现行实现与内容语义参考，不作为本轮旧渲染恢复清单。
- [前端规范](../../standards/frontend/README.md)、[动效规范](../../frontend/motion-standard.md)、[项目计划/验证政策](../../standards/global/project-documentation.md)：实现及验证前读取。
- 新小任务按 T13 → T14 → T15 → T18 → T16 → T17 → T07 串行执行；共享投影与工作台文件，不预设并行开发。每项完成后回写结果和最终回归目标，删除该独立子计划；旧已完成摘要保留事实，不重开旧任务。

## 新一轮台账

| ID  | 任务                                                      | 复杂度与依据                                | 依赖             | 状态   |
| --- | --------------------------------------------------------- | ------------------------------------------- | ---------------- | ------ |
| T13 | 新版投影边界与基线固化：纯投影、严格选择和卡牌基线        | 3：分离两类事实投影并锁定卡牌兼容接口       | 本轮规划         | 已完成 |
| T14 | Vue Flow 结果节点树重绘：新节点、事实边、稳定列和指针反馈 | 4：新版拓扑、节点/边呈现和增量布局          | T13（已完成）    | 已完成 |
| T15 | 完整运行头部流程图                                      | 4：条件回路、步骤匹配、共享工具链与头部避让 | T14              | 已完成 |
| T18 | 头部节点与连线路由整理                                  | 3：模板重排、端口分离与交叉控制             | T15              | 已完成 |
| T16 | 工作台、步骤详情与回放接线                              | 4：双事实流、卡牌兼容、多窗及恢复           | T18              | 已完成 |
| T17 | 官网参照动效与性能                                      | 5：路径动画、Morph 图标、实时 CRT、视觉系统和可取消生命周期 | T16 | 已完成 |
| T07 | [综合验证与用户验收](07-final-verification.md)            | 4：全量回归与真实视觉、交互、帧率验收       | T13–T18 全部完成 | 未开始 |

T07 是已经存在的最终验证文档，本轮同步重建清单、撤销旧勾选，仅作预登记；其他实现任务全部完成并删除独立文档后才进入。任何新增、删除或范围变化同步复核 T07 和[手动手册](verify/manual-final.md)。

## 当前恢复检查点

- 已锁定用户最新三项约束：Vue Flow 重绘、沿用新版节点逻辑、当前卡牌模式不动；官网动效效果是明确交付要求。
- T13 已完成纯投影边界和代码级验证；未启动浏览器/Electron，真实视觉仍集中在 T07。
- T17 已完成代码级实现与定向验证；恢复时直接进入 T07，不再恢复已删除的 T17 子计划。业务路径与显式定位由 GSAP 驱动，Morphicons 仅保留其库内共享 rAF；真实视觉与帧率结论仍由用户在 T07 验收。
- 后端 test/ 冻结，不运行或修改，不访问用户数据库；已有任务隔离 fixture 可用。
- 卡牌冻结意味着图端修复适配；若开发发现只有修改卡牌才能解决的问题，登记独立范围问题，不暗中扩展本轮。
- 图形与动效最终由用户按手册验收；代码通过不能替代“完整流程图”和“官网参照动效”的结论。
- T13 定向验证（2026-09-11）：workflowGraph、workflowController、workbenchReader、workflowProjectionBoundary 共 4 个文件 18 项通过；`pnpm web:type-check` 与受影响 ESLint 通过。该结论不代表 T14–T17 或最终验收通过。

## T14 完成摘要

- 结果树按 canonical 事实边计算稳定拓扑列，跨 lane 的派发、分支和返回只向后续列推进；正文增量不改变坐标，步骤 occurrence 不参与节点、边或布局。
- 结果节点改为紧凑图标主体与外置中文名称、状态、受控详情，消息、工具、派发/创建协作、返回、过程组和系统节点具有独立视觉类型；自定义 Vue Flow 事实边使用明确输入/输出端口、直角路径、方向箭头及必要的分叉/汇入标签。
- 画布内指针高亮参考 Vue Flow 官网首页的 Blobity 交互语义，以现有 GSAP 在图内跟随鼠标并按节点包围盒形变贴合；高亮层不接管命中，粗指针、触摸和 reduced 档降级为静态 hover/focus。
- workflowGraph、workflowProjectionBoundary、workbenchReader、executionGraph、executionGraphFixtures 共 5 个文件 42 项通过；`pnpm web:type-check`、受影响 ESLint、`pnpm web:build` 和 Impeccable 检测通过。paperStackIntegration 的 7 项中 6 项通过；唯一失败是冻结基线已有的 NodePaperStack 字体断言与样式不一致，T14 未修改冻结文件且 SHA-256 与 A07 基线完全一致，该全量失败保留到 T07 处理。

## T15 完成摘要

- `headerTemplate.ts` 提供 v2 固定尺寸模板，独立步骤、分组、端口和正交边落在同一 Vue Flow；主流程、重试、条件审批/拒绝/失败、Loop、协作与压缩路径齐全。静态回边经过几何验证，不穿过其他步骤主体；旧 header sections 网格及其专属样式已退役。
- `headerState.ts` 从完整 occurrence 集合按 run/iteration/attempt/call 投影，终态保留且新轮次/运行重置；未发生、未单独记录与记录不完整分别表达。工具按明确批次/消息/调用锚点列出，历史选择不随活动调用更新跳转。未归属运行的接收/唤醒事实单独可读，不猜测归属。
- `headerGraph.ts` 先固定业务结果位置，再以完整包围盒向右避让头部；只认 activeBranchId，旧无 task root 使用兼容头部，其他分支/子 Agent 保持简略。步骤说明具备键盘入口与关闭后焦点恢复；RuntimeDiagram 输出 `selectStep` / `selectHeaderScope`，T16 继续接实例详情和内容选择，T17 使用静态路径 `points` 与步骤内层实现动效。
- 2026-09-11 定向 Vitest：workflowHeaderTemplate、workflowHeaderState、workflowGraph、workflowController、workflowProjectionBoundary、workbenchReader、vueSfcSizeBudget 共 7 个文件 32 项通过；`pnpm web:type-check`、受影响 ESLint、`pnpm web:build`、Impeccable 静态检测、Plan lint 和文档链接检查通过。构建仅报告插件耗时提示。A07 五个冻结文件 SHA-256 全部与 T13 基线一致；未运行后端测试、访问用户数据库或启动图形界面。
- T07 继续验证真实箭头/回路可读性、跨主题窗口与键盘路径；T15 自动结论不替代 T16/T17 或最终人工验收。最终回归入口已写入展示契约与 T07，手册补充范围选择及未归属事实场景。

## T18 完成摘要

- 主流程向右展开，工具结果就近接入右侧记录区，压缩位于请求上方，协作位于执行右侧；失败分支按来源顺序分层汇入独立端口，下一轮与唤醒沿外围返回。没有改变业务路径、状态匹配、卡牌或结果历史位置。
- `headerNodePorts` 与 `headerHandleId` 统一端口偏移和边 endpoint，`headerEdgeLabelPoint` 为拥挤路段提供固定标签锚点，转换到世界坐标后由边组件消费。按同一几何统计规则，线段交叉从 20 降到 4，共线重叠从 10 降到 0；这只是几何改善证据，不代替真实视觉验收。
- 2026-09-11：workflowHeaderTemplate、workflowHeaderState、workflowGraph 共 3 文件 23 项通过，覆盖交叉预算、无共线、路由不穿节点、标签在对应路段且不遮挡节点、端口合法性和结果布局稳定；受影响 ESLint、含类型检查的 `pnpm web:build`、Impeccable 静态检测、Plan lint、文档链接及 diff 空白检查通过。构建仅报告插件耗时提示。
- T07 与手册已同步最新路由验收范围；T16/T17 继续使用预计算路径及标签位置。实机仍需确认剩余交叉不被误读成汇合点。

## T16 完成摘要

- 头部步骤改为打开画布内只读详情，按 chat/run/iteration/attempt/call 读取固定边界分页并展示重复实例、gap、legacy、加载、失败与重试状态；切 root、断线、最小化和卸载会取消过期详情请求，关闭详情恢复原步骤焦点。
- 详情只通过显式内容锚点定位现有 canonical 结果节点与 Nyxus 阅读器；缺失或跨会话锚点保持禁用并说明原因，不回退到最近内容。回放冻结进入时的 canonical timeline，随步骤游标裁切对应内容帧；历史不完整、存在 gap 或加载失败时保留完整 canonical 内容，返回实时重新取快照。
- 2026-09-11：workflowStepDetails、workflowController、workflowGraph、workflowHeaderState、workbenchReader 共 5 文件 28 项通过；完整 T16 定向集合 10 文件 52 项中 51 项通过，唯一失败仍是 T07 已登记的冻结卡片字体断言。`pnpm type-check:all`、受影响 ESLint、`pnpm web:build` 与 Impeccable 静态检测通过；检测器零项。五个冻结文件 SHA-256 与 T13 基线完全一致，未运行后端测试、访问用户数据库或启动图形界面。
- T07 与手册现有清单已覆盖步骤实例、严格锚点、固定回放、键盘、宽窄窗口、多窗口和当前审批隔离，无需新增重复检查项。T17 已完成路径与节点动效的代码级实现，T07 最终实机确认卡牌不变及完整交互。

## T17 完成摘要

- `motionPolicy.ts` 与 `useRuntimeMotion.ts` 改为消费头部模板路径和 canonical 结果增量：执行标记沿预计算折线/回边移动，节点与证据化连线联动；快速终态、分支并发和相同 occurrence 替换不会积压动画。仅已同步 live 增量播放，hydrate、回放、后台、最小化、断线、切 root 和卸载均清理；一次性与持续效果分别限制为 12 和 8。
- 头部步骤与结果节点通过 `workflowVisuals.ts` 使用稳定的能力图标、能力色和差异化边框结构；Morphicons 负责可中断状态图标 morph，reduced/低质量直接落到最新形态。等待、成功、失败、拒绝、中断等状态同步使用文字、图标和语义色，颜色不是唯一线索。
- 运行中的模型步骤只挂载 chat/run 匹配的最新 `activeTurns` CRT，正文/思考按现有 Markdown 节流渲染并自动跟随；终态、回放或停用时立即移除。每个步骤的 Info 独立按钮仅在图标 hover/focus/触摸点按时于节点上方显示简要说明，节点主体仍打开 T16 实例详情。
- 显式选择步骤锚点时创建不可交互关系边，光点沿确定性正交路径移动并通过 Vue Flow viewport 跟随到目标；无源/目标时直接定位，画布 pointer/wheel、root/回放/最小化和卸载会取消。普通实时增量不移动相机。
- 2026-09-11 定向 Vitest 12 个文件 62 项通过，覆盖路径证据、方向/转折、快速取消、结果生长、能力身份、live CRT 投影、投影边界、详情、回放、2k 性能恢复和 SFC 预算；`pnpm web:type-check`、受影响 ESLint、`pnpm web:build` 与 Impeccable 检测通过，检测器零项。构建仅报告 Vite 插件耗时提示。
- 五个冻结卡牌文件 SHA-256 与 T13 基线完全一致；未运行后端测试、访问用户数据库、启动图形界面或读取图片。代码级完成不代表达到官网实机效果，T07 继续验证真实视觉、交互和 p95 帧率。

## 既有完成结果的保留方式

D00、T01–T06、T08、T12、T09、T11、T10、T07-F1、T07-F2 的原完成事实保留。此前 T07 的自动清单曾于 2026-09-11 通过（Web 108 文件 601 项、workflow 隔离 5 文件 24 项等），但用户否定展示结果，因此不沿用其验收结论。以下 T08–T10 摘要仅描述上一轮实际交付；其中与最新契约冲突的目标由 T13–T17 修正，不能继续据此开发。

以下旧摘要中的“T07 需实机确认”等建议也已失效；本轮只执行重建后的 T07 与手动手册，不再验证 occurrence 沉淀成结果树节点。

## T13 完成摘要

- [`workflowProjection.ts`](../../../web/src/features/agent/workbench/runtime-diagram/workflowProjection.ts) 以纯 TypeScript 输出 `ResultTreeProjection`、`HeaderFlowProjection` 和 `WorkflowSceneProjection`；canonical 内容独立决定结果节点、事实边、顺序与 lane，occurrence 和观察 gap 只进入头部步骤状态。
- [`graphModel.ts`](../../../web/src/features/agent/workbench/runtime-diagram/graphModel.ts) 只适配 Vue Flow Node/Edge；内容、头部、步骤使用独立 ID 命名空间，`fact` 与 `template` 边语义分离。画布不再生成 occurrence 或未解析占位结果节点。
- 图到阅读器的选择经 `resolveWorkflowSceneSelection` 严格按 `sourceChatId` 与节点/`callId` 解析；错会话和缺失锚点明确不可用，不回退到其他会话或最近节点。
- 卡牌冻结基线取 HEAD `25c3c06a20760f343c776c38f7817ed8535a61b4` 上已有未提交工作区；T13 未修改 Nyxus public、readerProjection、NodePaperStack 组件/样式及工作台阅读偏好。精确 SHA-256 已登记到 T07 A07。
- 定向 Vitest 4 个文件 18 项、`pnpm web:type-check` 和受影响 ESLint 通过；新增回归覆盖单轮内容、多同名工具、分支/子返回、重复事实、缺失 anchor、观察 gap 和纯模型依赖边界。

## T08 完成摘要

- [workflow 契约](../../shared/protocol/workflow.md)是步骤身份、生命周期、内容引用、分支归属、增量同步、分页和 completeness 的唯一 owner。
- [后端观察](../../backend/service/workflow.md)锁定常驻 recorder、独立 journal、幂等/终态、写失败 gap、删除/归档和有界查询边界。
- [前端展示](../../frontend/runtime-diagram.md)锁定完整头部层次、唯一头部选举、共享工具链、单画布、纸卡阅读器、折叠、相机、回放与动效边界。
- T12/T09/T11/T10 已按这些 owner 重写实施清单，不再保留 A/B、多个完整头部或双画布等开放决策。

## T12 完成摘要

- [`workflowJournal.ts`](../../../src/db/workflowJournal.ts) 维护 occurrence/event 的幂等追加、终态保护、root sequence/revision、gap、固定上界索引分页与 root/branch 删除。
- [`workflowRecorder.ts`](../../../src/service/chat/workflowRecorder.ts) 和 [`workflowStepWriter.ts`](../../../src/service/chat/workflowStepWriter.ts) 分别覆盖 run 内与 run 外边界；记录故障只降低 completeness，不改变 Agent 结果。
- `chat.workflow.open/history` 已按 root 返回有界步骤快照和历史页，`workflow.updated` 只在 journal 提交后发送连续增量；旧快照和无 journal 历史仍可降级读取。
- `pnpm type-check` 与任务隔离 Vitest 已通过；Vitest 共 5 个文件、24 项测试，显式 mock journal、identity 与 delivery，未访问用户数据库。

## T09 完成摘要

- [`graphModel.ts`](../../../web/src/features/agent/workbench/runtime-diagram/graphModel.ts) 以两个 canonical slice 生成稳定 Vue Flow 节点/正交边；分支创建顺序决定 lane，活动分支切换只迁移完整头部，不移动历史。
- v1 完整头部常驻全部受控步骤槽位，detail、非活动分支与任意层级子 Agent 使用简略头部；工具调用按 lane 与 `callId` 隔离，内容只经显式 message/tool/branch/compaction anchor 连接。
- `RuntimeDiagram.vue` 按实际 root 保存单一相机，普通增量不自动 fit；内容和 occurrence 使用原生键盘按钮，所有图标控制具备可访问名称，空回放显示 `0 / 0`。
- 前端 workflow 定向 Vitest 共 3 个文件、13 项测试通过；受影响文件 ESLint、Vue 类型检查、LESS 编译和 `pnpm web:build` 通过。构建仅保留既有 chunk size 警告。

## T11 完成摘要

- [`WorkbenchDialog.vue`](../../../web/src/features/agent/workbench/WorkbenchDialog.vue) 只常驻一个 `RuntimeDiagram`；旧流程开关、固定 SVG、第二套 Pixi 相机与双画布控制器已移除。阅读器经 nyxus `public.ts` 复用，宽窗停靠、窄窗覆盖，开关时保持图中心、缩放和选择。
- 图选择按 chat 范围的显式 anchor 打开消息、思考或具体 `callId` 工具页签；无内容步骤保持只读。待处理审批/提问使用独立覆盖入口，不受历史选择影响；重复定位同一交互也会重新聚焦。
- 实时、冷恢复与回放共享 reducer/template/projector；回放固定步骤 upper bound 及对应内容快照，事件、occurrence 与旧十节点历史均有静态降级。工作台关闭只释放前端 root owner，不停止后端记录。
- 定向 Vitest 7 个文件 31 项通过；多 owner root 租约、审批入口、Lite、折叠/纸卡阅读与架构门禁扩大回归 20 个文件 167 项通过。受影响 ESLint、`pnpm type-check:all`、Vue SFC 800 行预算及 `pnpm web:build` 通过。
- T07 需实机确认：宽/窄窗口阅读器不遮挡关键控制，历史选择下当前审批仍明显可达，分支/代际/回放与键盘路径可用，且工作台不存在第二张拓扑相机。

## T10 完成摘要

- [`motionPolicy.ts`](../../../web/src/features/agent/workbench/runtime-diagram/motionPolicy.ts) 只允许当前 root 的已同步 live 增量触发反馈；hydrate、重连、回放、静态投影、旧记录、gap、后台、最小化和断线不补播。
- [`useRuntimeMotion.ts`](../../../web/src/features/agent/workbench/runtime-diagram/useRuntimeMotion.ts) 经项目 `useGsap` 建立 scoped context，只动画内层 transform/opacity。终态使用不可交互视觉层从对应头部槽位沉淀，真实 occurrence 节点、选择、Vue Flow 坐标与相机不变；快速状态替换、root/模式切换和卸载均取消旧 tween。
- 状态与条件边保持静态文字、图标和语义色；full 档最多并发 12 个可见一次性反馈、8 个可见运行/等待循环，reduced 和低质量档取消位移及持续循环。
- 动效、图、controller、偏好、质量、热路径、性能恢复和架构定向 Vitest 11 个文件 45 项通过；受影响 ESLint、Web 类型检查、SFC 预算、机械设计检测和 `pnpm web:build` 通过。
- T07 需实机确认：沉淀方向与状态含义清晰，快速状态无闪回或重复节点；后台/最小化/断线/回放/reduced 确实停动，长图正常 p95 ≤20ms、压力场景 p95 ≤33ms。

## 验证与交付

各实现子任务只做代码级定向验证；真实界面操作集中在 T07。最终自动清单和命令以 [T07](07-final-verification.md) 为唯一执行登记，手工步骤以[统一手册](verify/manual-final.md)为唯一 owner。

验收优先顺序：完整头部拓扑 → Vue Flow 新结果树与新版逻辑 → 官网参照动效 → 当前卡牌零变化 → 状态/恢复/回放/性能。前四项任一不满足，即使自动检查全通过也不得进入待用户审批。

自动与必要人工验证全部通过后，按项目政策进入待用户审批；用户明确批准后才迁移剩余长期事实并收口整个任务目录。当前没有提交、部署或操作用户数据的授权。
