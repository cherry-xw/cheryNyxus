# 前端动效规范（GSAP）

> **状态**：强制执行（2026-09-01 随“深空电光”重构确立）。
> **适用范围**：`web/src/**` 中所有 JS 驱动的 DOM 动效。
> **配套**：视觉条款见 [ui-visual-and-interaction.md](../standards/ui-visual-and-interaction.md)，用户偏好见 [settings.md](./settings.md)。

## 1. 引擎与装配

1. **GSAP 是唯一 JS DOM 动画引擎**。新增动效一律使用 GSAP 或 CSS；`motion-v` 已退役。Pixi.js 执行图和 CSS `@keyframes` 维持各自体系。
2. **核心配置只执行一次**。`utils/gsapCore.ts` 仅设置 `autoSleep`、`force3D` 等运行参数并提供语义时长/缓动常量；禁止写全局 `gsap.defaults()`，避免无关 tween 被隐式配置污染。
3. **显示帧统一协调**。持续物理更新通过 `utils/frameCoordinator.ts` 订阅：首个订阅者出现时接入 `gsap.ticker`，最后一个订阅者退出后停止，页面隐藏时暂停。质量采样每个显示帧只执行一次，使用真实 `performance.now()` delta。
4. **组件内必须可回收**。普通组件经 `useGsap(setup, scope?)` 建立 scoped `gsap.context()`；overlay 经 `useOverlayTransitionHooks()` 接入 Vue `<Transition :css="false">`。卸载、取消和反向切换必须 kill/revert，并确保 Vue 的 `done()` 只调用一次。
5. **高频写入使用 `quickTo` / `quickSetter`**。鼠标跟随、拖拽、宠物位置不得每帧创建 tween 或写 Vue 响应式状态触发 patch。

## 2. 性能铁律

1. 动画优先只改变 `transform` 与 `opacity/autoAlpha`；避免动画 `width/height/top/left/margin/padding/filter` 等布局或高成本绘制属性。
2. 遮罩不使用 `backdrop-filter`；大面积扫描纹理保持静态，小面积装饰才允许受控循环。
3. `will-change` 只在真实持续运动的元素上使用，不做全局铺设。
4. 不可见即停：overlay 关闭、组件卸载或 `document.hidden` 时不得保留无意义帧任务。
5. 宠物舞台边界由 `ResizeObserver` 缓存；tick 内禁止 `getBoundingClientRect()`。
6. 正常场景目标 p95 帧间隔 ≤20ms，压力场景 p95 ≤33ms；降级优先减少装饰、DPR 与挂载数量，不人为降低交互反馈帧率。

## 3. 动效偏好与渲染质量

用户偏好为 `'system' | 'full' | 'reduced'`，默认 `system`：

- `system`：跟随客户端 `prefers-reduced-motion`。
- `full`：完整位移、缩放、stagger 与受控装饰。
- `reduced`：保留即时状态反馈和短透明度过渡，取消非必要位移、弹性、stagger 与循环装饰。

偏好写入 `chery-motion`，由 storage event 与 BroadcastChannel 同步，并投影为根节点 `data-motion`。动效偏好与自适应渲染质量彼此独立：前者表达用户意图，后者依据帧预算在 high / balanced / low 间带迟滞升降级。

## 4. 流式 Markdown

所有实时 Markdown 使用 `useRenderedMarkdown()`：首个非空结果立即调度，随后以 240ms trailing 合并；预览默认截断到 `MARKDOWN_PREVIEW_LIMIT`（12000 字符），终态或流结束强制 flush。解析在共享 Worker 中执行，结果以 revision 丢弃过时响应，并带字符预算 LRU；Worker 不可用时才动态导入主线程解析器。

禁止在流式 delta watch 中同步调用 `renderMarkdown()`。当前覆盖 MessageBubble、宠物气泡、AnchoredRunCrt、LiteMarkdown、PaperGameCard 与 ExecutionNodePopover。

## 5. Review 清单

- [ ] 是否只动画 transform/opacity，且没有 tick 内布局读取？
- [ ] tween、context、Transition `done()` 与帧订阅是否能在取消/卸载时完整回收？
- [ ] 高频更新是否用 quickSetter/quickTo 直写，避免每帧响应式 patch？
- [ ] 完整/精简/跟随系统三种偏好是否都可用？
- [ ] 装饰是否接入 render quality，低档时能关闭或降采样？
- [ ] 流式 Markdown 是否走 Worker、节流与终态 flush？
- [ ] 新重型表面是否保持异步加载，不进入首屏 chunk？
