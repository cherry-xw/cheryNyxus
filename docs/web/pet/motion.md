# 动画（motion-v）

> 源码 [petMotion.ts](../../../web/src/features/pets/petMotion.ts) ｜ 上级 [README.md](./README.md) ｜ 渲染分层见 [rendering.md](./rendering.md)

分层，避免 transform 冲突（位置 RAF 走 `:style`，动画走 motion 内层）：

| 层 | key | 说明 |
|----|-----|------|
| sprite | action | y/rotate 循环（walk/idle/hover/drag/drop/click/chat/**sleep**） |
| hand | action | rotate 摆动，左右镜像（左取负），`transform-origin: top center` |
| face | mood | 几何（pop scale / wobble rotate）+ 滤镜（happy→brightness 暖脉冲；angry→brightness；sad→dim+opacity；panicked→hue-rotate；sleepy→opacity+scale；surprised→brightness 闪） |

`petMotion.ts` 提供共享 variant helper：

| helper | 输入 | 输出 |
|--------|------|------|
| `spriteMotion` | `PetAction` | 主体 action keyframes 与 transition |
| `faceMotion` | `PetMood` | 表情几何 + 滤镜（动态表情颜色动画） |
| `handMotion` | `PetAction`, side | 左右镜像的手部摆动 |
| `speechMotion` | 无 | 气泡 initial/animate/exit；`x:"-50%" y:"-100%"` 为定位（水平居中 + 上移自身高度，底部对齐锚点=pet 顶部中心），进退靠 opacity+scale |

动作循环用 keyframes + `repeat: Infinity` + `repeatType: "reverse"`。CSS 仅保留阴影呼吸等非核心动画。颜色/滤镜动画走 `filter`（brightness/hue-rotate/opacity），对 emoji 与颜文字均生效。`sleep` variant 为静止微呼吸（y 轻微 + rotate 近静）。

> motion-v 类型导出坑：不导出 `TargetAndTransition`/`Transition`（仅 `$Transition`）；variant helper 用字面量推断 + `as const`，`motion.span` 别名更稳。详见各组件 `:animate` 用法（[rendering.md](./rendering.md)）。
