# 自动验证清单原始命令输出 · main-agent-runtime-diagram

> 本文件是「节点树与流程图分离、Pixi 主树恢复」计划收口时迁出的自动清单证据，原登记于计划 T07（`docs/plan/main-agent-runtime-diagram/07-final-verification.md`，已随收口删除）。以下为执行时登记的命令、退出码、关键断言行与产物路径；未生成文件的记录产物记为「终端输出」。

## T28 自动验证记录（2026-09-12）

| 编号 | 目标 | 命令 | 退出码 | 关键断言行 | 日期与产物路径 |
| --- | --- | --- | --- | --- | --- |
| T28-A01 | 新 run 主链、上下文供给、工具/审批/重试、跨 iteration、回放与等待态 | `pnpm exec vitest run --config web/vitest.config.ts web/test/agent/workflowHeaderTemplate.test.ts web/test/agent/workflowEdgeEvidence.test.ts web/test/agent/workflowHeaderLayout.test.ts web/test/agent/workflowHeaderNavigation.test.ts web/test/agent/workflowHeaderState.test.ts web/test/agent/workflowGraph.test.ts web/test/agent/workflowMotion.test.ts web/test/agent/workflowVisuals.test.ts` | 0 | `8 passed; 70 passed` | 2026-09-12；终端输出，未生成文件 |
| T28-A02 | recorder 到 reducer 与嵌套边投影 | `pnpm exec vitest run --config docs/plan/main-agent-runtime-diagram/verify/vitest.config.ts docs/plan/main-agent-runtime-diagram/verify/workflowRecorder.test.ts` | 0 | `1 passed; 8 passed` | 2026-09-12；终端输出，未生成文件 |
| T28-A03 | 全量 Web 回归 | `pnpm test:web -- --reporter=dot` | 0 | `118 passed; 673 passed` | 2026-09-12；终端输出，未生成文件 |
| T28-A04 | 类型、受影响 lint 与 Web/Electron 构建 | `pnpm web:type-check && pnpm exec eslint web/src/features/agent/workbench/runtime-diagram/headerTemplate.ts web/src/features/agent/workbench/runtime-diagram/headerEdgeEvidence.ts web/src/features/agent/workbench/runtime-diagram/headerCircuitPlacement.ts web/src/features/agent/workbench/runtime-diagram/WorkflowHeaderNode.vue web/test/agent/workflowHeaderTemplate.test.ts web/test/agent/workflowEdgeEvidence.test.ts web/test/agent/workflowHeaderLayout.test.ts web/test/agent/workflowHeaderNavigation.test.ts web/test/agent/workflowVisuals.test.ts docs/plan/main-agent-runtime-diagram/verify/workflowRecorder.test.ts && pnpm web:build` | 0 | `vue-tsc -b --noEmit`; ESLint 0 errors; `built in 8.47s` | 2026-09-12；`dist/web/`、`web/dist-electron/` |
| T28-A05 | 平面几何、计划与文档完整性 | `node docs/plan/main-agent-runtime-diagram/verify/analyze-circuit.cjs && node tools/plan-viewer/lint-source.mjs && node docs/plan/main-agent-runtime-diagram/verify/check-doc-links.mjs && git diff --check` | 0 | `34 vertices; 49 edges; 84 segments; 0 crossings`; `Passed: 3 new/changed documentation links and anchors` | 2026-09-12；终端输出，未生成文件 |

## T29 自动验证记录（2026-09-13）

| 编号 | 目标 | 命令 | 退出码 | 关键断言行 | 日期与产物路径 |
| --- | --- | --- | --- | --- | --- |
| T29-A01 | 审批/CRT 完整折叠链、平移缩放与渲染所有权 | `pnpm test:web -- workflowAttentionAnchor workflowGraph` | 0 | `2 passed; 35 passed` | 2026-09-13；终端输出，未生成文件 |
| T29-A02 | 全量 Web 回归 | `pnpm test:web` | 0 | `118 passed; 691 passed` | 2026-09-13；终端输出，未生成文件 |
| T29-A03 | 类型、受影响 lint 与 Web/Electron 构建 | `cmd /c "pnpm web:type-check && pnpm exec eslint web/src/features/agent/workbench/runtime-diagram/RuntimeDiagram.vue web/src/features/agent/workbench/runtime-diagram/WorkflowAnchoredOverlays.vue web/src/features/agent/workbench/runtime-diagram/WorkflowHeaderStepNode.vue web/src/features/agent/workbench/runtime-diagram/WorkflowLiveCrt.vue web/src/features/agent/workbench/runtime-diagram/graphModel.ts web/src/features/agent/workbench/runtime-diagram/headerGraph.ts web/src/features/agent/workbench/runtime-diagram/useWorkflowNodePresentation.ts web/test/agent/workflowAttentionAnchor.test.ts web/test/agent/workflowGraph.test.ts web/test/agent/workflowVisuals.test.ts && pnpm web:build"` | 0 | `vue-tsc -b --noEmit`; ESLint 0 errors / 0 warnings；Web/Electron `built` | 2026-09-13；`dist/web/`、`web/dist-electron/` |
| T29-A04 | 文档、计划与空白完整性 | `cmd /c "node docs/plan/main-agent-runtime-diagram/verify/check-doc-links.mjs && pnpm plan:lint && git diff --check"` | 0 | 文档链接通过；`Plan Lint 通过`；diff 无错误 | 2026-09-13；终端输出，未生成文件 |

