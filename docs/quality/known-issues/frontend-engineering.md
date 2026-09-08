# 前端工程已知问题详情

目录入口：[已知问题](./README.md)。本文件记录已确认但当前明确暂缓的小型工程问题；它们不等于本轮功能回归失败。

## FE-ENG-001 全仓 Web lint 受存量 CRLF 影响

- 模块：`web/` 工程格式基线。
- 类型/状态：暂缓处理 / 已知/暂缓。
- 优先级：P3。
- 现象：`pnpm --filter web lint` 会在大量本轮未触及文件上报告 Prettier 行尾错误；针对本轮改动源文件的 ESLint 可单独达到 0 error。
- 影响：当前不能把全仓 Web lint 作为单次前端修改的可靠通过项，日志也会掩盖真正新增的问题。
- 当前决定：不在功能任务中批量格式化无关文件，避免制造大面积无语义 diff。
- 处理入口：独立建立行尾归一化任务，统一 `.gitattributes`、编辑器配置和现存文件后，再恢复全仓 lint 为强制门禁。
- 关闭条件：干净工作区执行 `pnpm --filter web lint` 不再因存量行尾失败，并确认没有批量改写生成文件或第三方文件。

## FE-ENG-002 节点树控制器保留 3 条 ESLint warning

- 模块：Nyxus 节点树控制器。
- 类型/状态：暂缓处理 / 已知/暂缓。
- 优先级：P3。
- 现象：[useMessageBranchTreeController.ts](../../../web/src/features/pets/nyxus/components/useMessageBranchTreeController.ts) 的 `useMessageBranchTreeController` 返回类型仍为 `any`；`endpointLayout` 与 `suppressAutoFollow` 当前被赋值但未消费，共产生 3 条 warning、0 error。
- 影响：不阻断构建或现有测试，但削弱控制器返回值的类型边界，并留下可能已经失效的布局/跟随意图。
- 当前决定：不在本轮 UI 交互与颜色修复中顺带重构超大控制器。
- 处理入口：先为控制器返回对象建立显式类型，再确认 endpoint 投影和自动跟随抑制是否仍属于现行设计；确定无调用后删除死状态，否则补齐消费路径与定向测试。
- 验证命令：`pnpm --filter web exec eslint src/features/pets/nyxus/components/useMessageBranchTreeController.ts`。
- 关闭条件：命令返回 0 warning，相关节点树类型检查和定向测试通过。

## FE-PERF-001 Workbench 生产 chunk 超过告警线

- 模块：Workbench 按需加载与生产构建。
- 类型/状态：暂缓处理 / 已知/暂缓。
- 优先级：P3。
- 现象：最新生产构建中的 `WorkbenchDialog` JavaScript chunk 约 545 kB（压缩前），超过 Vite 默认 500 kB 告警线；冷启动入口仍使用异步组件加载。
- 影响：不阻断构建，但首次打开 Workbench 时可能增加下载、解析和执行开销，低性能设备或慢网络更明显。
- 当前决定：先保留告警，不为消除数字机械拆包；需要结合真实加载指标决定拆分边界。
- 处理入口：从 [WorkbenchDialog.vue](../../../web/src/features/agent/workbench/WorkbenchDialog.vue) 的重依赖和可延迟面板入手，结合 [vite.config.ts](../../../web/vite.config.ts) 的 `manualChunks` 与 [bundleBoundaries.test.ts](../../../web/test/performance/bundleBoundaries.test.ts) 的冷启动边界评估。
- 验证命令：`pnpm --filter web exec cross-env ELECTRON_ENABLED=false vite build`；同时保留 `pnpm test:web -- web/test/performance/bundleBoundaries.test.ts`。
- 关闭条件：Workbench 首开指标达到约定预算，且构建不再产生该大 chunk 告警；不能只提高 `chunkSizeWarningLimit` 隐藏问题。
