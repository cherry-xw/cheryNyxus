# T07 综合验证与用户验收

**文档创建时间：** 2026-09-11T02:09:12+08:00

状态：进行中。所属[总任务](README.md)。复杂度 4/5：真实记录链路、完整头部、卡牌冻结、恢复与真实性能。T30 已完成自动检查，当前等待用户实机验收。

自动验证已重跑；必要人工验收尚未执行。范围再变化时同步本清单与[手动手册](verify/manual-final.md)。

## 反馈回填槽

- 2026-09-14 用户反馈：模型节点 CRT 不应常驻/空闲占位，只在节点活动（有数据正在返回）时显示。已落地：`useWorkflowNodePresentation` 的 `crtOverlay` 仅在 `WorkflowGraphProjection.activeLiveTurn` 存在时挂载，权威文档与 M03b/M03c 手册同步，回归测试见 workflowAttentionAnchor。
- 2026-09-15 用户根据实机截图反馈：响应分流改到大模型响应下方并收紧模型层底部；移除与审批信息重复的“工具调用 · N 项”面板；本轮入口与消费记录下移对齐；工具结果、内容记录、继续判断竖直同列。状态：实现与自动验证已完成，等待用户实机视觉确认。
- 2026-09-15 用户追加反馈：左移“错误判断”节点，释放其右侧被遮挡的垂直连线通道。状态：实现与自动验证已完成，等待用户实机视觉确认。
- 2026-09-15 用户要求：流程图与阅读器侧栏改为左侧抽屉覆盖节点树（画布保持全宽、不压缩），宽度可拖拽及键盘调整。已落地：`MessageBranchTree` 抽屉 + 拖拽手柄（默认 50%、最小 300px 或 24% 容器宽、最大 88%，支持 ←/→/Home/End），开关抽屉不再触发相机重新 fit。待用户实机确认。
- 2026-09-26 用户反馈：卡牌模式左右分栏与流程图左侧抽屉均表现为「占空间的窗口」。已落地：卡牌、流程图、阅读器统一改为档案同款**右侧抽屉**（半透明遮罩 + 标题栏 + 关闭按钮，`MessageBranchTree` 内 `tree-drawer-layer`），画布保持全宽，点遮罩或 ✕ 关闭；同时修复 lite 视图 rail 空缺位与角色/会话悬浮面板相对窗口的宽高裁剪。待用户实机确认。

## 范围与边界

本任务只验证最终实现。后端 test/ 冻结，不运行、不修改、不访问用户数据库；仅使用已有隔离 fixture。自动执行者不启动/操控浏览器或 Electron、不截图、不读取图片、不把程序化 DOM/CSS 检查记为 UI 验收。构建可执行；真实视觉、交互及帧率由用户确认。

卡牌冻结基线取 T13 记录的开发开始工作区，不取旧提交；图端仍须准确适配卡牌当前接口。

## 自动验证清单

下表保留 T25 历史结果；当前 T27 结果以本文末尾登记为准，不能用旧结果替代。用户数据库及根 test/ 不在执行范围，后端仅运行计划 verify 内隔离 fixture。

| 编号 | 目标与命令 | 通过标准 | 状态 |
| --- | --- | --- | --- |
| A01 | `node tools/plan-viewer/lint-source.mjs`、`node docs/plan/main-agent-runtime-diagram/verify/check-doc-links.mjs`、`git diff --check` | 索引、链接与空白有效 | 2026-09-12 通过；T25 最终 Plan lint、54 个新增/变更链接与锚点及 diff 检查通过 |
| A02 | `pnpm web:type-check` | Web 类型通过，无 RPC/schema 变化 | 2026-09-12 通过；实际用 `web/node_modules/.bin/vue-tsc.cmd -b web/tsconfig.json --noEmit` |
| A03 | 受影响 Vue/TS 文件 ESLint | 零错误、零新增警告 | 2026-09-12 通过；ESLint 公开 API 检查本轮文件，0 errors / 0 warnings |
| A04 | `pnpm web:build` | Web/Electron 构建成功 | 2026-09-12 通过 |
| A05 | `pnpm test:web` | 包含所有展开组合、运行跟随、卡牌兼容、架构与 SFC 门禁 | 2026-09-12：115 文件 / 645 项通过；最终 info 恢复后 3 文件 / 9 项定向通过 |
| A06 | 既有 workflow 隔离 fixture | 后端投影契约不变 | 本轮未改后端，保留 T22 历史结论，不记作本轮执行 |
| A07 | A05 的 workbenchReader、paperStackIntegration、useWorkbenchViewPreferences、workbenchPreferences | 结果历史、卡牌和审批兼容 | 纳入 A05，2026-09-12 通过；5 个冻结文件 SHA-256 与下表一致 |

