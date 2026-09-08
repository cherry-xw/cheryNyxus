# 综合验证与用户验收

所属总任务：[前端交互与颜色逻辑修正](README.md)。状态：进行中。依赖：01、02、03、04、06 已完成并删除。

## 范围与非目标

对当前可提交工作区执行最终代码级回归，并集中承载唯一一批用户人工 UI 验收。不启动产生真实费用或修改用户数据的任务，不把历史截图或旧构建作为当前结论。

## 自动验证清单

- [x] 前端全量测试：`pnpm test:web --reporter=dot`。
- [x] 前端类型检查：`pnpm web:type-check`。
- [x] 浏览器生产构建：`pnpm --filter web exec cross-env ELECTRON_ENABLED=false vite build --outDir ../docs/plan/frontend-interaction-color-audit/verify/out/build`。
- [x] 本轮变更源码的 ESLint 和 Prettier 检查。
- [x] 持久文档及当前 Plan 的本地链接、旧引用、`docs/plan/` 忽略与未跟踪状态检查。

最新结果：前端测试 100 个文件 / 566 项通过；类型检查和生产构建通过，构建保留现有的大 chunk 提示；改动文件 ESLint 为 0 error，仅 `useMessageBranchTreeController.ts` 保留 3 条既有 warning；Prettier 检查通过；17 份变更文档的 107 个本地链接有效；`git diff --check` 通过，`docs/plan/` 保持忽略且无跟踪文件。

自动验证不得启动或操控浏览器/Electron，不得截图、录屏、像素比对或运行浏览器 UI 自动化。无法执行或失败的项目必须记录实际结果，不得推定通过。

## 手动验证清单

- [ ] 由用户按[统一人工 UI 验收手册](verify/manual-final.md)完成双主题、键盘、视口、多窗口、断连、保存与交互操作矩阵，并记录结论。

这是本总任务唯一的人工步骤。代码提交不等待该步骤完成，最终任务审批必须等待。

## 完成标准

自动验证全部通过且用户完成必要的 UI 验收。发现问题时将总任务退回 `执行中` 并创建新的修正小任务；全部通过后把验证摘要写回总任务、删除本文件并进入用户审批。
