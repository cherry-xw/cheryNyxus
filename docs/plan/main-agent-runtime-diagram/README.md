# 节点树与流程图分离、Pixi 主树恢复

**文档创建时间：** 2026-09-09T01:24:47+08:00（按首次 Git 收录时间补录，实际创建时间未记录）

状态：执行中。2026-09-15 用户否定 Vue Flow 作为主节点树的展示结果，确认恢复 Pixi 横向 Signal 节点树，并将流程图降为按需侧栏；既有 workflow 记录链保留。

## 本轮恢复检查点（优先于历史完成摘要）

当前恢复入口为新增返工批次：先修订展示契约，再恢复 `MessageBranchTree` 主入口、互斥侧栏和 workflow lease 生命周期，最后重建 T07 综合验收。此前 Vue Flow 头部/结果图的自动测试结果保留为历史事实，不作为本次展示验收结论。

| ID | 任务 | 复杂度与依据 | 依赖 | 状态 |
| --- | --- | --- | --- | --- |
| T20 | 嵌套层级、递归折叠与连线（bc4e90c，后由 T22 替代展示） | 4：代表映射、边守恒、全局路由及适配 | 已批准设计 | 已完成 |
| T22 | 递归芯片封装与单板布线 | 4：逐板投影、稳定接口、零交叉短路径及导航恢复 | T20 | 已完成 |
| T23 | 多层共存电路与运行跟随 | 5：递归尺寸、引脚接续与运行生命周期 | T22；合并 T21 | 已完成 |
| T24 | 四向引脚、紧凑无交叉布线与竖排布局 | 5：平面嵌套、引脚次序、路由与全组合验证 | T23 | 已完成 |
| T25 | 运行反馈、阅读交互与回放修复 | 4：布线、阅读和运行生命周期 | T24 | 已完成 |
| T26 | 头部运行编排、待处理交互与 CRT | 4：因果中继、root 流式状态与动效生命周期 | T25 | 已完成 |
| T27 | 节点运行反馈、历史链路与交互迁移 | 4：真实因果写入、累积路径投影、图内交互及跨窗口隔离 | T26 | 已完成 |
| T28 | 新运行完整流程与高亮连续性 | 5：真实因果、固定拓扑、跨轮累计和回放一致性 | T27 | 已完成 |
| T29 | 审批与 CRT 最近可见祖先锚定修正 | 4：共享投影代表、动态堆叠、实时态与折叠交互 | T28 | 已完成 |
| T30 | Vue Flow 视口 ref 与锚点可见性修正 | 2：单组件响应式容器修正及防回归断言 | T29 | 已完成 |
| T31 | 展示契约与计划返工登记 | 2：权威文档与验收边界切换 | T07 失败反馈 | 已完成 |
| T32 | Pixi 主树与互斥侧栏组合 | 5：多组件布局、偏好迁移与交互入口 | T31 | 已完成 |
| T33 | 旧 CRT、审批与节点高亮恢复 | 4：覆盖层、命中层和动效生命周期 | T32 | 已完成 |
| T34 | Workflow 订阅释放与性能门禁 | 4：异步 lease、重连、后台与 journal 基准 | T32 | 已完成 |
| T07 | [综合验证与用户验收](07-final-verification.md) | 5：节点树视觉、侧栏互斥、生命周期和性能 | T31–T34 | 进行中 |

几何分析入口：`node docs/plan/main-agent-runtime-diagram/verify/analyze-circuit.cjs`；生成产物在 `verify/out/`。定向回归：`pnpm exec vitest run --config web/vitest.config.ts web/test/agent/workflowHeaderLayout.test.ts web/test/agent/workflowHeaderNavigation.test.ts`。人工检查统一在 T07。

## 目标与最新决定