当前 Windows 环境的 `pnpm exec` 未找到工具，但已安装的可执行入口可用。测试实际调用 `node_modules/.bin/vitest.cmd run --config web/vitest.config.ts --reporter=dot`；Vite 构建通过公开 API 在 `web/` 执行 `node -e "import('vite').then(v=>v.build({logLevel:'warn'}))"`。未读取第三方源码或打包产物，没有启动图形界面。

A07 冻结基线按 `9f64fa3` 之后工作区重登记：用户已批准方案 B，`9f64fa3` 的卡牌改动正式登记为冻结范围变更（含标题字号提升至 12px）；`NodePaperStack.styles.less` 已按 t8 落地后的实际字节重登记（当前文件为 LF 行尾，LF 归一 = 工作区字节；旧记录 EF60E351… 为旧内容 CRLF 归一值，作废），其余 4 文件哈希不变。冻结文件 SHA-256 如下：

| 文件                                                                | SHA-256                                                            |
| ------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `web/src/features/pets/nyxus/public.ts`                             | `88D2DF3864417CB392E02E30EC9B9CB6DB87EAB3212AEF605C20E9CED26856C5` |
| `web/src/features/pets/nyxus/paper/readerProjection.ts`             | `AA83584F1785278023B9F9EC7A24B6CCB1495EDE6B80903CEA73F04589B220D7` |
| `web/src/features/pets/nyxus/components/NodePaperStack.vue`         | `5D817E5955A960831F073D2BA8EDA27F0E3C5DC9306BDC0E78E966D1F6B2C020` |
| `web/src/features/pets/nyxus/components/NodePaperStack.styles.less` | `2DF9DDAFC89D8C2E9332A43E1E51A135EAAC82641CC5BCD82155A5DF4016505D`（LF 归一 = 工作区字节，方案 B 重登记） |
| `web/src/features/agent/workbench/useWorkbenchViewPreferences.ts`   | `3575E8743C0F3402F8E5CF85CA79F88BC45FE5A987BC4E13392489677EBC559A` |

T14 定向回归发现的冻结基线内差异（`paperStackIntegration.test.ts` 期望 `700 13px/1.25 ui-monospace`，而 `NodePaperStack.styles.less` 为 `400 11px/1.25 ui-monospace`）已由用户拍板采用方案 B：新卡牌样式（`9f64fa3` 改动 + 标题 12px）正式登记为冻结新基线，测试预期同步更新至新基线；不再还原旧样式，A05 断言按新基线通过，SHA 表按 t8 重登记值更新。该差异不归因于结果树改动，冻结卡牌样式仅由方案 B 授权变更。

构建、全量测试与性能复跑串行执行，避免资源争用；失败先定位，不降低阈值。规划阶段文档检查不等于最终代码上的 A01 已完成。

必须由新测试覆盖：

- 结果树只含 canonical 业务内容，内部步骤增量不改变节点/计数/折叠/lane；流式到持久不重复。
- `workflowHeaderLayout` / `workflowHeaderTemplate` / `workflowHeaderNavigation` / `workflowHeaderState`：全部 256 种展开组合的关系守恒、递归包含与兄弟节点不重叠、四向引脚与法线、内外引脚共点、零交叉/无无关接触/无共线重叠/不穿元件、标签和实时面板避让、接口双端追踪、独立展开与运行跟随/暂停/取消；增加工具全展开及关键路径转弯上限、协作与消费/指令竖排、模型上置及宽度对齐，不用跨线桥作为合格结果。主结果历史位置不变。完成状态保留，run/轮次/尝试和未归属事实隔离。定向通过不替代 A05 全量回归。
- 同名 call 隔离、拒绝后未发生槽位中性、子返回与父接收/继续分别表达。
- anchor 缺失/晚到、同 ID 跨 chat、旧数据/gap、分页 conflict、重连/root 竞态、多 owner 租约与内容降级可读。
- 卡牌契约与当前审批入口不变；固定回放上界及内容帧，seek/暂停无执行副作用。
- 官网式路径方向/转折、并发隔离、去重、快速取消、真实结果生长、显式定位及手动打断。
- 画布指针层作用域与清理、节点目标标记及 reduced/触摸/粗指针降级；视觉贴合和输入互不干扰仍由 M02 人工确认。
- system/full/reduced、质量档、不可见/最小化/断线/回放/卸载清理；正文增量不抢相机；仅开启跟随时活动身份或几何改变调整视野。
- 审批与 CRT 分别从原始目标解析到最近可见代表，全部折叠时落到头部；不强制展开、不固定居中、不随缩放改变尺寸，同锚点按审批、12px、CRT 排列。
- CRT 仅在模型节点活动（存在正在返回数据的 live turn）时挂载，空闲、终态与回放不显示占位面板；activeLiveTurn 生命周期与锚定一致。
- 新投影 2k 规模、正文增量不重排、缓存/动画有界；旧 Pixi 性能测试不能替代新图验证。