## T30 自动验证记录（2026-09-13）

| 编号 | 目标 | 命令 | 退出码 | 关键断言行 | 日期与产物路径 |
| --- | --- | --- | --- | --- | --- |
| T30-A01 | Vue Flow store 响应式容器与锚点/导航回归 | `pnpm test:web -- workflowAttentionAnchor workflowHeaderNavigation` | 0 | `2 passed; 30 passed` | 2026-09-13；终端输出，未生成文件 |
| T30-A02 | Web 类型与受影响 ESLint | `pnpm web:type-check`；`pnpm exec eslint web/src/features/agent/workbench/runtime-diagram/RuntimeDiagram.vue web/test/agent/workflowAttentionAnchor.test.ts` | 0 | `vue-tsc -b --noEmit`；ESLint 0 errors / 0 warnings | 2026-09-13；终端输出，未生成文件 |
| T30-A03 | 全量 Web 回归与 Web/Electron 构建 | `pnpm test:web`；`pnpm web:build` | 0 | `118 passed; 692 passed`；Web/Electron `built` | 2026-09-13；`dist/web/`、`web/dist-electron/` |

## 2026-09-14 用户反馈修正验证记录

### CRT 活动生命周期修正

| 编号 | 目标 | 命令 | 退出码 | 关键断言行 | 日期与产物路径 |
| --- | --- | --- | --- | --- | --- |
| F01 | CRT 仅在 activeLiveTurn 时挂载的定向回归 | `pnpm test:web -- workflowAttentionAnchor workflowGraph workflowVisuals`（含 118 文件全量并发） | 1（仅 unrelated performanceRecovery 2k 性能预算 1858ms>1500ms，资源争用；单跑通过见 F02） | `workflowAttentionAnchor`「stays visible until pending work clears」「shows the CRT only while the active model node has a live streaming turn」均通过 | 2026-09-14；终端输出，未生成文件 |
| F02 | performanceRecovery 单文件复跑（隔离负载） | `node_modules/.bin/vitest.cmd run --config web/vitest.config.ts web/test/nyxus/graph/performanceRecovery.test.ts --reporter=dot` | 0 | `1 passed; 5 passed` | 2026-09-14；终端输出，未生成文件 |
| F03 | Web 类型检查 | `pnpm web:type-check` | 0 | `vue-tsc -b --noEmit` 无错误 | 2026-09-14；终端输出，未生成文件 |
| F04 | 受影响 ESLint | `node_modules/.bin/eslint.cmd web/src/features/agent/workbench/runtime-diagram/useWorkflowNodePresentation.ts web/test/agent/workflowAttentionAnchor.test.ts` | 0 | 0 errors / 0 warnings | 2026-09-14；终端输出，未生成文件 |
| F05 | 计划与文档完整性 | `node tools/plan-viewer/lint-source.mjs && node docs/plan/main-agent-runtime-diagram/verify/check-doc-links.mjs && git diff --check` | 0 | `Plan Lint 通过`；`Passed: 2 new/changed documentation links and anchors`；diff 无错误 | 2026-09-14；终端输出，未生成文件 |

### 循环点亮顺序修正

| 编号 | 目标 | 命令 | 退出码 | 关键断言行 | 日期与产物路径 |
| --- | --- | --- | --- | --- | --- |
| G01 | recorder 回归：context 延后到准备请求、checkpoint 单一 occurrence | `PYTHONIOENCODING=utf-8 npx vitest run test/service/chat/workflowRecorder.test.ts` | 0 | `7 passed`（含「records context at request preparation, after the loop input, as a run-level fact」「shares one checkpoint occurrence between the boundary and the tool-result message commit」） | 2026-09-14；终端输出，未生成文件 |
| G02 | 端到端点亮顺序（recorder→journal→state/evidence，含 loop2 灰化） | `PYTHONIOENCODING=utf-8 npx vitest run --config docs/plan/main-agent-runtime-diagram/verify/vitest.config.ts` | 0 | `6 passed; 29 passed`（新增 `workflowLightingOrder.test.ts`：context firstSequence 位于 input 后；checkpoint 单一 occurrence 且 channels:checkpoint 与 tool-result:checkpoint 指向同一 target；loop2 时上一轮工具链/内容记录/继续判断全部 idle 灰色） | 2026-09-14；终端输出，未生成文件 |
| G03 | 前端证据/状态回归 | `PYTHONIOENCODING=utf-8 npx vitest run web/test/agent --config web/vitest.config.ts` | 0 | `39 passed; 183 passed`（含「proves both checkpoint inputs on one shared occurrence」「returns a previous loop chain to gray idle when the next loop starts」） | 2026-09-14；终端输出，未生成文件 |
| G04 | 类型检查 | `pnpm type-check && pnpm web:type-check` | 0 | `tsc --noEmit` 与 `vue-tsc -b --noEmit` 无错误 | 2026-09-14；终端输出，未生成文件 |