- 节点树是工作台核心，使用现有 Pixi `MessageBranchTree` 的横向 Signal 纯图标节点、旧连线、运行时动画、hover 详情与 CRT。
- Vue Flow 流程图保留完整步骤、回放、缩放、定位和详情能力，但仅在左侧按需侧栏挂载，与卡牌、阅读器互斥。
- 侧栏状态为 `none | cards | workflow | reader`，每次工作台打开默认为 `none`；任意侧栏下节点树仍保持横向 Signal。
- 流程图与阅读器侧栏以左侧抽屉覆盖节点树（画布保持全宽、不压缩），抽屉宽度可拖拽及键盘调整（←/→/Home/End）：默认 50%、最小 300px 或 24% 容器宽、最大 88%；卡牌模式保持左右分栏。2026-09-15 用户要求。
- 当前根审批/提问使用左下角旧版唯一操作入口；任务中心只聚合其他根事项。workflow journal 与协议不变。
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
- 当前顺序以顶部台账为准，共享投影与工作台文件串行处理；旧已完成摘要只保留历史事实。

## 历史已完成台账

| ID  | 任务                                                      | 复杂度与依据                                | 依赖             | 状态   |
| --- | --------------------------------------------------------- | ------------------------------------------- | ---------------- | ------ |
| T13 | 新版投影边界与基线固化：纯投影、严格选择和卡牌基线        | 3：分离两类事实投影并锁定卡牌兼容接口       | 本轮规划         | 已完成 |
| T14 | Vue Flow 结果节点树重绘：新节点、事实边、稳定列和指针反馈 | 4：新版拓扑、节点/边呈现和增量布局          | T13（已完成）    | 已完成 |
| T15 | 完整运行头部流程图                                      | 4：条件回路、步骤匹配、共享工具链与头部避让 | T14              | 已完成 |
| T18 | 头部节点与连线路由整理                                  | 3：模板重排、端口分离与交叉控制             | T15              | 已完成 |
| T16 | 工作台、步骤详情与回放接线                              | 4：双事实流、卡牌兼容、多窗及恢复           | T18              | 已完成 |
| T17 | 官网参照动效与性能                                      | 5：路径动画、Morph 图标、实时 CRT、视觉系统和可取消生命周期 | T16 | 已完成 |
| T19 | 头部分组真收起与 Loop 迭代展示                          | 4：跨投影/图模型/节点组件，改变分组展示契约并重路由跨组边     | T17（已完成）    | 已完成 |

T07 是已经存在的最终验证文档，本轮同步重建清单、撤销旧勾选，仅作预登记；其他实现任务全部完成并删除独立文档后才进入。任何新增、删除或范围变化同步复核 T07 和[手动手册](verify/manual-final.md)。

## T27 完成摘要

- 后端原先未写入前端依赖的 causeOccurrenceId，现按轮次、尝试和调用写入真实前驱，修正模型重复实例、审批结束与工具结果归集；默认连线累积整次 run，只有 running 节点持续强调。
- 当前问答插槽原先传给不接收它的阅读布局组件，现直接挂入 RuntimeDiagram，固定尺寸锚定审批节点下方；仅其他根会话使用左下角浮层。展示逻辑抽取为 composable，保持 SFC 预算。
- 旧历史无 cause 时按有序步骤、作用域、调用/批次及消息锚点恢复明确前驱，再沿合法分支和跨层中继点亮路径；不回写用户数据、不跨越缺失步骤、不替换显式因果。回放静态高亮与循环动效分离。
- 2026-09-12：Web 全量 118 文件 / 672 项，隔离后端 5 文件 / 28 项通过；后者包括实际 recorder → reducer → 图投影，以及移除 cause 字段后的跨层文本链路。类型、ESLint 与构建结果和实机待验统一见 T07。

## T28 完成摘要

- 展示拓扑固定为“输入接收 → 输入排队 → 本轮入口 → 消费与输入记录 → 请求准备 → 模型请求 → 大模型响应 → 响应分流”；上下文按同一 run 的精确事实并行供给请求，不占用单一 `causeOccurrenceId`，响应分流再进入文本记录或工具链。
- 同一 run 的实际节点和关系跨 iteration 累计保留，实时与回放共用 occurrence/边证据投影；回放保持静态，新 run 不承接上一 run 的因果边。完成或无活动 run 时头部显示“等待用户输入”，已执行路径仍静态高亮。
- 定向 Web 回归 `8 files / 70 tests`、隔离 recorder `1 file / 8 tests`、`pnpm web:type-check`、受影响文件 ESLint 与 `pnpm web:build` 均退出码 0。几何审计为 34 节点、49 关系、84 线段、0 交叉，完整尺寸 `2472 × 2576`；全部 256 种展开组合通过关系守恒、端口、标签、避让与路由断言。

