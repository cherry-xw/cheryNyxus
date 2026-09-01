# 前端动效规范（GSAP）

> **状态**：强制执行（2026-09-01 随「深空电光」重构阶段1 确立）。
> **适用范围**：`web/src/**` 所有 JS 驱动的 DOM 动效。
> **配套**：视觉条款见 [ui-visual-and-interaction.md](../standards/ui-visual-and-interaction.md)；动效恒开（不跟随 `prefers-reduced-motion`）约定见 [settings.md](./settings.md) 动效降级约定；实施计划见 [plan/ui-deep-space-electro-stage1.md](../plan/ui-deep-space-electro-stage1.md)。

## 1. 引擎与装配

1. **GSAP 是唯一 JS DOM 动画引擎**（裁决见 [decisions.md](../standards/decisions.md)）：新增动效一律 GSAP 或 CSS；`motion-v` 已退役。pixi.js（执行图 canvas）与 CSS `@keyframes` 不属 DOM 动画栈，维持各自体系。
2. **应用级单例装配**：`web/src/utils/gsapCore.ts` 由 `main.ts` import 一次——设置 `gsap.defaults`、将 `gsap.ticker` 接入 `reportDisplayFrame`（`composables/renderQuality.ts` 的自适应调速器）。插件（Flip/Observer/ScrambleText/SplitText 等）只在应用级注册一次，按需懒加载，不在组件体内注册。
3. **组件内一律经 `composables/useGsap.ts`**：`useGsap(setup, scope?)` 在 `onMounted` 创建 `gsap.context`（选择器 scope 隔离），`onUnmounted` `ctx.revert()`。禁止在 setup 同步顶层或 DOM 未挂载时创建 tween；禁止绕过 context 创建不被 revert 追踪的 tween。
4. **高频更新用 `quickTo` / `quickSetter`**：鼠标跟随、拖拽预览、宠物位置等每帧写入场景，必须复用单 tween 直写 style（`useQuickTo` composable 自带清理），禁止每帧新建 tween、禁止高频写入 Vue 响应式状态触发每帧 patch。

## 2. 性能铁律（≥30fps 硬约束）

1. **只动 transform 与 opacity**：`x/y/scale/rotation/xPercent/yPercent` + `autoAlpha`（代替 opacity 做显隐）。禁止动画 `width/height/top/left/margin/padding` 布局属性。
2. **遮罩禁 backdrop-blur**：rAF 动效下 blur 每帧全屏重采样（既有约定）；遮罩一律 `var(--scrim)` 纯色。
3. **装饰性循环动画克制**：常驻循环（呼吸/脉冲/扫描）优先静态渐变纹理表达；确需循环时控制参与合成的小面积元素。大面积扫描线用静态 `repeating-linear-gradient`，不做循环位移。
4. **stagger 优于多 tween**：同构元素编组动画用 `stagger`；长列表只动可见项。
5. **不可见即停**：overlay 关闭、组件卸载、`document.hidden` 时暂停/杀死相关 tween。
6. **`will-change` 只挂在真正持续动效的元素**，不全局滥用。

## 3. 质量三档映射（降复杂度不降帧率）

动效复杂度挂接 `useRenderQuality().tier`（`composables/useMotionTier.ts`），**不降低帧率、不设 ticker.fps 上限**，只裁效果：

| 档 | 入场动画 | 装饰（辉光/扫描/流光） | stagger | 消息进入 |
|---|---|---|---|---|
| high | opacity+y+scale 全量 | 全开 | 0.04 逐元素 | 开 |
| balanced | opacity+y | 幅度减半（CSS var 控制） | 批内 0.02 | 开 |
| low | 仅 opacity | 装饰层 `display:none` | 0（整组单 tween） | 关 |

Pixi 执行图既有 12..30fps 钳制独立存在，不与本映射耦合。流式渲染节流（`useThrottledMarkdown` 240ms）独立于本映射恒定生效。

## 4. 生命周期与清理

1. 组件卸载：`ctx.revert()`（经 `useGsap` 自动完成）；`quickTo/quickSetter` 注册表（如宠物元素注册）卸载时必须反注册。
2. overlay 进出场：统一走 `composables/useOverlayAnimation.ts` 的 `useOverlayTransitionHooks(kind)`（Vue `<Transition :css="false">` + JS 钩子），不各写各的。
3. 动效时长/缓动走 token：`--dur-1/-2/-3`（0.16/0.18/0.24s）与 `--ease-out/--ease-spring`；CSS 侧与 GSAP 侧共用同一组数值（GSAP 里用等价秒数与 cubic-bezier）。

## 5. 动效恒开约定（继承）

应用**不跟随** `prefers-reduced-motion`：不新增 `@media (prefers-reduced-motion: reduce)` 块与 `matchMedia` 门控；GSAP 默认行为即不跟随，无需配置。存量个别 reduced-motion 覆盖块不扩散、不新增。

## 6. Review 清单

- [ ] 新动效是否只动 transform/opacity？有无布局属性动画？
- [ ] 是否经 `useGsap`/`useQuickTo` 创建？卸载是否 revert/反注册？
- [ ] 高频更新是否 quickTo/quickSetter 直写（无每帧响应式 patch）？
- [ ] 循环装饰是否克制？遮罩是否无 backdrop-blur？
- [ ] 是否接入 motion tier 三档（复杂装饰有 low 档裁剪路径）？
- [ ] 时长/缓动是否走 token 数值？