# 前端“深空电光”科技感重构 · 总任务

> **任务 ID**：`ui-deep-space-electro-stage1`
>
> **Plan 位置**：`docs/plan/ui-deep-space-electro-stage1.md`
>
> **批次**：B1
>
> **状态**：待批次综合测试（自动化已通过，目标设备与 Electron 人工验证待完成）
>
> **操作方案**：[Plan 操作方案](../standards/plan-operation.md)

## 目标与边界

- 统一为克制的“精密航天控制台”视觉语言，兼顾最佳动效交互、深浅主题和集成显卡可承担的流畅度。
- 覆盖 PetStage/Nyxus、AgentDialog、工作台/节点树、设置、历史、登录、Lite、媒体与通用 overlay。
- 保留全部功能、快捷键、持久化键、RPC/API/WebSocket 语义，不改服务端协议。
- 目标设备为 1080p/60Hz 集成显卡笔记本：正常 p95 ≤20ms，压力 p95 ≤33ms。

## 已确认决策

| 决策项 | 结论 |
|---|---|
| 视觉方向 | 深色以深空蓝紫 + 电光青为主，浅色为冷白 + 靛蓝；暖金仅保留 warning 语义 |
| 动画栈 | GSAP 为唯一 JS DOM 动画引擎；移除 web workspace 的 `motion-v` |
| 动效偏好 | `'system' \| 'full' \| 'reduced'`，默认跟随系统并跨窗口同步 |
| 性能策略 | 单帧协调器、质量迟滞、有界 DPR/挂载预算，不以锁低 FPS 换性能 |

## B1 小任务汇总

| 完成 | ID | 小任务 Plan | 依赖 | 步骤进度 | 状态 |
|---|---|---|---|---:|---|
| [x] | S1 | [视觉系统与全产品表面](./ui-deep-space-electro-stage1/01-visual-system.md) | 无 | 6 / 6 | 已完成 |
| [x] | S2 | [GSAP 与帧协调基础设施](./ui-deep-space-electro-stage1/02-gsap-frame-infrastructure.md) | S1 | 5 / 5 | 已完成 |
| [x] | S3 | [流式 Markdown 渲染链路](./ui-deep-space-electro-stage1/03-streaming-markdown.md) | S2 | 5 / 5 | 已完成 |
| [x] | S4 | [`motion-v` 迁移至 GSAP](./ui-deep-space-electro-stage1/04-motion-v-to-gsap.md) | S2 | 4 / 4 | 已完成 |
| [x] | S5 | [高频渲染路径收敛](./ui-deep-space-electro-stage1/05-hot-path-performance.md) | S2、S4 | 4 / 4 | 已完成 |

## B1 统一综合测试

### 自动化与静态验证

- [x] `pnpm test:web`：80 个测试文件、477 项测试通过。
- [x] `pnpm -C web type-check` 通过。
- [x] `pnpm -C web build` 通过；存在独立 `vendor-gsap`、无 `vendor-motion`，Markdown 不进入冷启动静态依赖。
- [x] `web/src` 无 `motion-v`、`vendor-motion`、`useThrottledMarkdown` 残留。
- [x] 聚焦 ESLint、`git diff --check`、冲突标记与调试残留审计通过；未批量改写全仓 CRLF/既有 lint 基线。
- [x] motion preference、frame coordinator、render quality、rendered Markdown 性能回归测试通过。

### 目标环境人工验证

- [ ] 在目标 1080p/60Hz 集显设备完成真实交互录制与 `__CHERY_PERF__.snapshot()` p95 采样。
- [ ] 在 Electron 中目检深浅主题与透明宠物窗。
- [ ] 验证完整/精简动效以及 overlay ESC/快速反向切换。
- [ ] 验证长流式 Markdown 输出的视觉稳定性与交互流畅度。

任一人工验证失败时，总任务退回“执行中”，重新打开对应小任务；修复后重跑相关定向测试和 B1 完整综合测试。

## 审批与删除 Plan

- [ ] B1 综合测试全量通过。
- [ ] 用户明确审批通过。
- [ ] 删除 `docs/plan/ui-deep-space-electro-stage1.md`。
- [ ] 删除 `docs/plan/ui-deep-space-electro-stage1/` 下全部小任务 Plan。

## 非阻塞后续候选

- Workbench JS 与 Settings CSS 仍是较大的懒加载 chunk，但不进入冷启动；后续应另建总任务和小任务 Plan，再按 tab/renderer 拆分。
- 自动化只能证明边界、类型和行为回归；最终手感与目标硬件帧预算以人工性能录制为准。
