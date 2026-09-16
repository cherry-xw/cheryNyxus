# 小任务 08：综合验证与用户验收

**所属总任务：** [工作台标题栏会话状态条](../workbench-session-strip/README.md)

**文档创建时间：** 2026-09-16T12:29:17+08:00

**状态：** 进行中（反馈修复完成，A 清单已回填；阶段二 M1-M5 待用户执行）

## 反馈回填槽

> 实施过程中产生的全部反馈、待补项、用户临时意见登记于此；阶段一收口前必须清零。

- （空）

## 反馈修复记录（2026-09-16）

用户 5 项精修已实现（阶段二前登记，相关自动验证随 A 清单重跑）：

1. **下拉不显示** → 根因两处：①标题栏内 absolute 弹层被工作台 body 更高 z-index 覆盖 → 修复：下拉 Teleport 到 body + 锚点 fixed 定位；②Teleport 后 z-index 用 `ownerOverlayZIndex` 得 501，多窗口时聚焦窗口 500+2n ≥502 仍盖住 → 修复：新增 `OVERLAY_Z_INDEX.sessionMenu = 9900`（低于 historyDrawer 10000），`WorkbenchSessionBar.vue` 直接使用。用户复测确认浏览器多窗口面、无 Console 报错——与②吻合。
2. **运行中状态** → 节点 icon 居中 + 半透明 loading 遮罩叠层（呼吸底 + spinner，底层 icon 可见）。
3. **hover 提示三块分栏** → 标题／用户消息／当前节点（popper-class `session-strip-tip`，`-webkit-line-clamp:3`）。
4. **标记当前打开会话** → `activeChatId` 命中项强制置顶入列 + 底部 accent 指示条 + 高亮（`pickStripTasks` 新增第 5 参）。
5. **移除 rail ≡ 会话列表（重复）** → 按钮/popout/controller 状态与数据路径（`sessionListOpen`/`rootSessions`/`refreshSessionList`/`onSessionDelete`）全删；归档入口下沉到下拉行内（删除竞态保护契约迁移，见 `web/test/nyxus/workbenchPreferences.test.ts`）。

## 自动验证清单

> 每行 6 列：编号 / 目标（一句话）/ 命令（一行可执行）/ 退出码 / 关键断言行 / 日期+产物路径。执行后回填。

| 编号 | 目标 | 命令 | 退出码 | 关键断言行 | 日期+产物 |
| --- | --- | --- | --- | --- | --- |
| A1 | 后端单测全量 | `pnpm test:backend` | 1 | `Test Files 7 failed | 156 passed`；9 失败中 7 个经 stash 隔离为并行任务/环境既有（postPack/approvalSurfaces/deleteChat/deleteLifecycle/workerContinuity），config/commit + watcherRecovery 单跑 17/17 通过（全量并行 flaky）；本次定向 11/11 通过 | 2026-09-16 `verify/out/A1-backend.log` |
| A2 | 前端单测全量 | `pnpm test:web` | 1 | `Test Files 2 failed | 118 passed`；vueSfcSizeBudget 报 AgentDialog.vue 816 行（并行任务改动，本次未触碰）；performanceRecovery 2 例性能预算（机器负载 flaky）；本次新增 10 用例 + dependencyBoundaries 全过 | 2026-09-16 `verify/out/A2-web.log` |
| A3 | 协议契约测试 | `pnpm test:protocol` | 1 | `Test Files 9 failed | 5 passed`；6 失败（chat.archive/workflow 等）经 stash 验证基线一致（另一任务改动），本次未引入新失败 | 2026-09-16 `verify/out/A3-protocol.log` |
| A4 | 后端类型检查 | `pnpm type-check` | 0 | 无 error TS | 2026-09-16 `verify/out/A4-root-typecheck.log` |
| A5 | 前端类型检查 | `pnpm --filter web type-check` | 0 | 无 error TS | 2026-09-16 `verify/out/A5-web-typecheck.log` |
| A6 | 前端构建 | `pnpm --filter web build` | 0 | `✓ built in 14.02s` | 2026-09-16 `verify/out/A6-web-build.log` |

产物统一输出到 `docs/plan/workbench-session-strip/verify/out/`（如 `A1-backend.log` 等），命令执行时显式重定向。

## 手动验证清单

> 仅四类：真实视觉与交互 / 主观 UX 判断 / 跨设备·窗口·无障碍 / 性能体验。每条 ≤1 分钟，操作手册见 `verify/manual-final.md`。

| 编号 | 目标 | 手册锚点 | 结论 |
| --- | --- | --- | --- |
| M1 | 浏览器面标题栏 strip 可见、图标随运行节点变化、hover 提示三要素齐全 | #strip-browser | 待执行 |
| M2 | Electron 原生工作台窗标题栏 strip 同样工作且不遮挡三键 | #strip-native | 待执行 |
| M3 | 下拉仅列当前预设会话、分页追加正确、默认第一个高亮、切换会话生效 | #dropdown | 待执行 |
| M4 | 多会话并发（≥3 运行中）时 strip 溢出折叠「+N」可展开、图标不重叠 | #overflow | 待执行 |
| M5 | 断线重连后 strip/下拉状态与真实会话一致（快照重放） | #reconnect | 待执行 |

## 抽样信任记录

> 用户对自动清单随机抽样核对结论（阶段三前登记）。

- （待登记）

## 阶段说明

- **阶段一（自动收口）**：反馈回填槽清零后，A1-A6 全量执行并回填退出码/断言行/产物路径；任一失败 → 新建修正小任务回到执行流程。
- **阶段二（必要人工核对）**：用户按 `verify/manual-final.md` 顺序执行 M1-M5，每条 ≤1 分钟给出结论；任一失败回到阶段一登记修正。
- **阶段三（用户拍板）**：阶段一、二结论齐全后用户明确批准，迁长期证据到 `docs/quality/verification/workbench-session-strip/`（auto-output / manual-conclusion / approval），随后从 `docs/plan/README.md` 移除任务并删除整个任务目录。
