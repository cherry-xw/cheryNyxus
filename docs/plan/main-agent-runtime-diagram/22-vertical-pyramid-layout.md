# T22 垂直金字塔 + 电路板通道布线 + 侧边外挂

**文档创建时间：** 2026-09-12T09:50:00+08:00

状态：进行中。复杂度 4/5：垂直层带定位、侧边外挂、零交叉通道布线、折叠紧凑与测试收紧。执行者：用户已确认当前 Codex Agent，按已批准方案串行执行，不分配子 Agent。

所属[总任务](README.md)，目标 owner 为[展示契约](../../frontend/runtime-diagram.md)。

承接 T20（bc4e90c 已提交嵌套层级/递归折叠/连线）之后的**新一轮布局重构**：核心 5 层由水平嵌套改为**垂直金字塔堆叠**（loop 顶 → model-layer 底），连线改为**PCB 式正交通道布线**，intake/compact/collaboration 作为**金字塔侧边外挂模块**（绑定 anchor 可折叠）。用户硬性要求：**零交叉、不重合（每条边独立通道）、不穿元件（引线只从元件四周进出）、折叠紧凑（收敛宽度、不留大片空白）**。

## 当前实现（工作区未提交，基于 bc4e90c 之后的 T20 状态继续）

### 模板结构（headerTemplate.ts，已完成）

- HEADER_LAYERS 每项新增 `side?: 'core'|'left'|'right'|'bottom'` 与 `anchor?: string`：intake=left/anchor=entry、compact=right/anchor=request、collaboration=bottom/anchor=execution。
- **所有 layer id / 节点 id / 边 id / group 归属未变**（headerState/calls/测试依赖）。

### 布局引擎（headerLayout.ts，进行中）

- 常量：`W=176 H=88 GAP_H=56 GAP_V=96 PAD=40 BAND_TOP=52 MODULE_GAP=56 GUTTER_W=128 ROUTE_MARGIN=20 TITLE_H=64`。
- 核心 5 层垂直堆叠成金字塔（loop 顶 → model-layer 底），带内 before/center/after 网格 + child 垂直下方；tools 带行间距 `rowGap=88` 容纳 rejection 收集边。
- BandMeta 新增 `innerGapY`；带间空隙通道 `topGapY = y - GAP_V/2` / `bottomGapY = y + h + GAP_V/2`（GAP_V=96 使空隙高 96px，可错层 ~11 条 8px 车道）。
- 侧边外挂：intake 左侧、compact 右上、collaboration 右侧（compact 上方），绑定 anchor；折叠时贴近核心区。
- 平移修复 `dy = TITLE_H + PAD - minY`（保留顶部标题区，保证 loop 带 topGapY 可用）。
- 折叠紧凑：coreMaxW 只算可见层（折叠层用 W=176、隐藏层不占宽）；折叠祖先传播 + representatives 代表映射。

### 布线（headerLayout.ts，进行中）

- 直连边（同排相邻 offset=0 两点直连）、带内单通道（innerGapY/rowGapOf 错层）、跨带母线 + 两段引入车道。
- assignBus 垂直母线独占 x（takenBusXs）、assignLane 水平车道 8px 错层（laneCandidates）。
- 修复 `up` 判断 bug：改用 `sBox/tBox` 节点矩形（endpoint 无 height 曾使所有跨带边都从带底出）。

## 当前状态：92 个交叉，根因已全部定位

| 根因 | 影响边 |
| --- | --- |
| 跨板横段穿中部（横跨 lane 从右 gutter 出发必横穿该 gap 内所有母线） | wait:wake(y=618)、parent-receive:wake(y=646)、parent-receive:input(y=308)、request:compact-request(y=1468) |
| 相邻带边误走母线（垂直相邻带本可共用带间空隙走单水平段） | model:error、retry:request、tool-result:checkpoint、entry:input、checkpoint:decision |
| error:result 走错侧（两端都在右半却因 useLeft 走了左 gutter x=270） | error:result |
| execution:dispatch 竖段穿 tools 带（x=1775 穿 rejection 收集车道） | execution:dispatch |
| 母线全部挤在左右 gutter 过载（需「连接母线靠内、过境母线靠外」的分配秩序） | command/input:request 等左簇、response:checkpoint 等右簇 |
| assignLane/assignBus fallback 静默放行（候选耗尽 return preferYs[0] 不检查冲突） | 全局 |
| useLeft 只用源 escape.x 决策（command→request s.x=1304=centerX 被误判走右） | command:request |

## 后续实现思路（步骤按序执行，每步跑 dumplog 验证交叉归零）

1. **相邻核心带 → 无边单水平段**：route() 跨带分支中，若源/目标为核心带且 `coreDepth` 差 1（srcGapY === tgtGapY 为同一带间空隙），直接 `assignLane` 走单水平段，不进 gutter。涉及 entry→input、tool-result→checkpoint、checkpoint→decision、retry→request、model→error。
2. **行位感知端口方向（spec 生成）**：目标端口按目标节点行位 + 上下行：
   - 单行带：上行边→`bottom`（从下隙进）、下行边→`top`；多行带：末行→`bottom`、首行→`top`；模块→朝核心区侧。
   - 作用：response:checkpoint/parent-receive:input 从底部进 checkpoint/input（不穿中间节点）、error:result 从底部进 result。
3. **母线侧选择改进**：`side = (s.escape.x + t.escape.x)/2 < centerX ? left : right`；模块边强制走模块侧 gutter。command→request、input→request 走左（符合计划 L1/L2），response:checkpoint 等走右。
4. **跨板边走顶部走廊**：源与目标分属相对侧且一端为 intake（左）模块的边（wait:wake、parent-receive:wake）经**顶部走廊 y≈56**（loop 带上方，仅横跨专用）跨板；每条跨板边独占一个走廊车道 y + 独立左 gutter 母线 x，避免 T 型交点。
5. **事务式通道分配**：assignBus/assignLane 候选耗尽返回 `null`（不再静默放行）；`tryBusRoute` 依次尝试每个母线候选，源/目标两段引入车道（findLane 检查、后统一 commit）都干净才原子提交（bus + 2 lane），失败换下一母线 x。
6. **execution:dispatch 走右侧端口**：execution 加右侧端口（朝 collab 模块），水平段在节点高度直入右 gutter，不再向下穿 tools 带。
7. **验证与提交**：dumplog 交叉归零 → 跑完整 `workflowHeaderLayout.test.ts`（目标 crossings=0、overlaps=0、不穿节点、label 齐全）→ 提交步骤 2/3 阶段性结果。

## 待办清单

- [x] 模板加 side/anchor 字段（headerTemplate.ts）。
- [ ] 布局引擎垂直层带 + 侧边外挂（进行中，与布线耦合）。
- [ ] 零交叉通道布线（进行中，见「后续实现思路」）。
- [ ] 适配层与 UI 侧边模块（headerGraph.ts 区分侧边 group 联动 anchor 折叠；RuntimeDiagram.vue / WorkflowHeaderGroupNode.vue 样式与折叠）。
- [ ] 测试收紧（crossings→0）与新增（侧边折叠/代表映射）。
- [ ] 文档更新与清理提交（docs/frontend/runtime-diagram.md、docs/plan 登记、删除 .dump-layout.mts 与 dumplog.test.ts）。

完成标准：上述代码与定向测试通过（零交叉、零重合、不穿元件、折叠紧凑）；把验证入口回写总任务并删除本文件。实机验收仅在最终 T07。