### CRT 归属与排版修正

| 编号 | 目标 | 命令 | 退出码 | 关键断言行 | 日期与产物路径 |
| --- | --- | --- | --- | --- | --- |
| H01 | CRT 锚点归属大模型响应节点与折叠代表链回归 | `PYTHONIOENCODING=utf-8 npx vitest run web/test/agent --config web/vitest.config.ts` | 0 | `39 passed; 190 passed`（新增 response 折叠代表链 6 例与「CRT 锚点落在 `visibleTemplateAnchor(graph,'response')` 可见代表」断言） | 2026-09-14；终端输出，未生成文件 |
| H02 | Web 类型检查 | `pnpm web:type-check` | 0 | `vue-tsc -b --noEmit` 无错误 | 2026-09-14；终端输出，未生成文件 |
| H03 | CRT 段落空隙修正（块间换行文本节点折叠） | `node_modules/.bin/eslint.cmd web/src/features/agent/workbench/runtime-diagram/WorkflowLiveCrt.vue`；`git diff --check` | 0 | ESLint 0 错误 / 0 警告；diff 无错误。pre-wrap 仅保留于 p/h1-h6/li/blockquote/th/td 文本块内部，块间空白文本节点不再渲染为空行 | 2026-09-14；终端输出，未生成文件 |
| H04 | 大模型响应节点实时输出期间点亮 | `PYTHONIOENCODING=utf-8 npx vitest run web/test/agent/workflowGraph.test.ts web/test/agent/workflowAttentionAnchor.test.ts --config web/vitest.config.ts`；`pnpm web:type-check`；`node_modules/.bin/eslint.cmd web/src/features/agent/workbench/runtime-diagram/headerGraph.ts web/test/agent/workflowGraph.test.ts` | 0 | headerGraph.ts 将 liveTurn 同时挂到 model 与 response 节点；workflowGraph 断言 response.liveTurn 与模型一致；类型检查与 ESLint 0 错误 | 2026-09-14；终端输出，未生成文件 |

### 协作横排布局修正

| 编号 | 目标 | 命令 | 退出码 | 关键断言行 | 日期与产物路径 |
| --- | --- | --- | --- | --- | --- |
| K01 | 全 256 展开组合路由/标签回归 | `node docs/plan/main-agent-runtime-diagram/verify/debug-mask-sweep.cjs` | 0 | `failures: 0/256` | 2026-09-14；终端输出，未生成文件 |
| K02 | 端口 offset 越界扫描（全 256 组合） | `node docs/plan/main-agent-runtime-diagram/verify/debug-port-offset.cjs` | 0 | `violations: 0` | 2026-09-14；终端输出，未生成文件 |
| K03 | 布局定向回归 | `pnpm vitest run test/agent/workflowHeaderLayout.test.ts`（web/） | 0 | `5 passed`（含全组合关系守恒/零交叉/弯折上限；collab 横排断言） | 2026-09-14；终端输出，未生成文件 |
| K04 | 尺寸与弯折抽查 | `node docs/plan/main-agent-runtime-diagram/verify/measure-masks.cjs` | 0 | mask-31 graph 2987×2280；mask-255 全展开 graph 2999×2280（宽 <3000、高 <2576 达标）；collab 776×200 横排；tools ≤3 弯、其余 ≤4 弯 | 2026-09-14；终端输出，未生成文件 |
| K05 | 类型、受影响 lint 与 Web/Electron 构建 | `pnpm web:type-check`；`pnpm --filter web exec eslint --fix src/features/agent/workbench/runtime-diagram/headerCircuitPlacement.ts test/agent/workflowHeaderLayout.test.ts`；`pnpm web:build` | 0 | `vue-tsc -b --noEmit` 无错误；ESLint 0 errors / 0 warnings；Web/Electron `built` | 2026-09-14；`dist/web/`、`web/dist-electron/` |
| K06 | 计划与文档完整性 | `node tools/plan-viewer/lint-source.mjs && node docs/plan/main-agent-runtime-diagram/verify/check-doc-links.mjs && git diff --check` | 0 | `Plan Lint 通过`；`Passed: 0 new/changed documentation links and anchors`；diff 无错误 | 2026-09-14；终端输出，未生成文件 |

