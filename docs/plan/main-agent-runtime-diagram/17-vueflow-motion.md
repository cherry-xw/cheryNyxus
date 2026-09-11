# T17 Vue Flow 官网参照动效与性能

**文档创建时间：** 2026-09-11T10:27:28+08:00

状态：未开始。所属[总任务](README.md)。复杂度 4/5：路径移动、流程状态联动、并发分支、相机定位和可取消生命周期。依赖 T16；后续为 T07 综合验证。

## 目标与参照

用户明确要求实现 Vue Flow 官网那种动效效果。本任务不是“加一点动画”的可选润色。效果、时长、预算和降级唯一见[展示契约第 7 节](../../frontend/runtime-diagram.md)，官方示例与已核对的源码链接也集中在那里。

正常窗口、full 档必须实现：可辨执行标记沿完整连线移动，源/目标节点运行终态联动，多分支各自推进，Loop/重试走回边，新业务结果平滑出现，显式定位关联结果时路径光点和相机平滑跟随。仅变色、滚动虚线或淡入不能算完成。当前卡牌动效不改。

## 实现入口与约束

从 [useRuntimeMotion.ts](../../../web/src/features/agent/workbench/runtime-diagram/useRuntimeMotion.ts)、[motionPolicy.ts](../../../web/src/features/agent/workbench/runtime-diagram/motionPolicy.ts)、[RuntimeDiagram.vue](../../../web/src/features/agent/workbench/runtime-diagram/RuntimeDiagram.vue) 进入。使用项目 useGsap/scoped context 和现有 render quality，遵守[动效规范](../../frontend/motion-standard.md)。

Vue Flow 持有节点位置和相机；GSAP 只动画内层和临时视觉层。官网示例用 WAAPI/VueUse 的部分改为项目 GSAP，不增加第二 ticker。禁止把示例随机执行器或“等待动画结束才执行下一节点”逻辑接入产品。

## 已完成事实

- [x] 官网 AnimationEdge、ProcessNode、useRunProcess 和 TransitionEdge 源码已只读核对，目标效果及业务适配边界已锁定。
- [x] 当前 live/hydrate、取消注册表、可见性与并发预算可复用；旧 occurrence 全部沉淀为树节点的判据需要替换。
- [x] T15 的 `headerGraph.ts` 输出模板边世界坐标 `points` 与显式因果 `evidenced`，`WorkflowHeaderEdge.vue` 绘制静态正交路径；`WorkflowHeaderStepNode.vue` 提供独立内层及步骤标记。使用这些入口实现动效，不从旧 sections 网格定位。

## 实施步骤

- [ ] 重写 motionPolicy 输入为模板路径状态与 canonical 结果增量；步骤终态仅更新头部，只有真实内容新增触发结果生长。通过显式 anchor 绑定产出槽位与结果，不按时序猜源头。
- [ ] 自定义边以 BaseEdge/既有路径计算给出静态路径及不可交互执行标记；沿完整路径从 source 到 target 移动，支持折线和回路，不用两端直线飞跃。路径几何变化时重新缓存，不在 tick 中测 DOM。
- [ ] 用 GSAP 动画纯进度值并在缓存路径上插值写 transform/opacity；full 档按官方参照长度计时。配套节点运行图标、完成/失败/拒绝状态切换和局部强调，文字状态始终立即取最新事实。
- [ ] 并发分支各自持有路径效果实例；同 call 重复步骤按 occurrence/sequence 去重，后续事件提前到达可取消/收束旧效果，禁止积压整个执行动画队列。
- [ ] 业务结果入场、新入边强调、关联产物过渡和头部向生长端推进采用内层/非交互视觉过渡；真实结果节点始终只有一个可选实例，外层布局不被 GSAP 接管。
- [ ] 实现显式“定位关联结果”的路径光点与相机跟随；通过 Vue Flow viewport API 驱动，只有用户动作触发，手动拖动/缩放立即取消。普通实时执行不移动相机；无路径直接平滑定位。
- [ ] 复用 system/full/reduced 与 high/balanced/low；限制视口附近 12 个一次性、8 个持续效果。后台、最小化、断线、切 root/回放或卸载清理，冷恢复/翻页/seek 不补播。
- [ ] 在固定 fixture 下验证单流程、多工具、重试、分支并发、子返回、快速终态、长图与用户打断；记录性能预算而不降低既有阈值。
- [ ] 完成定向自动检查；把官网效果逐项对照目标和性能验证入口汇入 T07，更新展示文档实现状态，回写总任务并删除本子计划。

## 定向自动验证与完成标准

运行 `pnpm exec vitest run --config web/vitest.config.ts web/test/agent/workflowMotion.test.ts web/test/agent/workflowGraph.test.ts web/test/performance/motionPreference.test.ts web/test/nyxus/graph/performanceRecovery.test.ts`，增加路径几何/状态编排纯函数和 fake-clock 测试；执行 `pnpm web:type-check`、受影响 ESLint、`pnpm web:build`。

代码断言包括：事件去重、路径方向与中间转折、并发隔离、快速状态取消、头部/结果两类触发、显式定位与用户打断、预算/可见性/生命周期、偏好降级、hydrate/replay 禁止实时生长。保留原 2k 图正文增量性能门禁并为新的图投影补等价规模测试；不能只跑旧图测试声称 Vue Flow 性能通过。

本任务完成表示实现和代码级验证完成，不能宣称视觉已达到官网效果；该结论与正常 p95 ≤20ms、压力 p95 ≤33ms 均由 T07 最终实机验收记录。