## T29 完成摘要

- 根因是权威说明仍保留“待处理时强制展开必要祖先、锚点缺失时固定居中”和“CRT 固定在完整头部内部”的旧规则，代码与旧测试据此恢复了已否定行为。现行强制规范已改为统一使用 `WorkflowGraphProjection.representatives`，并明确禁止强制展开和页面固定兜底。
- 审批目标 `approval` 与 CRT 目标 `model` 都解析为最近可见代表；整个头部收起时锚定头部。二者同锚点时审批在上，CRT 按审批实际高度下移 12px；覆盖层随画布移动并按缩放更新位置，自身尺寸不缩放，审批插槽不因折叠重挂载。
- CRT 从 `WorkflowHeaderStepNode` 移到画布宿主覆盖层，投影保留当前根 `activeLiveTurn`，模型节点折叠后仍能显示实时内容或既有空闲占位。Web 全量 `118 files / 691 tests`、类型检查、受影响 ESLint、Web/Electron 构建、文档链接、Plan lint 与 diff 检查均退出码 0；真实位置、堆叠和拖拽跟随留待 T07 实机验收。

## T30 完成摘要

- T29 的测试直接注入独立 viewport ref，遗漏了 `RuntimeDiagram` 使用普通 `ref<VueFlowStore>` 保存 store 时，Vue 会深层解包嵌套 `viewport` 的真实路径；生产代码随后读取 `.viewport.value` 得到 `undefined`，两个覆盖层因此都没有定位样式。
- `flow` 改为 `shallowRef<VueFlowStore>`，保持 Vue Flow store 内部 ref 身份；未恢复固定居中兜底，也未改变最近可见祖先和同锚点规则。正式测试同时验证浅层容器语义与组件源码约束。
- 定向 `2 files / 30 tests`、Web 全量 `118 files / 692 tests`、类型检查、受影响 ESLint 和 Web/Electron 构建均退出码 0。真实审批窗口可见性与拖拽位置返回 T07 实机验收。

## T24 完成摘要

- 固定拓扑位置与四向引脚同源，父封装与边界端子共享坐标；收起保留引脚环绕次序。线路硬性拒绝交叉/接触，转弯有代价，受阻关系可优先重布；标签后置避让，跨线桥已删除，模板版本为 5。
- 原输入封装收起时存在 K3,3 细分子图，原始无封装图的平面证书不足以指导矩形嵌套。上下文资源就近放入模型层后保留全部原始关系；可复现的旧结构反例和当前几何分析由 `verify/analyze-circuit.cjs` 直接核验，不依赖外部图算法包。
- 全展开严格内部交叉 54→0，最大转弯 14→4，工具层 12→3；尺寸 3384×3148→2472×3072。协作封装四节点改为单列直连，宽度 528→296；消费记录与指令注入也上下直连；模型和重试在协作及工具处理区上方，展开宽度相近。
- 全部 256 个展开组合检查关系守恒、层级与边界、端口法线、线路交叉/接触、标签与实时面板避让；新增封闭通道拒绝交叉兜底、竖向过渡及用户最新排列要求回归。最终自动结果见 T07；真实 UI 与 p95 未执行。

## T23 完成摘要

- 递归先测量内部再撑开父层，每排独立宽度；常规节点 168×56 起、按引脚数增高，列间距 112、排间距 72。保留外围与兄弟层，拖拽锁定，收起回到单颗芯片。
- 全部 256 种展开集合验证关系守恒、层级包含、不重叠、不穿元器件与引脚共点。边界引脚保持 8×8 非零尺寸，供画布测量和键盘命中；跨层线段保留原始关系，密集回路显式跨线桥，无分散跳接端子；条件只在可见来源标一次。
- 名称与状态图标/颜色替代冗余状态摘要，说明在节点上方展开。自动跟随按活动祖先展开，终态收起，手动浏览暂停；恢复跟随清除历史选择和详情。160ms 合并相机更新，root/停用/卸载取消，正文增量不移动相机。
- 最终自动结果与实际调用方式登记 T07。Impeccable 上下文引擎不可用，已依项目文档继续，不把该工具记为通过。实机视觉、触摸、键盘与 p95 均待用户验收。

