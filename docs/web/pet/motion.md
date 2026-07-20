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

## Ghost 跟随

每个 tribe 的主 Agent 是唯一队首。运动循环采样主 Agent 的位置轨迹；已完成 Ghost 按创建时间排序，第 N 个 Ghost 追踪轨迹上距主 Agent `(N + 1) × 32px` 的弧长点。跟随仍使用弹簧加速度和阻尼，主 Agent 游走、拖动或停下时队列保持连续收敛。Ghost 之间不再选举队首，也不参与拖拽和普通 Pet 交互。

动作循环用 keyframes + `repeat: Infinity` + `repeatType: "reverse"`。CSS 仅保留阴影呼吸等非核心动画。颜色/滤镜动画走 `filter`（brightness/hue-rotate/opacity），对 emoji 与颜文字均生效。`sleep` variant 为静止微呼吸（y 轻微 + rotate 近静）。

**face 朝向翻转（CSS transition，非 motion-v variant）**：face emoji 方向反转时 rotateY 0↔180° 渐变（420ms ease-out），双面（front 原样 + back `rotateY(180deg) scaleX(-1)`）+ `backface-visibility:hidden` 使翻转过程始终显一面（过 90° 不空白，优于 scaleX 压扁）。back 的 `rotateY(180°)` 仅是背面定位（朝后），**`scaleX(-1)` 预镜像内容**——否则容器 180°+back 180°=360° 抵消显正向（ghost 对称 👻 不显，不对称 emoji 暴露）。**角度反向**：`rotateY((1+dir)*90°)` → dir=1 向右时 180°（镜像）、dir=-1 向左时 0°（正向）；因 Unicode 人物 emoji（🚶🏃🧟等）默认朝左，标准「dir1 正向」会让 emoji 与移动方向相反，故反向使朝向跟随移动；对称 emoji（👻💀👼）镜像无视觉差。三层：`.face-flip`（`scaleX(var(--pet-direction))` 抵消父 `.dir` 的 scaleX，使 face 脱离整树镜像）> `.face-rotate`（`rotateY` transition，`transform-style:preserve-3d`）> `.face-side front/back`（`backface-visibility:hidden`）> `Motion.face`（mood 动画不变）。仅 face；hands/name 仍靠 `.dir`/`.meta-row` 的 scaleX 瞬切镜像。详见 [rendering.md](./rendering.md)。

> motion-v 类型导出坑：不导出 `TargetAndTransition`/`Transition`（仅 `$Transition`）；variant helper 用字面量推断 + `as const`，`motion.span` 别名更稳。详见各组件 `:animate` 用法（[rendering.md](./rendering.md)）。
