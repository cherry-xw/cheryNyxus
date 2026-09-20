# context-usage-analytics 自动验证输出

任务收口于 2026-09-20，由用户直接批准标记完成（人工综合验收未单独执行）。以下为各批次已执行的定向验证记录，命令、退出码与断言行摘自 `docs/plan/context-usage-analytics/README.md` 执行记录，原任务目录已删除。

## D1（大面板假数据 Demo）

- 命令：`pnpm exec vitest run --config web/vitest.config.ts web/test/workbench/contextAnalyticsModel.test.ts web/test/workbench/taskBrowser.test.ts web/test/workbench/taskBrowserIntegration.test.ts`
- 退出码：0 / 3 个文件、17 条测试通过
- 命令：`pnpm web:type-check`，退出码 0
- 命令：ESLint 检查 context-analytics 目录，退出码 0
- 命令：`pnpm exec prettier --check ...`，退出码 0

## D2（全部任务卡片及筛选）

- 命令：`pnpm web:type-check`，退出码 0
- 命令：`pnpm exec vitest run --config web/vitest.config.ts web/test/workbench/contextAnalyticsModel.test.ts web/test/workbench/contextAnalyticsPublic.test.ts`
- 退出码：0 / 2 个文件、8 条测试通过

## D3（每日热力图 Demo）

- 命令：`pnpm web:type-check`，退出码 0
- 命令：`pnpm exec vitest run --config web/vitest.config.ts web/test/workbench/contextDailyUsage.test.ts web/test/workbench/taskBrowser.test.ts`
- 退出码：0 / 2 个文件、13 条测试通过（日期边界、闰日、366 天上限、跨日请求）

## D4–D6（真实采集、只读接口与真实接入）

- 命令：`pnpm vitest run test/service/chat/usage.test.ts`
- 退出码：0 / 旧任务 2 次请求、新空任务 0 次且不串联
- 命令：`pnpm exec vitest run --config web/vitest.config.ts web/test/workbench/contextAnalyticsPublic.test.ts web/test/workbench/contextDailyUsage.test.ts web/test/workbench/contextDailyChart.test.ts web/test/workbench/taskBrowserIntegration.test.ts`
- 退出码：0 / 4 文件、15 条测试通过
- 命令：`pnpm type-check`、`pnpm web:type-check`、`git diff --check`，退出码 0
- 命令：`pnpm exec vitest run --config web/vitest.config.ts web/test/workbench/contextContentModel.test.ts web/test/workbench/contextAnalyticsPublic.test.ts web/test/workbench/contextAnalyticsModel.test.ts web/test/workbench/taskBrowserIntegration.test.ts`
- 退出码：0 / 4 文件、15 条测试通过
