# workbench-session-strip 自动验证输出

任务收口于 2026-09-20，由用户直接批准标记完成（人工综合验收未单独执行）。以下为各小任务已执行的定向验证记录，命令、退出码与断言行摘自 `docs/plan/workbench-session-strip/README.md` 执行记录，原任务目录已删除。

## 01–02（后端 overview 字段与 chat.list 分页）

- 命令：`pnpm vitest run test/service/chat/overview.test.ts test/service/chat/chatListPagination.test.ts`
- 退出码：0
- 关键断言行：11/11 通过（含 lastUserPrompt 取末条、currentStepKind 更新、分页无重叠 total=25、分支排除、非法值拒绝）

## 03（前端类型同步）

- 命令：`pnpm --filter web type-check`
- 退出码：0

## 04（strip 组件）/ 05（分页下拉）

- 命令：`pnpm exec vitest run --config web/vitest.config.ts web/test/workbench/sessionStripTasks.test.ts web/test/workbench/sessionDropdown.test.ts`
- 退出码：0
- 关键断言行：6 用例全过、4 用例全过

## 06（双 surface 挂载）

- 命令：`dependencyBoundaries.test.ts`
- 退出码：0

## 07（文档同步）

- 命令：`pnpm test:protocol`
- 退出码：非 0（基线 9 suite 失败，为 chat.archive/workflow 等另一任务改动所致，本任务未引入新失败）

## 用户 5 项精修（2026-09-16）

- 命令：type-check、全量 web 测试
- 退出码：0
- 关键断言行：721 通过（仅余并行任务既有失败）

## 09（数据与行为约定）

- 命令：`pnpm plan:lint`、`git diff --check`
- 退出码：0
- 关键断言行：Plan Lint 通过：总入口 3 项、计划目录 3 个

## 10（历史检索与未查看记录）

- 命令：后端与前端类型检查、修改文件 ESLint、后端 19 个定向用例、前端 13 个定向用例、两个 RPC 的协议响应检查
- 退出码：0

## 11（稳定标题栏与状态 tip）

- 命令：`pnpm --filter web type-check`、修改文件 ESLint、`git diff --check`、`pnpm plan:lint`
- 退出码：0
- 关键断言行：4 个定向文件 20 个用例通过，依赖边界 8 个用例通过

## 12（全部任务卡片页）

- 命令：`pnpm --filter web type-check`、`pnpm --filter web build`、修改文件 ESLint、`git diff --check`、`pnpm plan:lint`
- 退出码：0
- 关键断言行：两个定向文件 12 个用例、依赖边界 8 个用例通过；`pnpm test:web` 778 项 760 通过，18 项失败均为工作区既有并行改动

## 13（双窗口接入与旧入口替换）

- 命令：`pnpm --filter web type-check`、`pnpm --filter web build`、修改文件 ESLint、`git diff --check`、`pnpm plan:lint`
- 退出码：0
- 关键断言行：任务 13 相关定向回归 42/42、依赖边界 8/8 通过；`pnpm test:web` 778 项 775 通过，剩余 3 项为任务开始前已有失败
