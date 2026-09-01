# 前端“深空电光”科技感重构 · 实施记录

> **状态**：实现、生产产物边界与自动化审计完成（2026-09-01）。
> **目标**：统一为克制的“精密航天控制台”视觉语言，兼顾最佳动效交互、深浅主题和集成显卡可承担的流畅度。
> **边界**：保留全部功能、快捷键、持久化键、RPC/API/WebSocket 语义，不改服务端协议。

## 已确认决策

| 决策项 | 结论 |
|---|---|
| 视觉方向 | 深色以深空蓝紫 + 电光青为主，浅色为冷白 + 靛蓝；暖金不再承担品牌主色，仅保留独立 warning 语义 |
| 产品范围 | PetStage/Nyxus、AgentDialog、工作台/节点树、设置、历史、登录、Lite、媒体与通用 overlay 全面统一 |
| 动画栈 | GSAP 为唯一 JS DOM 动画引擎；移除 web workspace 的 `motion-v` |
| 动效偏好 | `'system' | 'full' | 'reduced'`，默认跟随系统；跨窗口同步 |
| 性能目标 | 1080p/60Hz 集成显卡笔记本：正常 p95 ≤20ms，压力 p95 ≤33ms |

## S1 视觉系统与全产品表面

- [x] 深浅主题 token、字体、密度、间距、圆角、层级、语义色与舞台 glow 统一。
- [x] PetStage 改为青/靛深空控制网格；Nyxus 从灰绿 CRT 收敛到青/靛精密控制台。
- [x] AgentDialog 增加克制边缘辉光与 L 形角标；历史抽屉增加状态边线；Workbench/节点树和设置中心统一控制台层级。
- [x] 登录移除 emoji 功能装饰，换为 CC beacon 与 SVG 控件；Lite、媒体、消息、头像、Pet 辅助面统一语义 token。
- [x] 深浅主题结构等价；浅色 hljs 符号色修正为可读的 accent。
- [x] 遮罩移除高成本 backdrop blur；warning 的琥珀色保持独立语义，不再污染品牌强调色。

## S2 GSAP 与帧协调基础设施

- [x] `gsapCore.ts` 只保留语义时长/缓动与运行配置，移除全局 defaults 和永久 ticker listener，使 autoSleep 生效。
- [x] 新增按需 `frameCoordinator.ts`：单 ticker、真实帧 delta、每帧一次质量采样、无订阅自动停止、页面隐藏暂停。
- [x] `useGsap` 提供 scoped context；`useOverlayTransitionHooks` 提供可中断、done-once、支持 reduced motion 的 Vue Transition 钩子。
- [x] 渲染质量使用 high/balanced/low 带迟滞升降级，预算分别限制挂载量与 DPR，不通过锁低 FPS 换性能。
- [x] 新增 `useMotionPreference`，完成 system/full/reduced 持久化、系统解析和跨窗口同步。

## S3 流式 Markdown

- [x] 新增共享 Markdown Worker、异步 client 和 `useRenderedMarkdown`。
- [x] leading + 240ms trailing；终态/流结束 flush；空内容复位；12000 字符预览上限。
- [x] revision 防止乱序结果覆盖；字符预算 LRU；Worker 失败时动态回退。
- [x] MessageBubble、宠物气泡、AnchoredRunCrt、LiteMarkdown、PaperGameCard、ExecutionNodePopover 全部迁移，删除旧 `useThrottledMarkdown`。
- [x] 重新生产构建：解析器仅存在于独立 Worker 与动态回退 chunk，主入口和 `index.html` 均无静态导入/预加载。

## S4 motion-v → GSAP

- [x] 宠物 motion 描述符改为框架中立数据，新增 `usePetMotion` GSAP 执行器。
- [x] PetBody、PetFaceFlip、PetBubble/PetBubbles 迁移；face 不再动画 filter。
- [x] AgentDialog、History、Settings、Workbench 与 popout 全部改用统一 overlay transition hooks。
- [x] `motion-v` 从 web package、lockfile web importer 与 Vite manual chunk 删除；根 workspace 的其他产品依赖不受影响。

## S5 高频路径收敛

- [x] `usePetWorld` 与 standalone Nyxus 共用 frame coordinator，不再各自启动 rAF。
- [x] 舞台 bounds 经 ResizeObserver 缓存；移除 tick 内 `getBoundingClientRect()`。
- [x] Pet 与 standalone Nyxus 坐标使用 quickSetter 直写，避免每帧 Vue 响应式 patch。
- [x] 气泡、图标等辅助锚点 pose 快照降至 20Hz，视觉主体仍按显示帧更新。

## S6 验收

- [x] `pnpm test:web`：80 个测试文件、477 项测试通过。
- [x] `pnpm -C web type-check` 通过。
- [x] `pnpm -C web build` 通过；确认独立 `vendor-gsap`、无 `vendor-motion`，Markdown 不进入冷启动静态依赖。
- [x] 静态检查：`web/src` 无 `motion-v`、`vendor-motion`、`useThrottledMarkdown`。
- [x] 聚焦 ESLint、`git diff --check`、冲突标记与调试残留审计通过；未批量改写全仓 CRLF/既有 lint 基线。
- [x] 新增 motion preference、frame coordinator、render quality、rendered Markdown 性能回归测试。
- [ ] 在目标 1080p/60Hz 集显设备完成真实交互录制与 `__CHERY_PERF__.snapshot()` p95 采样。
- [ ] Electron 人工目检深浅主题、透明宠物窗、完整/精简动效、overlay ESC/快速反向切换与长流式输出。

## 已知后续优化点

- Workbench JS 与 Settings CSS 仍是较大的懒加载 chunk，但不进入冷启动；可在不破坏表面一致性的前提下继续按 tab/renderer 拆分。
- 自动化只能证明边界、类型和行为回归；最终手感与目标硬件帧预算仍需人工性能录制，不以开发机主观观感代替。
