# Nexus 节点树维护、迁移与回滚

## 模块边界

- `web/src/stores/chats/rootTimeline.ts` 只维护 canonical snapshot、root transient plane 和 patch 原子应用；revision gap 由 store 触发 resync。
- `web/src/features/pets/nyxus/graph/executionGraph.ts` 只把显式节点、边和 active run facts 投影为 UI-neutral graph，不读取数据库结构，不按正文、时间相邻或角色名称推断关系。
- `web/src/features/pets/nyxus/graph/executionLayout.ts` 只处理稳定 lane、全局纵向顺序和坐标缓存；流式正文变化复用坐标，拓扑变化才重算。
- `web/src/features/pets/nyxus/graph/nodeSkins.ts`、`edgeStyles.ts`、`termination.ts` 和 `web/src/styles/overlayLayers.ts` 分别集中 skin、edge、termination 文案和 overlay 层级。
- `MessageBranchTree.vue` 只编排画布、HTML overlay、输入和可访问性交互，不重新构造 canonical relation。

## 性能基线

`web/test/nyxus/graph/performanceRecovery.test.ts` 使用 2,000 节点、1,999 边、8 个并发 CRT 和连续 120 次流式正文更新：

- 静态拓扑只允许一次完整 layout；120 次正文更新不得增加重算次数。
- 120 次增量刷新预算为 1,500ms（CI 硬门禁）；真实浏览器要求持续操作无明显掉帧、跳位或持续内存增长。
- 普通 CRT 最多显示 5 个，额外 3 个聚合；审批与提问等 actionable overlay 不受普通上限隐藏。

## 兼容字段

- `TimelineNode.parentNodeId` 与 `causationId` 仅用于旧数据诊断和服务端 backfill，不参与前端建边。
- 新写入必须生成显式 `ExecutionEdgeFact`；兼容读取计划保留至 2026-12-31，届时在真实数据审计无残余后移除字段。
- `createdAt` 仅用于展示和 transient 排序；持久因果顺序使用 root 单调 `orderKey`。

## 数据迁移

1. 导出目标 root 的 audit/tree snapshot，并保存原始数据库备份。
2. 服务端根据持久 tool-call owner、spawn task 和 message link 生成显式 edge facts。
3. 运行 `pnpm test:cp2`、`pnpm test:cp3` 和 `pnpm test:cp10`，确认无 `legacy-relation-unresolved` 或 dangling diagnostics。
4. 打开真实 root，验证历史抽屉仍消费 conversation timeline，节点树只消费 tree facts。

## 回滚

1. 停止写入新 graph facts，保留数据库备份与 CP0/CP2 真实 fixture。
2. 回滚 CP10 增量布局和诊断 UI 时无需回滚协议或数据库；`layoutExecutionGraph()` 仍可直接执行完整布局。
3. 若服务端 graph facts 异常，恢复数据库备份并重新打开 root subscription；前端诊断条的“重新同步”不会修改数据库。
4. 禁止恢复已删除的客户端因果猜测、旧 branch layout、独立工作气泡或 CRT stack。
