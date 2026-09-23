# 协议与后端时间线投影

**文档创建时间：** 2026-09-22T00:00:00+08:00

**状态：** 待定向验证

**复杂度：** 5 —— 修改共享时间线类型、历史重建、持久执行节点 payload、Lite 投影，并必须保持刷新/重连恢复。

## 所属总任务

[`docs/plan/workbench-todo-progress/README.md`](README.md)

## 范围与非目标

- 范围：为 `update_todo` 计划、任务项和执行节点建立稳定 `planId`/`itemId` 归属，并下发到完整时间线和 Lite 投影。
- 非目标：不改 Agent 要求的工具入参，不新增数据库表，不删除现有桌宠或历史 Todo 展示。

## 剩余步骤

- [x] 扩展后端 `GraphToolCall`、`TimelineNode` 和响应 schema 类型。
- [x] 在 `buildRootTimeline` 中按每个 Agent 的时间线生成可重建的计划引用，并写入工具调用/节点 payload。
- [x] 同步 Lite 设备投影字段。
- [x] 同步前端 API 类型并运行定向类型检查。

## 完成标准

- 相同历史输入每次重建产生相同的 `planId`/`itemId`。
- 主 Agent 与子 Agent 的任务归属不会互相覆盖。
- `chat.timeline.get`、`chat.open` 恢复和 Lite 投影都能读取归属字段。
- 旧数据缺少字段时仍可正常展示，不因协议扩展失败。

## 定向自动验证

- `pnpm type-check`
- `pnpm --filter web type-check`
- `git diff --check`

## 本批次执行记录

- `pnpm type-check` — 退出码 0 — 后端类型检查通过。
- `pnpm --filter web type-check` — 退出码 0 — 前端类型检查通过。
- `git diff --check` — 退出码 0 — 无空白错误。
