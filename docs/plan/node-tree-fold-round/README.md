# 节点树折叠系统：轮次档位替换与阅读导航设计点

**文档创建时间：** 2026-09-28T22:45:30+08:00

**状态：** 待综合验证

## 目标与边界

工作台节点树折叠系统引入「轮次档位」：把已结束的每一轮对话压缩为一个三段式轮次节点（用户提问 / 内部步骤左轮 / 主 Agent 最终结论），并**替换**现有第四档「只看每轮主线」，删除 `full` 档位实现。折叠档位最终为四档：完整展示 / 局部收纳 / 按参与者收纳 / 轮次档位。

**非目标**：本任务不实现缩略图、按轮跳转导航、搜索定位，也不合并第二/三档；这些仅记录为[需求设计点](./design-points.md)供后续分析。

## 子任务台账

| 编号 | 子任务 | 状态 | 复杂度 | 依据 |
| --- | --- | --- | --- | --- |
| A | 调研分析与需求设计点记录（四档必要性 + 缩略图/按轮跳转/搜索定位） | 已完成 | 2 | 纯文档产出，无代码风险；结论作为后续需求设计点 |
| B | 实现轮次档位替换第四档 | 已完成 | 4 | 破坏性替换 full：跨折叠投影/展示/详情/卡牌阅读/UI 档位/测试/契约文档，涉及四档递进铁律与运行可见性边界 |
| C | 综合验证与用户验收 | 进行中 | 2 | 已完成类型检查和 round 定向测试；仍需用户进行真实视觉与交互验收 |

## 自动验证记录

| 编号 | 目标 | 命令 | 退出码 | 关键断言行 | 日期与产物路径 |
| --- | --- | --- | --- | --- | --- |
| 1 | 检查 Nyxus 前端类型 | `cd web && pnpm run type-check` | 0 | vue-tsc 无错误 | 2026-09-29；无产物 |
| 2 | 检查折叠投影与节点布局 | `pnpm exec vitest run --config web/vitest.config.ts test/nyxus/graph/fold.test.ts test/nyxus/graph/graphLayout.test.ts --reporter=verbose` | 0 | 58 tests passed | 2026-09-29；无产物 |
| 3 | 检查第四档布局映射 | `pnpm exec vitest run --config web/vitest.config.ts test/nyxus/workbenchPreferences.test.ts -t 'uses compact columns only for the fourth fold level'` | 0 | 1 test passed | 2026-09-29；无产物 |
| 4 | 检查文档链接与结构 | `pnpm docs:check` | 1 | 4 个既有缺失日志链接，均在 `docs/plan/workbench-files-terminal/T07-verification.md` | 2026-09-29；无产物 |
| 5 | 检查工作台偏好回归文件 | `pnpm exec vitest run --config web/vitest.config.ts test/nyxus/workbenchPreferences.test.ts --reporter=verbose` | 1 | 2 项与轮次档位无关的旧源码断言失败；该文件其余 2 项通过 | 2026-09-29；无产物 |

补充执行记录：`workbenchPreferences.test.ts` 的 2 个失败断言分别检查 `workspaceBrowserOpen` 字符串不存在和已迁移的旧颜色选择器位置；断言与当前已改动工作区内容不符，且不涉及本次轮次档位。已单独执行本次档位布局映射用例并通过。类型检查与折叠/布局定向测试通过。

## 依赖

- 子任务 B 依赖 A 的结论（轮次档位收纳边界与三段式展示形态）。
- 子任务 C 依赖 A、B 完成。

## 当前恢复检查点

- 进行中子任务：C。
- 已完成事实：
  - 阶段 0 需求已确认：三段式放详情弹窗（保持 Signal 零文本）；轮次档位替换第四档（用户明确拍板破坏性修改）；结论段取主 Agent 最终回复；进行中轮次不压缩、含错误轮次压缩后标红；plan 任务承载设计点。
  - 已用探针脚本核实第四档对含子 Agent 轮次的真实折叠行为（子 Agent 内容收进各自过程组、委派/返回藏在组内）。
  - B 已完成：轮次投影、`round` 节点结构、Signal/经典/卡牌展示、档位接线、三段式详情、契约文档和定向测试均已接入。
- 剩余步骤：C 汇总验证并由用户完成真实视觉与交互验收；自动验证记录见上表，手动操作卡见 [`verify/manual-final.md`](./verify/manual-final.md)。
- 基准提交：本次改动前的当前工作区状态。

## 最终综合验证

见子任务 C。人工验证（真实视觉与交互、主观 UX、跨设备/无障碍、性能）统一汇总到 `verify/manual-final.md`。