## 头部空间压缩与结果链对齐验证记录（2026-09-15 用户截图反馈）

| 编号 | 目标 | 命令 | 退出码 | 关键断言 | 日期与产物路径 |
| --- | --- | --- | --- | --- | --- |
| L01 | 256 种展开组合路由与端口合法性 | `node docs/plan/main-agent-runtime-diagram/verify/debug-mask-sweep.cjs`；`node docs/plan/main-agent-runtime-diagram/verify/debug-port-offset.cjs` | 0 | `failures: 0/256`；`violations: 0` | 2026-09-15；终端输出与 `verify/out/debug-masks.json` |
| L02 | 新布局契约与模板回归 | `pnpm test:web -- workflowHeaderLayout workflowHeaderTemplate` | 0 | `2 passed; 8 passed` | 2026-09-15；终端输出，未生成文件 |
| L03 | Web 全量回归与性能隔离复跑 | `pnpm test:web -- --reporter=dot`；连续 5 次 `pnpm test:web -- performanceRecovery --reporter=dot` | 1；0 | 全量 `117 passed / 118 files`、`701 passed / 702 tests`，唯一失败为并发负载下既有 2k 性能预算；隔离连续 5 轮均 `1 file / 5 tests` 通过 | 2026-09-15；终端输出，未生成文件 |
| L04 | 类型、受影响 lint 与 Web/Electron 构建 | `pnpm --filter web type-check`；受影响文件 `pnpm exec eslint ...`；`pnpm web:build` | 0 | `vue-tsc -b --noEmit` 无错误；ESLint 0 errors / 0 warnings；Web/Electron `built` | 2026-09-15；`dist/web/`、`web/dist-electron/` |
| L05 | 错误判断左移与垂直通道拉直 | `pnpm test:web -- workflowHeaderLayout workflowHeaderTemplate`；`debug-mask-sweep.cjs`；`debug-port-offset.cjs`；`measure-masks.cjs`；类型检查与受影响 ESLint | 0 | 定向 `2 files / 8 tests`；`failures: 0/256`；`violations: 0`；`retry-layer:channels:checkpoint` 从 4 次弯折降为 0；全展开宽度 2823→2791 | 2026-09-15；终端输出，未生成文件 |

## 2026-09-15 Pixi 主树返工自动验证

- `pnpm test:web`：并发运行时仅 2k 性能用例受资源竞争超时；随后保持 1500ms 门槛，以 `--no-file-parallelism` 串行复跑，118 个文件、704 项全部通过。
- `pnpm exec vitest run test/service/chat/workflowRecorder.test.ts test/service/chat/flowSync.test.ts`：14 项通过，journal 记录语义与 root 事件流未改变。
- `pnpm --filter web build`：Web、Electron main 与 preload 构建成功。
- 定向 lease 测试确认隐藏/暂停时调用 `workflow.close`、清空 live/projection/replay，恢复可见后重新 `workflow.open`。

## 冻结文件 SHA-256 基线（A07，方案 B 重登记）

| 文件 | SHA-256 |
| --- | --- |
| `web/src/features/pets/nyxus/public.ts` | `88D2DF3864417CB392E02E30EC9B9CB6DB87EAB3212AEF605C20E9CED26856C5` |
| `web/src/features/pets/nyxus/paper/readerProjection.ts` | `AA83584F1785278023B9F9EC7A24B6CCB1495EDE6B80903CEA73F04589B220D7` |
| `web/src/features/pets/nyxus/components/NodePaperStack.vue` | `5D817E5955A960831F073D2BA8EDA27F0E3C5DC9306BDC0E78E966D1F6B2C020` |
| `web/src/features/pets/nyxus/components/NodePaperStack.styles.less` | `2DF9DDAFC89D8C2E9332A43E1E51A135EAAC82641CC5BCD82155A5DF4016505D` |
| `web/src/features/agent/workbench/useWorkbenchViewPreferences.ts` | `3575E8743C0F3402F8E5CF85CA79F88BC45FE5A987BC4E13392489677EBC559A` |

## 备注

- 验证环境为 Windows，`pnpm exec` 未找到工具但已安装的可执行入口可用；测试实际调用 `node_modules/.bin/vitest.cmd run --config web/vitest.config.ts --reporter=dot`；Vite 构建通过公开 API 在 `web/` 执行 `node -e "import('vite').then(v=>v.build({logLevel:'warn'}))"`。
- 未启动或操控图形界面、未读取图片、未访问用户数据库；后端验证只使用内存 mock 与隔离 fixture。
- 与后端正式回归相关的 `test/service/chat/workflowRecorder.test.ts` 与 `test/service/chat/flowSync.test.ts` 位于正式测试目录，随任务收口保留。