## T22 完成摘要

- `headerLayout` / `headerBoardRouting` 输出 9 张独立板；原始 49 条关系按可见、封装内部和板外完整记账。未进入的内层是芯片，独立引脚稳定；短路径必须通过障碍、接触与重叠检查，否则使用保留原始关系的成对 P 端子。没有过孔或跨线断口。
- 芯片显示内部运行/等待/失败摘要；导航包含进入、返回、总览、面包屑、滚轮阈值及接口双端定位。root/header/板相机隔离，返回恢复原视野；运行增量不切板。实时窗口仅在模型板挂载，结果历史与审批接口不变；卡牌按重登记基线验收（M04）。
- GSAP 继续处理封装收拢与展开；切层期间隐藏线路以避免中间几何交叉，元件到位恢复已验证路径。旧自动展开状态与垂直母线实现退役。
- 2026-09-12：14 文件 76 项定向测试通过，覆盖所有板几何与关系守恒、导航恢复、状态、详情、阅读器、动效、依赖边界和 SFC 预算；受影响 ESLint、Web 类型与 Web/Electron 构建通过，构建仅插件耗时提示。Plan lint、文档链接与 diff 检查为收口验证入口。
- Impeccable 引擎未安装（PATH/root/web .bin/package.json 均无），记录为环境限制，不计通过。没有启动图形界面、读取图片、运行后端测试或访问用户数据库。真实视觉、交互与 p95 由 T07 第 8 节及既有清单验收。
- 本轮修正登记（2026-09-12，t5 同步）：① 代码审查通过无阻断缺陷，观察项（wheel 命中区、240ms 手势锁、navigate 竞态低风险）供 M08 实机确认；② t7 修复 `useHeaderBoardNavigation` wheel 缩放时 viewport 未就绪的 TypeError 崩溃并补回归测试；③ 标准 Vitest 4.1.9 已可用（A06 复核 5 文件 24 项全过），原 `.ignored_vitest` 用法降为历史过程注记；④ A03 web lint 修复落地（0 errors / 19 存量 warnings）；⑤ A05/A07 同源失败（NodePaperStack.styles.less 在 9f64fa3 被改动），用户批准方案 B（新样式=新基线 + 标题 12px），SHA 重登记与 ✅ 标记待 t8 落地；⑥ 删除旧待办遗留调试产物 `.dump-layout.mts` 与 `web/test/agent/dumplog.test.ts`（未跟踪、零引用）。

## T14 完成摘要

- 结果树按 canonical 事实边计算稳定拓扑列，跨 lane 的派发、分支和返回只向后续列推进；正文增量不改变坐标，步骤 occurrence 不参与节点、边或布局。
- 结果节点改为紧凑图标主体与外置中文名称、状态、受控详情，消息、工具、派发/创建协作、返回、过程组和系统节点具有独立视觉类型；自定义 Vue Flow 事实边使用明确输入/输出端口、直角路径、方向箭头及必要的分叉/汇入标签。
- 画布内指针高亮参考 Vue Flow 官网首页的 Blobity 交互语义，以现有 GSAP 在图内跟随鼠标并按节点包围盒形变贴合；高亮层不接管命中，粗指针、触摸和 reduced 档降级为静态 hover/focus。
- workflowGraph、workflowProjectionBoundary、workbenchReader、executionGraph、executionGraphFixtures 共 5 个文件 42 项通过；`pnpm web:type-check`、受影响 ESLint、`pnpm web:build` 和 Impeccable 检测通过。paperStackIntegration 的 7 项中 6 项通过；唯一失败是冻结基线已有的 NodePaperStack 字体断言与样式不一致，T14 未修改冻结文件且 SHA-256 以 T07 A07 表为准，该全量失败保留到 T07 处理。

