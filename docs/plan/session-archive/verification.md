# 综合验证与用户验收

所属：[会话归档管理](README.md)。状态：进行中。

## 自动验证

2026-09-09 已完成：

- `pnpm type-check`、`pnpm web:type-check`：通过。
- `node_modules/.bin/vitest.cmd run --config docs/plan/session-archive/verify/vitest.config.ts`：3 项通过，覆盖整组归档、只读纪元、可靠重试、分页与嵌套任务分支归属。
- `node_modules/.bin/vitest.cmd run --config web/vitest.config.ts web/test/settings/archive.test.ts web/test/architecture/settingsTabVisibility.test.ts web/test/interactionSafety.test.ts`：19 项通过。
- 归档相关后端与前端文件定向 ESLint、Prettier：通过。
- `pnpm build`、`pnpm web:build`：通过；大 chunk 提示与后端原生模块占用提示不阻塞产物生成。

按项目测试基线，没有修改或运行暂缓的 `test/`。

## 人工验证

由用户执行 [人工验收手册](verify/manual-final.md)。浏览器与 Electron 的布局、主题、窗口生命周期和真实跨窗口交互全部通过后，在本文记录日期与结论，再删除本文并将总任务推进到“待用户审批”。

完成标准：手册中的必要场景全部通过，失败项已登记为新的修正小任务。
