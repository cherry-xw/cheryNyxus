# 动画（GSAP）

> 描述符源码 [animation.ts](../../../web/src/domain/pets/motion/animation.ts) ｜ GSAP 执行器 [usePetMotion.ts](../../../web/src/features/pets/composables/usePetMotion.ts) ｜ 上级 [README.md](./README.md) ｜ 渲染分层见 [rendering.md](./rendering.md)

## 分层

Pet 动效分为两层：

- `domain/pets/motion/animation.ts` 只输出框架中立的 `PetMotionDescriptor`，描述 transform、opacity、keyframes、repeat 与 easing，不依赖 Vue 或 GSAP。
- `features/pets/composables/usePetMotion.ts` 将描述符映射为 scoped GSAP tween；属性或有效动效偏好变化时可重建，组件卸载时统一 kill/revert。

sprite、face 与左右手保持独立 tween，动作循环使用 keyframes、repeat 与 yoyo。精简动效模式只保留必要的静态终态/透明度反馈，不播放弹性和循环位移。face 动画不使用 `filter`，避免 emoji 持续触发高成本重绘。

## 朝向翻转

face 朝向使用 CSS `rotateY` 过渡，不属于 mood tween。双面结构为 `.face-flip > .face-rotate > .face-side.front/.back > .face`：front/back 均由 `usePetMotion` 驱动 mood，外层只负责方向。

back 使用 `rotateY(180deg) scaleX(-1)` 预镜像内容，并配合 `backface-visibility: hidden`，保证翻转越过 90° 时不空白。Unicode 人物 emoji 通常默认朝左，因此 `dir=1` 映射到 180°、`dir=-1` 映射到 0°，使视觉朝向跟随移动方向。hands 与名字仍通过父级方向变量瞬时镜像。

## 气泡

PetBubbles 使用 Vue `<Transition :css="false" mode="out-in">`，钩子由 `usePetBubbleTransition()` 提供。进入/离开只改变 autoAlpha、scale 与百分比位移；反向或取消时先 kill 旧 tween，避免竞态与残留。

所有持续帧更新共用 `frameCoordinator`；位置由 `quickSetter` 直写 transform `x/y`，包括 Pet 舞台主体与 standalone Nyxus 锚点，禁止在 tick 内写 `left/top`。气泡与图标锚点使用 20Hz pose 快照，避免每帧 Vue patch。