## T15 完成摘要

- `headerTemplate.ts` 提供 v2 固定尺寸模板，独立步骤、分组、端口和正交边落在同一 Vue Flow；主流程、重试、条件审批/拒绝/失败、Loop、协作与压缩路径齐全。静态回边经过几何验证，不穿过其他步骤主体；旧 header sections 网格及其专属样式已退役。
- `headerState.ts` 从完整 occurrence 集合按 run/iteration/attempt/call 投影，终态保留且新轮次/运行重置；未发生、未单独记录与记录不完整分别表达。工具按明确批次/消息/调用锚点列出，历史选择不随活动调用更新跳转。未归属运行的接收/唤醒事实单独可读，不猜测归属。
- `headerGraph.ts` 先固定业务结果位置，再以完整包围盒向右避让头部；只认 activeBranchId，旧无 task root 使用兼容头部，其他分支/子 Agent 保持简略。步骤说明具备键盘入口与关闭后焦点恢复；RuntimeDiagram 输出 `selectStep` / `selectHeaderScope`，T16 继续接实例详情和内容选择，T17 使用静态路径 `points` 与步骤内层实现动效。
- 2026-09-11 定向 Vitest：workflowHeaderTemplate、workflowHeaderState、workflowGraph、workflowController、workflowProjectionBoundary、workbenchReader、vueSfcSizeBudget 共 7 个文件 32 项通过；`pnpm web:type-check`、受影响 ESLint、`pnpm web:build`、Impeccable 静态检测、Plan lint 和文档链接检查通过。构建仅报告插件耗时提示。A07 五个冻结文件 SHA-256 以 T07 A07 表为准；未运行后端测试、访问用户数据库或启动图形界面。
- T07 继续验证真实箭头/回路可读性、跨主题窗口与键盘路径；T15 自动结论不替代 T16/T17 或最终人工验收。最终回归入口已写入展示契约与 T07，手册补充范围选择及未归属事实场景。

## T18 完成摘要

- 主流程向右展开，工具结果就近接入右侧记录区，压缩位于请求上方，协作位于执行右侧；失败分支按来源顺序分层汇入独立端口，下一轮与唤醒沿外围返回。没有改变业务路径、状态匹配、卡牌或结果历史位置。
- `headerNodePorts` 与 `headerHandleId` 统一端口偏移和边 endpoint，`headerEdgeLabelPoint` 为拥挤路段提供固定标签锚点，转换到世界坐标后由边组件消费。按同一几何统计规则，线段交叉从 20 降到 4，共线重叠从 10 降到 0；这只是几何改善证据，不代替真实视觉验收。
- 2026-09-11：workflowHeaderTemplate、workflowHeaderState、workflowGraph 共 3 文件 23 项通过，覆盖交叉预算、无共线、路由不穿节点、标签在对应路段且不遮挡节点、端口合法性和结果布局稳定；受影响 ESLint、含类型检查的 `pnpm web:build`、Impeccable 静态检测、Plan lint、文档链接及 diff 空白检查通过。构建仅报告插件耗时提示。
- T07 与手册已同步最新路由验收范围；T16/T17 继续使用预计算路径及标签位置。实机仍需确认剩余交叉不被误读成汇合点。

## T16 完成摘要

- 头部步骤改为打开画布内只读详情，按 chat/run/iteration/attempt/call 读取固定边界分页并展示重复实例、gap、legacy、加载、失败与重试状态；切 root、断线、最小化和卸载会取消过期详情请求，关闭详情恢复原步骤焦点。
- 详情只通过显式内容锚点定位现有 canonical 结果节点与 Nyxus 阅读器；缺失或跨会话锚点保持禁用并说明原因，不回退到最近内容。回放冻结进入时的 canonical timeline，随步骤游标裁切对应内容帧；历史不完整、存在 gap 或加载失败时保留完整 canonical 内容，返回实时重新取快照。
- 2026-09-11：workflowStepDetails、workflowController、workflowGraph、workflowHeaderState、workbenchReader 共 5 文件 28 项通过；完整 T16 定向集合 10 文件 52 项中 51 项通过，唯一失败仍是 T07 已登记的冻结卡片字体断言。`pnpm type-check:all`、受影响 ESLint、`pnpm web:build` 与 Impeccable 静态检测通过；检测器零项。五个冻结文件 SHA-256 以 T07 A07 表为准，未运行后端测试、访问用户数据库或启动图形界面。
- T07 与手册现有清单已覆盖步骤实例、严格锚点、固定回放、键盘、宽窄窗口、多窗口和当前审批隔离，无需新增重复检查项。T17 已完成路径与节点动效的代码级实现，T07 按重登记基线实机确认卡牌（M04）及完整交互。