## 手动验证清单

## 2026-09-15 Pixi 主树返工自动验证

- `pnpm test:web`：并发运行时仅 2k 性能用例受资源竞争超时；随后保持 1500ms 门槛，以 `--no-file-parallelism` 串行复跑，118 个文件、704 项全部通过。
- `pnpm exec vitest run test/service/chat/workflowRecorder.test.ts test/service/chat/flowSync.test.ts`：14 项通过，journal 记录语义与 root 事件流未改变。
- `pnpm --filter web build`：Web、Electron main 与 preload 构建成功。
- 定向 lease 测试确认隐藏/暂停时调用 `workflow.close`、清空 live/projection/replay，恢复可见后重新 `workflow.open`。
- UI 机械检测只命中节点树既有弹性曲线；新增节点吸附弹性属于用户明确要求，且仅在 fine mouse + full motion 下启用。
- 尚需用户实机确认 Pixi 节点树外观、CRT、hover 详情、左下角审批、侧栏覆盖和吸附手感；项目规范禁止 AI 代替用户读取截图作视觉结论。

| 编号 | 目标                       | 操作入口    | 通过标准                                         | 状态   |
| ---- | -------------------------- | ----------- | ------------------------------------------------ | ------ |
| M01  | 完整头部流程图             | 手册第 1 节 | 静态可读的步骤连线、条件分支与回路，非功能块平铺 | 待执行 |
| M02  | Vue Flow 结果树与新版逻辑  | 手册第 2 节 | 新节点/边和结果正确，指针块贴合节点且不干扰操作  | 待执行 |
| M03  | 官网参照动效               | 手册第 3 节 | full 档逐项达到官网参照效果，无静态/淡入替代     | 待执行 |
| M03a | 节点身份、Morph 图标与颜色 | 手册第 3 节 | 能力与状态均可辨，图标过渡可中断且非仅靠颜色     | 待执行 |
| M03b | 模型实时 CRT               | 手册第 3 节 | 运行时实时打印，终态/停用立即收束（空闲不保留占位）且不生成重复结果     | 待执行 |
| M03c | 审批与 CRT 折叠锚定 | [手册 T29 操作卡](verify/manual-final.md#t29-审批与-crt-最近可见祖先操作卡) | 最近可见祖先、同锚点顺序、拖拽与缩放均符合契约 | 待执行 |
| M04  | 卡牌内容与操作兼容               | 手册第 4 节 | 阅读区可调宽且历史按钮可点；内容、开关、偏好、动作兼容，选择准确       | 待执行 |
| M05  | 工具、审批、分支、步骤详情 | 手册第 5 节 | call 独立，等待/拒绝准确，主干与动作正确         | 待执行 |
| M06  | 恢复、回放、相机与可访问性 | 手册第 6 节 | 固定回放，无补播/抢相机，主题/窗口/键盘可用      | 待执行 |
| M07  | 生命周期和性能             | 手册第 7 节 | 正常 p95 ≤20ms，压力 p95 ≤33ms，清理正确         | 待执行 |
| M08 | 递归封装、接口和导航 | 手册第 8 节 | 紧凑多层共存、四向连续引脚、全展开零交叉与无节点重叠，工具链短连无无意义折返；默认全展开、结束保持展开，手动浏览暂停跟随 | 待执行 |

每项记录执行人、日期、环境及结论；失败给复现。M01–M04 不得以自动通过替代或标不适用；数据不足先准备可丢弃 fixture。

## 当前结果与完成标准

T25 的 A01–A05、A07 已通过，A06 明确未重跑。全展开 34 步骤 / 49 原始关系 / 84 段线路，零交叉，最大 4 次转弯；全部展开组合及标签、引脚、面板几何回归通过。必要人工未完成，保持待综合验证；失败回到执行中登记新修正任务并同步清单。全部通过后删除本子计划，总任务进入待用户审批；用户明确批准后才按项目政策收口整个目录。当前无提交或部署授权。

## T25 验证更新

T25 全量 115/645 通过；最后恢复原 info 样式后重跑 visuals/reader/SFC 3文件9项，最终类型、0错误0警告ESLint、Web/Electron构建通过。人工补验：层级色系、响应向下出线、info 不重复开侧栏、全文悬浮窗及双页切换、点击卡片和拖宽/键盘调宽、工具栏可点击、运行 loading/定向脉冲、CRT 累积滚动和独立工具/审批信息。按现有手册环境与证据方式记录；未执行不计通过。

最终 info 验收必须确认原248px悬浮外观、最高层级、无点击固定；回放验收确认 reactive 时间线不抛 DataCloneError 且实时增量不污染回放。构建仅提示插件耗时。五个冻结文件哈希与 A07 表一致；卡片内容/动作/偏好兼容，不把本轮授权的阅读区尺寸调整认定为外观完全不变。

## T26 自动检查与验收补充

- Web 类型检查、受影响源文件 ESLint、Web/Electron 构建通过。
- 定向 Vitest：头部因果路径、状态/布局/导航、motion、CRT/图投影、root 实时态、交互路由与架构预算；最终 14 文件 / 100 项全部通过（2026-09-12）。
- 实机待验：按手册 T26 场景优先确认头部执行表现、跨层脉冲和 CRT；自动检查不替代视觉、交互或 p95 结论。

## T27 验证范围

2026-09-12 自动结果：`pnpm exec vitest run --config web/vitest.config.ts --reporter=dot` 为 118 文件 / 672 项通过；`pnpm exec vitest run --config docs/plan/main-agent-runtime-diagram/verify/vitest.config.ts` 为 5 文件 / 28 项通过。`pnpm type-check`、受影响 Vue/TS ESLint、`pnpm web:build`（含 Web 类型检查及 Web/Electron 构建）通过，构建仅有插件耗时提示。Plan lint、163 个新增/变更文档链接与锚点、`git diff --check` 通过。后端 fixture 全部使用 mock 数据库，不访问真实数据库；以上不替代实机验收。

历史补验：清空可丢弃测试数据后，以更新后后端新建文本、审批、重试与多轮 run；回放与实时使用同一 occurrence 和路径投影，前后 seek 不引入未来路径。本轮不验收旧测试数据兼容或迁移。

人工检查：使用更新后后端产生的新 run，默认全展开且运行结束不收起；输入、模型、工具、结果与下一轮构成完整高亮链路，跨层线段保持连贯。仅正在运行的节点做强强调动效，其他已参与节点保持较显眼的静态状态，等待使用静态警示。当前问答在事项出现时直接显示于审批节点正下方并水平居中，无摘要卡片、标题及关闭按钮；点击审批节点主体只聚焦操作面板，Info 点击或触摸点按无动作。手动折叠、回放和旧运行范围均不隐藏待处理面板，清空后恢复原折叠选择。在 35%、50%、100%、180% 缩放及平移时锚点跟随节点，面板文字与尺寸不变且处于工作台最高可操作层。长表单提交按钮可达，提交失败保留草稿；铃铛角标只计当前根待处理数量并可收起/展开左下角窗口，收起后新事项不自动展开；其他根事项仅由任务中心聚合。切 root 不遗留错误表单。模型面板与工具选择兼容、生命周期和性能仍按手册验证。全部人工项目待执行。

## T28 自动验证记录

| 编号 | 目标 | 命令 | 退出码 | 关键断言行 | 日期与产物路径 |
| --- | --- | --- | --- | --- | --- |
| T28-A01 | 新 run 主链、上下文供给、工具/审批/重试、跨 iteration、回放与等待态 | `pnpm exec vitest run --config web/vitest.config.ts web/test/agent/workflowHeaderTemplate.test.ts web/test/agent/workflowEdgeEvidence.test.ts web/test/agent/workflowHeaderLayout.test.ts web/test/agent/workflowHeaderNavigation.test.ts web/test/agent/workflowHeaderState.test.ts web/test/agent/workflowGraph.test.ts web/test/agent/workflowMotion.test.ts web/test/agent/workflowVisuals.test.ts` | 0 | `8 passed; 70 passed` | 2026-09-12；终端输出，未生成文件 |
| T28-A02 | recorder 到 reducer 与嵌套边投影 | `pnpm exec vitest run --config docs/plan/main-agent-runtime-diagram/verify/vitest.config.ts docs/plan/main-agent-runtime-diagram/verify/workflowRecorder.test.ts` | 0 | `1 passed; 8 passed` | 2026-09-12；终端输出，未生成文件 |
| T28-A03 | 全量 Web 回归 | `pnpm test:web -- --reporter=dot` | 0 | `118 passed; 673 passed` | 2026-09-12；终端输出，未生成文件 |
| T28-A04 | 类型、受影响 lint 与 Web/Electron 构建 | `pnpm web:type-check && pnpm exec eslint web/src/features/agent/workbench/runtime-diagram/headerTemplate.ts web/src/features/agent/workbench/runtime-diagram/headerEdgeEvidence.ts web/src/features/agent/workbench/runtime-diagram/headerCircuitPlacement.ts web/src/features/agent/workbench/runtime-diagram/WorkflowHeaderNode.vue web/test/agent/workflowHeaderTemplate.test.ts web/test/agent/workflowEdgeEvidence.test.ts web/test/agent/workflowHeaderLayout.test.ts web/test/agent/workflowHeaderNavigation.test.ts web/test/agent/workflowVisuals.test.ts docs/plan/main-agent-runtime-diagram/verify/workflowRecorder.test.ts && pnpm web:build` | 0 | `vue-tsc -b --noEmit`; ESLint 0 errors; `built in 8.47s` | 2026-09-12；`dist/web/`、`web/dist-electron/` |
| T28-A05 | 平面几何、计划与文档完整性 | `node docs/plan/main-agent-runtime-diagram/verify/analyze-circuit.cjs && node tools/plan-viewer/lint-source.mjs && node docs/plan/main-agent-runtime-diagram/verify/check-doc-links.mjs && git diff --check` | 0 | `34 vertices; 49 edges; 84 segments; 0 crossings`; `Passed: 3 new/changed documentation links and anchors` | 2026-09-12；终端输出，未生成文件 |

自动部分通过。真实视觉、交互、跨窗口/设备可访问性与 p95 性能仍按[统一手册](verify/manual-final.md)由用户执行；旧测试数据兼容不属于本轮验收范围。

## T29 自动验证记录

| 编号 | 目标 | 命令 | 退出码 | 关键断言行 | 日期与产物路径 |
| --- | --- | --- | --- | --- | --- |
| T29-A01 | 审批/CRT 完整折叠链、平移缩放与渲染所有权 | `pnpm test:web -- workflowAttentionAnchor workflowGraph` | 0 | `2 passed; 35 passed` | 2026-09-13；终端输出，未生成文件 |
| T29-A02 | 全量 Web 回归 | `pnpm test:web` | 0 | `118 passed; 691 passed` | 2026-09-13；终端输出，未生成文件 |
| T29-A03 | 类型、受影响 lint 与 Web/Electron 构建 | `cmd /c "pnpm web:type-check && pnpm exec eslint web/src/features/agent/workbench/runtime-diagram/RuntimeDiagram.vue web/src/features/agent/workbench/runtime-diagram/WorkflowAnchoredOverlays.vue web/src/features/agent/workbench/runtime-diagram/WorkflowHeaderStepNode.vue web/src/features/agent/workbench/runtime-diagram/WorkflowLiveCrt.vue web/src/features/agent/workbench/runtime-diagram/graphModel.ts web/src/features/agent/workbench/runtime-diagram/headerGraph.ts web/src/features/agent/workbench/runtime-diagram/useWorkflowNodePresentation.ts web/test/agent/workflowAttentionAnchor.test.ts web/test/agent/workflowGraph.test.ts web/test/agent/workflowVisuals.test.ts && pnpm web:build"` | 0 | `vue-tsc -b --noEmit`; ESLint 0 errors / 0 warnings；Web/Electron `built` | 2026-09-13；`dist/web/`、`web/dist-electron/` |
| T29-A04 | 文档、计划与空白完整性 | `cmd /c "node docs/plan/main-agent-runtime-diagram/verify/check-doc-links.mjs && pnpm plan:lint && git diff --check"` | 0 | 文档链接通过；`Plan Lint 通过`；diff 无错误 | 2026-09-13；终端输出，未生成文件 |

## T30 自动验证记录

| 编号 | 目标 | 命令 | 退出码 | 关键断言行 | 日期与产物路径 |
| --- | --- | --- | --- | --- | --- |
| T30-A01 | Vue Flow store 响应式容器与锚点/导航回归 | `pnpm test:web -- workflowAttentionAnchor workflowHeaderNavigation` | 0 | `2 passed; 30 passed` | 2026-09-13；终端输出，未生成文件 |
| T30-A02 | Web 类型与受影响 ESLint | `pnpm web:type-check`；`pnpm exec eslint web/src/features/agent/workbench/runtime-diagram/RuntimeDiagram.vue web/test/agent/workflowAttentionAnchor.test.ts` | 0 | `vue-tsc -b --noEmit`；ESLint 0 errors / 0 warnings | 2026-09-13；终端输出，未生成文件 |
| T30-A03 | 全量 Web 回归与 Web/Electron 构建 | `pnpm test:web`；`pnpm web:build` | 0 | `118 passed; 692 passed`；Web/Electron `built` | 2026-09-13；`dist/web/`、`web/dist-electron/` |

## CRT 活动生命周期修正验证记录（2026-09-14 用户反馈）

| 编号 | 目标 | 命令 | 退出码 | 关键断言行 | 日期与产物路径 |
| --- | --- | --- | --- | --- | --- |
| F01 | CRT 仅在 activeLiveTurn 时挂载的定向回归 | `pnpm test:web -- workflowAttentionAnchor workflowGraph workflowVisuals`（含 118 文件全量并发） | 1（仅 unrelated performanceRecovery 2k 性能预算 1858ms>1500ms，资源争用；单跑通过见 F02） | `workflowAttentionAnchor`「stays visible until pending work clears」「shows the CRT only while the active model node has a live streaming turn」均通过 | 2026-09-14；终端输出，未生成文件 |
| F02 | performanceRecovery 单文件复跑（隔离负载） | `node_modules/.bin/vitest.cmd run --config web/vitest.config.ts web/test/nyxus/graph/performanceRecovery.test.ts --reporter=dot` | 0 | `1 passed; 5 passed` | 2026-09-14；终端输出，未生成文件 |
| F03 | Web 类型检查 | `pnpm web:type-check` | 0 | `vue-tsc -b --noEmit` 无错误 | 2026-09-14；终端输出，未生成文件 |
| F04 | 受影响 ESLint | `node_modules/.bin/eslint.cmd web/src/features/agent/workbench/runtime-diagram/useWorkflowNodePresentation.ts web/test/agent/workflowAttentionAnchor.test.ts` | 0 | 0 errors / 0 warnings | 2026-09-14；终端输出，未生成文件 |
| F05 | 计划与文档完整性 | `node tools/plan-viewer/lint-source.mjs && node docs/plan/main-agent-runtime-diagram/verify/check-doc-links.mjs && git diff --check` | 0 | `Plan Lint 通过`；`Passed: 2 new/changed documentation links and anchors`；diff 无错误 | 2026-09-14；终端输出，未生成文件 |

## 循环点亮顺序修正验证记录（2026-09-14 用户反馈：内容记录双入边时序 / 流程开始顺序 / 新 loop 灰色重置）

| 编号 | 目标 | 命令 | 退出码 | 关键断言行 | 日期与产物路径 |
| --- | --- | --- | --- | --- | --- |
| G01 | recorder 回归：context 延后到准备请求、checkpoint 单一 occurrence | `PYTHONIOENCODING=utf-8 npx vitest run test/service/chat/workflowRecorder.test.ts` | 0 | `7 passed`（含「records context at request preparation, after the loop input, as a run-level fact」「shares one checkpoint occurrence between the boundary and the tool-result message commit」） | 2026-09-14；终端输出，未生成文件 |
| G02 | 端到端点亮顺序（recorder→journal→state/evidence，含 loop2 灰化） | `PYTHONIOENCODING=utf-8 npx vitest run --config docs/plan/main-agent-runtime-diagram/verify/vitest.config.ts` | 0 | `6 passed; 29 passed`（新增 `workflowLightingOrder.test.ts`：context firstSequence 位于 input 后；checkpoint 单一 occurrence 且 channels:checkpoint 与 tool-result:checkpoint 指向同一 target；loop2 时上一轮工具链/内容记录/继续判断全部 idle 灰色） | 2026-09-14；终端输出，未生成文件 |
| G03 | 前端证据/状态回归 | `PYTHONIOENCODING=utf-8 npx vitest run web/test/agent --config web/vitest.config.ts` | 0 | `39 passed; 183 passed`（含「proves both checkpoint inputs on one shared occurrence」「returns a previous loop chain to gray idle when the next loop starts」） | 2026-09-14；终端输出，未生成文件 |
| G04 | 类型检查 | `pnpm type-check && pnpm web:type-check` | 0 | `tsc --noEmit` 与 `vue-tsc -b --noEmit` 无错误 | 2026-09-14；终端输出，未生成文件 |

## CRT 归属与排版修正验证记录（用户反馈：CRT 属于大模型响应节点 / 加宽窗口 / 收敛字号与行距 / 段落空隙过大）

| 编号 | 目标 | 命令 | 退出码 | 关键断言行 | 日期与产物路径 |
| --- | --- | --- | --- | --- | --- |
| H01 | CRT 锚点归属大模型响应节点与折叠代表链回归 | `PYTHONIOENCODING=utf-8 npx vitest run web/test/agent --config web/vitest.config.ts` | 0 | `39 passed; 190 passed`（新增 response 折叠代表链 6 例与「CRT 锚点落在 `visibleTemplateAnchor(graph,'response')` 可见代表」断言） | 2026-09-14；终端输出，未生成文件 |
| H02 | Web 类型检查 | `pnpm web:type-check` | 0 | `vue-tsc -b --noEmit` 无错误 | 2026-09-14；终端输出，未生成文件 |
| H03 | CRT 段落空隙修正（块间换行文本节点折叠） | `node_modules/.bin/eslint.cmd web/src/features/agent/workbench/runtime-diagram/WorkflowLiveCrt.vue`；`git diff --check` | 0 | ESLint 0 错误 / 0 警告；diff 无错误。pre-wrap 仅保留于 p/h1-h6/li/blockquote/th/td 文本块内部，块间 `</p>\n<p>` 空白文本节点不再渲染为空行，段落间距回落到 0.35em | 2026-09-14；终端输出，未生成文件 |
| H04 | 大模型响应节点实时输出期间点亮 | `PYTHONIOENCODING=utf-8 npx vitest run web/test/agent/workflowGraph.test.ts web/test/agent/workflowAttentionAnchor.test.ts --config web/vitest.config.ts`；`pnpm web:type-check`；`node_modules/.bin/eslint.cmd web/src/features/agent/workbench/runtime-diagram/headerGraph.ts web/test/agent/workflowGraph.test.ts` | 0 | headerGraph.ts 将 liveTurn 同时挂到 model 与 response 节点：输出期间两节点均为 running（beacon/loading/脉冲），提交后由响应 occurrence 承接；workflowGraph 断言 response.liveTurn 与模型一致、其余节点仍无 liveTurn；类型检查与 ESLint 0 错误 | 2026-09-14；终端输出，未生成文件 |

## 协作横排布局验证记录（2026-09-14 用户反馈：全展开头部过高，工具处理中节点移到重试控制右侧，协作节点水平摆放，连线弯折不增加）

用户反馈两项合并执行：全展开高度收缩（工具链右移），并将协作板块四节点由竖排改为单行水平直连；硬约束为全展开高度 < 旧值 2576、宽度 < 3000、零交叉、各板弯折 ≤ 基线（tools ≤3、其他 ≤4）。

| 编号 | 目标 | 命令 | 退出码 | 关键断言行 | 日期与产物路径 |
| --- | --- | --- | --- | --- | --- |
| K01 | 全 256 展开组合路由/标签回归 | `node docs/plan/main-agent-runtime-diagram/verify/debug-mask-sweep.cjs` | 0 | `failures: 0/256`（折叠 chip 态 error:result 标签冲突已修：retry-layer 折叠态最小宽度 646，标签落 d=88 槽 (486,42)，避开 checkpoint x=478 竖线与 error:retry 标签带） | 2026-09-14；终端输出，未生成文件 |
| K02 | 端口 offset 越界扫描（全 256 组合） | `node docs/plan/main-agent-runtime-diagram/verify/debug-port-offset.cjs` | 0 | `violations: 0`（resume→tool-result 右面 offset 40→24，回到 56 高节点半高界内） | 2026-09-14；终端输出，未生成文件 |
| K03 | 布局定向回归 | `pnpm vitest run test/agent/workflowHeaderLayout.test.ts`（web/） | 0 | `5 passed`（含全组合关系守恒/零交叉/弯折上限；collab 横排断言：四节点同 y、x 递增、内部连线水平 2 点；model-layer channels:tool-list 首段水平；全展开 width <3000） | 2026-09-14；终端输出，未生成文件 |
| K04 | 尺寸与弯折抽查 | `node docs/plan/main-agent-runtime-diagram/verify/measure-masks.cjs` | 0 | mask-31 graph 2987×2280；mask-255 全展开 graph 2999×2280（宽 <3000、高 <2576 达标）；collab 776×200 横排，execution:dispatch 0 弯、parent-receive:input 1 弯、parent-receive:wake 3 弯；tools ≤3 弯、其余 ≤4 弯 | 2026-09-14；终端输出，未生成文件 |
| K05 | 类型、受影响 lint 与 Web/Electron 构建 | `pnpm web:type-check`；`pnpm --filter web exec eslint --fix src/features/agent/workbench/runtime-diagram/headerCircuitPlacement.ts test/agent/workflowHeaderLayout.test.ts`；`pnpm web:build` | 0 | `vue-tsc -b --noEmit` 无错误；ESLint 0 errors / 0 warnings；Web/Electron `built` | 2026-09-14；`dist/web/`、`web/dist-electron/` |
| K06 | 计划与文档完整性 | `node tools/plan-viewer/lint-source.mjs && node docs/plan/main-agent-runtime-diagram/verify/check-doc-links.mjs && git diff --check` | 0 | `Plan Lint 通过`；`Passed: 0 new/changed documentation links and anchors`；diff 无错误。前端契约第 42 行「任务协作四节点单列上下直连」更新为「单行水平直连」 | 2026-09-14；终端输出，未生成文件 |

实现要点（`headerCircuitPlacement.ts`）：collaboration 分支四节点横排 `put(id, 64+i*172, 72)`、板高下限 200；`408-at` chip 锚定保留（mask-31 展开态宽度 2987 达标），折叠态最小宽度 646 只作用于 retry 板折叠态（展开态由芯片尺寸驱动 ≥1124，宽度连锁远低于 3000 上限）；`resume:tool-result` 右面端口回落到 24。人工视觉验收仍按 M08/M01 待用户执行。

## 头部空间压缩与结果链对齐验证记录（2026-09-15 用户截图反馈）

| 编号 | 目标 | 命令 | 退出码 | 关键断言 | 日期与产物路径 |
| --- | --- | --- | --- | --- | --- |
| L01 | 256 种展开组合路由与端口合法性 | `node docs/plan/main-agent-runtime-diagram/verify/debug-mask-sweep.cjs`；`node docs/plan/main-agent-runtime-diagram/verify/debug-port-offset.cjs` | 0 | `failures: 0/256`；`violations: 0` | 2026-09-15；终端输出与 `verify/out/debug-masks.json` |
| L02 | 新布局契约与模板回归 | `pnpm test:web -- workflowHeaderLayout workflowHeaderTemplate` | 0 | `2 passed; 8 passed`；响应分流垂直下置、模型层底部 64px、入口水平直连、无 calls 面板、结果链同中心线直连、协作单行及 tools 连线最多 3 次弯折 | 2026-09-15；终端输出，未生成文件 |
| L03 | Web 全量回归与性能隔离复跑 | `pnpm test:web -- --reporter=dot`；连续 5 次 `pnpm test:web -- performanceRecovery --reporter=dot` | 1；0 | 全量 `117 passed / 118 files`、`701 passed / 702 tests`，唯一失败为并发负载下既有 2k 性能预算；隔离连续 5 轮均 `1 file / 5 tests` 通过 | 2026-09-15；终端输出，未生成文件 |
| L04 | 类型、受影响 lint 与 Web/Electron 构建 | `pnpm --filter web type-check`；受影响文件 `pnpm exec eslint ...`；`pnpm web:build` | 0 | `vue-tsc -b --noEmit` 无错误；ESLint 0 errors / 0 warnings；Web/Electron `built` | 2026-09-15；`dist/web/`、`web/dist-electron/` |
| L05 | 错误判断左移与垂直通道拉直 | `pnpm test:web -- workflowHeaderLayout workflowHeaderTemplate`；`debug-mask-sweep.cjs`；`debug-port-offset.cjs`；`measure-masks.cjs`；类型检查与受影响 ESLint | 0 | 定向 `2 files / 8 tests`；`failures: 0/256`；`violations: 0`；`retry-layer:channels:checkpoint` 从 4 次弯折降为 0，错误判断与重试判断保持至少 16px 间距；全展开宽度 2823→2791 | 2026-09-15；终端输出，未生成文件 |

实现要点：模型层把 channels 固定到 response 正下方并按实际内容底部加 64px 收高；删除 `header-calls` 图节点、渲染槽和组件；入口与消费记录按同一端口中心定位；工具结果、内容记录、继续判断均按上层边界引脚的真实中心定位。工具审批链与展开的 retry 封装之间保留 64px 路由带，使 `channels:tool-list` 在 compact 展开时仍可用 3 次弯折以内到达。错误判断在空间允许时左移 56px，并在折叠态保留与重试判断的 16px 最小间距，以释放 checkpoint 垂直通道。人工视觉验收继续按 M01/M08 执行。
