# 17 综合验证与用户验收

**所属总任务：** [故障工业赛博工作区 V2](README.md)
**状态：** 进行中
**依赖：** 其余实现子计划均已完成

## 范围

汇总全量自动验证，并完成唯一一轮 Web/Electron 视觉、交互、性能和资源清理验收。不扩展产品范围，不把用户验收拆回实现子计划。

## 自动验证清单

- [x] 子任务交叉定向测试通过（任务 13-16：74/74）。
- [x] Web、后端和协议全量测试已有通过记录。
- [x] 后端/Web TypeScript 检查、Web/Electron 生产构建及 `git diff --check` 已通过。
- [ ] 在最终工作树上复核必要的全量测试、类型检查和构建；仅记录本次真实结果。

建议入口：`pnpm test:web`、`pnpm test:backend`、`pnpm test:protocol`、`pnpm type-check:all`、`pnpm web:build`。

## 手动验证清单

- [ ] 按 [最终手册](verify/manual-final.md) 完成深色、浅色、reduced-motion 和 forced-colors 视觉矩阵。
- [ ] 按手册完成 Web 多视口和 Electron 多缩放交互验收。
- [ ] 按手册记录高质量/平衡档 FPS、活跃 primitive、ticker 与资源释放结果。

## 完成标准

自动验证及必要手动验证均有明确通过记录；高质量档交互目标 60fps，平衡档环境动效不低于 30fps，且无持续资源泄漏。完成后将结论写回父计划并删除本文件。