## T17 完成摘要

- `motionPolicy.ts` 与 `useRuntimeMotion.ts` 改为消费头部模板路径和 canonical 结果增量：执行标记沿预计算折线/回边移动，节点与证据化连线联动；快速终态、分支并发和相同 occurrence 替换不会积压动画。仅已同步 live 增量播放，hydrate、回放、后台、最小化、断线、切 root 和卸载均清理；一次性与持续效果分别限制为 12 和 8。
- 头部步骤与结果节点通过 `workflowVisuals.ts` 使用稳定的能力图标、能力色和差异化边框结构；Morphicons 负责可中断状态图标 morph，reduced/低质量直接落到最新形态。等待、成功、失败、拒绝、中断等状态同步使用文字、图标和语义色，颜色不是唯一线索。
- 运行中的模型步骤只挂载 chat/run 匹配的最新 `activeTurns` CRT，正文/思考按现有 Markdown 节流渲染并自动跟随；终态、回放或停用时立即移除。Info 仅响应 hover/focus，点击或触摸点按无动作；普通节点主体打开 T16 实例详情，等待审批节点主体遵守当前根操作入口规则。
- 显式选择步骤锚点时创建不可交互关系边，光点沿确定性正交路径移动并通过 Vue Flow viewport 跟随到目标；无源/目标时直接定位，画布 pointer/wheel、root/回放/最小化和卸载会取消。普通实时增量不移动相机。
- 2026-09-11 定向 Vitest 12 个文件 62 项通过，覆盖路径证据、方向/转折、快速取消、结果生长、能力身份、live CRT 投影、投影边界、详情、回放、2k 性能恢复和 SFC 预算；`pnpm web:type-check`、受影响 ESLint、`pnpm web:build` 与 Impeccable 检测通过，检测器零项。构建仅报告 Vite 插件耗时提示。
- 五个冻结卡牌文件 SHA-256 以 T07 A07 表为准；未运行后端测试、访问用户数据库、启动图形界面或读取图片。代码级完成不代表达到官网实机效果，T07 继续验证真实视觉、交互和 p95 帧率。

## T19 完成摘要

- 头部分组真收起：收起时分组容器降为仅标题条（固定高度 44px），组内步骤节点从投影移除，两端都在组内的 `template` 边舍弃，跨组 `template` 边重路由到分组边界并重算正交折线；结果树 `fact` 边不连内部步骤，不受收起影响，无残留悬垂线。
- 分组可见性按「活跃展开 > 用户覆盖 > 自动收起」判定：`activeGroupIds` 由当前活跃 header 的 running/waiting 步骤所属分组构成；只有 activeBranchId 的完整头部渲染分组，简略头部不渲染分组节点，因此不会跨 header 误展开。用户可经分组标题切换展开/收起，并在完整头部一键重置覆盖。
- Loop 迭代维度透出：步骤与 lane 携带 `iteration`/`iterationCount`，完整头部显示 `Loop n/N` 徽标、步骤显示轮次角标；重复实例仍按 run/iteration/attempt/call 在步骤详情逐条读取，不新增结果树节点。
- 2026-09-11 定向验证：`pnpm type-check`（vue-tsc -b --noEmit）通过；受影响 ESLint 仅剩存量 prettier/CRLF 噪音。真收起交互、迭代徽标与跨组边重路由的实机视觉归 T07 验收；本摘要不替代 T07 综合验证。

## 既有完成结果的保留方式

