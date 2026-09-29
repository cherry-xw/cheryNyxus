# 精简模式工具展示层重构

**文档创建时间：** 2026-09-28T21:15:00+08:00

**状态：** 待综合验证

## 目标与边界

重构前端工作台**精简模式**的工具展示层，覆盖三块内容：

1. **工具线框标记**：点击工具查看详情时，把对应工具用线框框起来，不做图标变色。
2. **正文消失 bug 修复**：工具节点详情正文点「查看完整正文」后消失的问题（根因：tool-batch 节点后端 content 为空，前端误以为能拉到全文）。
3. **抽屉工具展示层重构**（破坏性修改）：重新设计精简模式详情抽屉的工具展示，含待办类、写文件、工具链分割线、简介入口、内置工具专有 UI、第三方工具通用渲染。

**边界（已与用户确认）：**
- 改动方式：**破坏性修改**，不留双轨兼容。
- 范围：**仅精简模式**（cluster 小按钮 + 详情抽屉）。树视图、对话视图的工具渲染器**不调整**。
- 耗时显示：**不展示不可靠耗时**（抽屉去掉耗时显示；运行中节点保留实时显示）。不做后端耗时修复。
- 写文件 diff：有 `__filePreview`（审批预览）用真实 diff，无则全部标「新增」。纯前端。
- 内置工具专有 UI：本次全部 8 类（待办 / 写文件 / 命令 / 读文件 / 媒体 / 搜索 / 角色 / 技能）。
- 交互约束（重构中必须保留）：抽屉内审批/提问交互（LiteInteractionView）、工具调用分页加载（resultHasMore/expandResult）、点击工具定位高亮（focusToolCallId）。

## 批次与执行顺序

- **批次一（相互独立）**：T2 线框 → T1 正文 bug → T3 标题栏
- **批次二（依赖抽屉工具链结构）**：T4 工具链容器与第三方通用渲染
- **批次三（依赖 T4 的分发机制）**：T5a 待办+写文件 → T5b 其余内置工具
- **批次四（最后）**：T6 综合验证与用户验收

## 小任务台账

| 编号 | 小任务 | 复杂度 | 依据 | 依赖 | 状态 |
| --- | --- | --- | --- | --- | --- |
| T1 | 修复工具节点正文消失 bug | 1 | 单文件局部修改（DetailDrawer.vue），去除误导性「查看完整正文」fetch 流程，低风险 | 无 | 已完成 |
| T2 | 工具线框标记 | 1 | 样式+模板局部（LiteView.vue / LiteView.styles.css），选中态从图标变亮改为线框 | 无 | 已完成 |
| T3 | 抽屉标题栏重构 | 2 | DetailDrawer 标题栏模板结构变更（去状态/tag/耗时，改响应上下文），需保持正文/思考分节不变 | 无 | 已完成 |
| T4 | 工具链容器、分割线与第三方工具通用渲染 | 4 | 核心展示层重构，跨多个组件（新增容器/分发、简介入口改造、重构 LiteToolCallDetail），需保持审批/提问交互、分页加载、focus 高亮 | T3 | 已完成 |
| T5a | 内置工具专有 UI：待办 + 写文件 | 3 | 两个新组件，参考树/对话既有渲染器与卡片；写文件含 diff（有预览真实 diff、无预览标新增） | T4 | 已完成 |
| T5b | 内置工具专有 UI：命令/读文件/媒体/搜索/角色/技能 | 4 | 六个新组件，每种工具参数结构不同，需逐个解析并按类型展示 | T4 | 已完成 |
| T5c | 补齐全部内置工具专有展示 | 3 | 修正遗漏：内置工具权威清单中的历史回忆、子角色控制、记忆管理、安装技能、角色验收、会话选择此前仍走通用展示；新增专有内容展示并让通用折叠仅留给外部工具 | T5b | 已完成 |
| T6 | 综合验证与用户验收 | 3 | 汇总自动验证清单 + 人工操作卡 + 抽样信任，三阶段推进 | T5a, T5b, T5c | 进行中 |

## 当前恢复检查点

- 已完成：需求分析、关键决策（破坏性修改 / 仅精简模式 / 耗时不展示 / diff 策略 / 内置工具专有 UI）、计划建立；T1 正文 bug、T2 线框、T3 标题栏、T4 工具链+外部工具通用渲染、T5a 待办+写文件、T5b 命令/读文件/媒体/搜索/角色/技能，以及修正任务 T5c 补齐剩余内置工具专有展示。T5c 自动验证结果见下文；T6 综合验证与用户人工验收仍待完成。
- 2026-09 用户实测反馈一轮已实施：所有工具工具链分割线改为「图标 + 中文名」（提问工具用问号气泡图标，cluster 与抽屉一致）；提问工具参数去掉「参数」折叠直接展示、简介去 ▸、安全去圆点；config_manage 参数直接展示（action 显示「获取配置参数（get）」）；通用样式去除所有「左侧高亮竖线」（工具卡焦点左竖线、选项补充说明左线、审批风险摘要左线）。
- 2026-09 用户原则反馈已实施：内置工具头部去掉「简介/详情」折叠按钮，执行结果直接全量展示；命令输出、读文件内容、媒体提示词、搜索结果、技能指令等二级折叠已平铺。复核权威清单后补齐历史回忆、子角色控制、记忆管理、技能安装、角色验收、会话选择专有 UI；通用简介/参数折叠/结果预览限定为外部工具。更正范围：`src/agent/sense/index.ts` 当前列出 16 个内置 sense；精简模式另外覆盖 3 个媒体生成工具。
- T5c 自动记录：`pnpm web:type-check` 退出码 0；`pnpm web:build` 退出码 0；受影响文件 `npx eslint` 退出码 0；`npx vitest run test/lite/builtinToolNames.test.ts test/lite/toolRendering.test.ts test/lite/detailSections.test.ts` 退出码 0（37 通过）；完整 `test/lite` 为 90 通过、2 失败（`clusterNodeIcon is not a function` 旧 API 测试）；`pnpm docs:check-plan` 退出码 0。
- 当前仍需：T6 综合验证抽样和用户人工验收（见 [manual-final](verify/manual-final.md) M1–M20）。`pnpm docs:check-links` 失败于 `docs/plan/workbench-files-terminal/T07-verification.md` 的 4 个缺失 verify/out 日志链接，均不在本任务范围。
- 自动验证结论：`pnpm web:type-check` 全量报错全部集中在 nyxus（他人 foldProjection 重构中），lite/ 与 ToolDescriptionDisclosure 零错误；`pnpm test:web` 失败全部来自他人改动（workbench/runtime-diagram/nyxus/后端）或存量（clusterIcons 旧 API、vueSfcSizeBudget 的 LiteView.vue 826 行、uiRegressionFixes 与 colorReadability 相对路径 bug），无本任务引入的失败；受影响文件 ESLint 干净；`pnpm docs:check-plan` 通过；`pnpm docs:check` 我的计划文档无问题，剩余 links/structure 问题全在他处。

## 最终综合验证

见 T6。自动验证入口：`pnpm web:type-check`、`pnpm test:web`、`pnpm web:build`、受影响 ESLint、`pnpm docs:check`。浏览器/Electron 实机操作、视觉与交互验收由用户执行（项目图片验证边界：AI 不截图不读图），人工操作卡见 [manual-final](verify/manual-final.md)。

## 用户审批

按显式审批关口执行。全部必要验证通过后进入「待用户审批」，用户明确批准后收口。
