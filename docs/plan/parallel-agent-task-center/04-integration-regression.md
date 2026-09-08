# 04 综合验证与用户验收

**所属总任务：** [多 Agent 并行任务中心](README.md)  
**状态：** 进行中  
**依赖：** 其余实现子计划均已完成

## 范围

确认任务中心跨模块行为、无固定轮询、有界增量和双端交互达到交付标准。不扩展第一版产品范围。

## 自动验证清单

- [x] 后端全量 1197 项及协议全量 436 项通过。
- [x] Web/Electron 类型检查与构建通过。
- [x] 当前共享工作树 Web 全量 566 项通过。
- [ ] 在最终工作树复核受影响测试、类型检查和构建，并记录本次真实结果。

建议入口：`pnpm test:backend`、`pnpm test:protocol`、`pnpm test:web`、`pnpm type-check:all`、`pnpm web:build`。

## 手动验证清单

- [ ] 按 [最终手册](verify/manual-final.md) 验证 20 根任务/50 Agent 空闲 60 秒无 overview、timeline 或 interaction 固定轮询。
- [ ] 按手册验证关键状态变化只产生有界 WebSocket 增量，并完成浏览器/Electron 交互验收。

## 完成标准

自动验证及必要手动验证均有明确通过记录。完成后将结论写回父计划并删除本文件。