D00、T01–T06、T08、T12、T09、T11、T10、T07-F1、T07-F2 的原完成事实保留。此前 T07 的自动清单曾于 2026-09-11 通过（Web 108 文件 601 项、workflow 隔离 5 文件 24 项等），但用户否定展示结果，因此不沿用其验收结论。以下 T08–T10 摘要仅描述上一轮实际交付；其中与最新契约冲突的目标由 T13–T17 修正，不能继续据此开发。

以下旧摘要中的“T07 需实机确认”等建议也已失效；本轮只执行重建后的 T07 与手动手册，不再验证 occurrence 沉淀成结果树节点。

## T13 完成摘要

- [`workflowProjection.ts`](../../../web/src/features/agent/workbench/runtime-diagram/workflowProjection.ts) 以纯 TypeScript 输出 `ResultTreeProjection`、`HeaderFlowProjection` 和 `WorkflowSceneProjection`；canonical 内容独立决定结果节点、事实边、顺序与 lane，occurrence 和观察 gap 只进入头部步骤状态。
- [`graphModel.ts`](../../../web/src/features/agent/workbench/runtime-diagram/graphModel.ts) 只适配 Vue Flow Node/Edge；内容、头部、步骤使用独立 ID 命名空间，`fact` 与 `template` 边语义分离。画布不再生成 occurrence 或未解析占位结果节点。
- 图到阅读器的选择经 `resolveWorkflowSceneSelection` 严格按 `sourceChatId` 与节点/`callId` 解析；错会话和缺失锚点明确不可用，不回退到其他会话或最近节点。
- 卡牌冻结基线取 HEAD `25c3c06a20760f343c776c38f7817ed8535a61b4` 上已有未提交工作区；T13 未修改 Nyxus public、readerProjection、NodePaperStack 组件/样式及工作台阅读偏好。精确 SHA-256 已登记到 T07 A07（后按方案 B 重登记，以 A07 表现值为准）。
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

## T25 完成摘要

- 错误判断右移 24px，模型到错误判断只需一次转向；响应向下贯穿模型/重试边界，至调用清单总计两次转向。原始关系与无交叉几何不变。
- 独立层级背景与包内节点同色系；已完成节点不染外框，真实执行路径统一强调色；跨层脉冲按端点连接顺序延时，运行 loading 随生命周期清理。
- 结果全文悬浮窗按需挂载，思考/正文切换；点击复用原卡片。阅读区默认560px，可拖拽/键盘调宽，左侧历史按钮预留独立命中空间；窄窗口整区阅读。五个冻结文件字节未改，阅读器外部布局由本轮用户授权调整。
- CRT 显示真实增量最新6000字符及累计量；工具/审批步骤挂载准确 call 名称及状态。原 info 悬浮框样式恢复，仅悬浮图标显示，teleport 至共享最高提示层；无点击固定。
- 回放快照在 JSON DTO 边界脱离所有响应式代理，测试覆盖深/浅响应式及嵌套工具结果，并验证实时与回放双向隔离。
- 最终自动结论见 T07；没有启动图形界面、读取图片、提交或部署。

## T26 完成摘要

- 连线证据补齐结构中继、共享实例分流/失败汇入、上一轮入口续接与当前范围早期路径；没有因果、跨运行或跨调用的路径不补造。跨封装脉冲共享周期和先后相位，当前强脉冲、历史弱脉冲，未参与元件灰色；生命周期继续由现有 motion context 管理。
- CRT 改用 root 权威实时态，位于完整头部内部下方，内层折叠不隐藏输出；支持思考、正文与已发布的工具参数/结果，超长输出显示末尾6000字符。工具 token 未经后端发布的内容不伪造。当前流式事实优先于较晚到达的步骤记录。
- 待处理提示改为左下角最大420px浮层，不挤压画布；只展示当前待处理请求，无关闭按钮，有事件出现、处理完消失。移除浮层历史/范围筛选及分组标题，问题标题去重，多题编号逐题排列、每组独立提交。共享交互中心继续保留完整筛选。
- 自动结论与手动未验收项见 T07；保留所有既有工作区修改，未提交或部署。
