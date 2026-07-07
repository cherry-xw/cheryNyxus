# Pet 桌宠模块

> 源码 [web/src/features/pets/](../../web/src/features/pets/) ｜ 上级 [web](./README.md) ｜ 动画库 [motion-v](https://motion-v.com)

## 职责

`web/src/features/pets/` 是纯前端的桌面宠物（decorative pets）模块：多个角色在舞台上游走、交互、聊天。当前与后端 RPC **解耦**（[App.vue](../../web/src/App.vue) 仅渲染 [PetStage.vue](../../web/src/features/pets/PetStage.vue)）。位置由 `usePetWorld` 的 RAF 循环控制（运动学算法抽到 [petMovement.ts](../../web/src/features/pets/petMovement.ts)），视觉动作由 `motion-v` 驱动，避免位置 `transform` 与动画 `transform` 互相覆盖。

模块按**养桌宠**模型维护两个数值状态：`emotion`（情绪值）与 `fatigue`（疲劳值），驱动基础表情与休息行为，并作为 **agent 显示层**的预留映射点（见 [agent 显示层](#agent-显示层预留)）。

## 核心模型

### 角色（PetPreset）— 程序化生成（部件池 + `generatePet`）

```ts
interface PetHands { left: string; right: string }
interface PetTool { id: string; icon: string; label: string; core?: boolean }
interface PetBehavior { talks?: string[] }
interface PetSleepConfig { zzz?: string }                 // 休息时浮字，默认 "zZ"

interface PetPreset {
  id: string; name: string;
  color: string; accent: string;
  faceType: 'emoji' | 'kaomoji';                // face 类型：emoji 整脸 / 颜文字部件。主 pet 刷 kaomoji，子 pet 刷 emoji
  face: Record<PetMood, string>;                // 眼睛/中央表情部件，按 mood 变
  hands: Record<PetMood, PetHands>;             // 左右手势部件，按 mood 变
  talks: string[];                              // 默认台词
  tools: PetTool[];                             // 工具列表（icon+label+core）
  behaviors?: Partial<Record<PetAction, PetBehavior>>; // per-action 台词覆盖
  sleep?: PetSleepConfig;                       // 休息 UI 覆盖（zzz 浮字）
}
```

- **程序化生成**：pet 不再是固定 preset 数组，由 [petPresets.ts](../../web/src/features/pets/petPresets.ts) 的 `generatePet(form)` 运行时组合部件产出 `PetPreset`：`face`（`KAOMOJI_FACES`/`EMOJI_FACES` 池）+ `hands`（`HAND_PAIRS` 每 mood 抽一对）+ `color`/`accent`（`COLOR_PARTS`）+ `talks`（`TALK_PARTS`）+ `name`（`NAME_POOL`）；`tools`/`behaviors` 沿用默认，`sleep` 不设（默认 `zZ`）。
- **form 三态**（`PetForm`）：`'kaomoji'`=主池（颜文字 face）/ `'emoji'`=子池（emoji face）/ `'random'`=按池容量比例纯随机。导出 `masterFacePool`/`subFacePool` 两个 face 部件数组（即主/子池）。
- **手部配对池** `HAND_PAIRS: Record<PetMood, PetHands[]>`：每 mood ~8 配对，含颜文字手臂/装饰（参考 lddgo.net/common/emoticons）+ emoji 动效（跑→happy/panicked、汗→surprised/panicked、放屁→nagging、哭→sad、掀桌→angry）。`buildHands()` 每 mood 独立抽一对 → 跨 mood 混搭、单 mood L/R 协调。
- **混合渲染**：emoji 角色 `face`=emoji、颜文字角色 `face`=眼睛/嘴部件；`hands` 跨类型混搭（颜文字 + emoji）。渲染拼装：`hands[mood].left` + `face[mood]` + `hands[mood].right`（无独立 body 字符）。
- **主/子 pet 为运行时状态**（`isMaster`/`tribe`，见下）；**主 pet 由 `generatePet('kaomoji')` 产出，子 pet 由 `generatePet('emoji')` 产出**（见 [主/子产生](#主子-pet-与部落从属关系)）。

### 实例状态（PetInstance）

每个 pet 实例除 preset 字段外，运行时维护：

| 字段 | 说明 |
|------|------|
| `isMaster` | 主 pet 标记。主 = 全尺寸 + 持有 `summon` 工具 + 基础 mood `serious`；子 = 体型缩小（`--pet-scale`）。 |
| `tribe` | 部落 id = 本主 pet 的 `instanceId`。主 pet 的 `tribe` = 自身 instanceId；子 pet 的 `tribe` = 其主 instanceId。同 `tribe` = 同部落（聚拢），异 `tribe` = 异部落（避让分离）。 |
| `emotion` 0-100 | 情绪值。交互驱动（抚摸+、戳-），随时间缓降。低值 → `sad`/`angry` 基础 mood |
| `fatigue` 0-100 | 疲劳值（认知/上下文负担）。移动/拖拽/聊天累积，≥80 自动休息；休息时下降。未来映射 agent token 上下文 |
| `mood` / `action` | 当前表情与动作（见下） |
| `moodUntil` / `interactionUntil` | 临时 mood / 聊天结束时间戳 |
| `draggingPointerId` / `dragOffset*` | 拖拽状态 |

## 状态系统（养桌宠）

### emotion（情绪值）

- **初始 70**，clamp(0,100)。
- **衰减**：每秒缓降（`EMOTION_DECAY`），促使玩家持续照料。
- **交互增量**：

  | 交互 | emotion |
  |------|---------|
  | click 抚摸 | +6 |
  | rapid click（连点≥3，戳） | -8/次 |
  | drag 拖拽 | -3 |
  | hover 悬浮 | +1 |
  | feed 喂食工具 | +15 |
  | pet 抚摸工具 | +8 |
  | punch 挑逗工具 | -10 |
  | 打扰休息（hover/click/drag 唤醒 sleeping pet） | -5 |

- **影响 mood**：见 [基础 mood](#mood--action--触发)。

### fatigue（疲劳值）

- **初始 0**，clamp(0,100)。
- **累积**：移动（walk 每秒）、拖拽、聊天均累积；休息时下降。
- **自动休息**：`fatigue ≥ FATIGUE_SLEEP(80)` → `action="sleep"`。
- **恢复**：休息时 `fatigue↓` 且 `emotion↑`（睡觉双回血）。
- **唤醒**：`fatigue ≤ FATIGUE_WAKE(10)` 或被鼠标交互打扰 → 醒（`walk`）。
- **agent 映射预留**：未来 pet 作为 agent 显示层时，`fatigue` 改由真实 token 上下文量驱动（上下文越长越累，清上下文=休息恢复）。当前由活动模拟累积。

## Mood / Action / 触发

`PetMood` = calm | serious | happy | surprised | sad | panicked | angry | nagging | curious | sleepy（10）。
`PetAction` = walk | idle | hover | dragging | dropped | clicked | chatting | **sleep**。

### 临时 mood（action 触发，短期）

| 触发条件 | mood |
|----------|------|
| click | happy |
| 连点 ≥3 / scold | angry |
| drag start | surprised |
| 快速拖动 (movement>阈值) | panicked |
| drop 后 | sad |
| chat | happy 或 nagging |
| 主 pet 基础 mood | serious |

> **hover 不切 mood**：悬浮仅设 `action="hover"`，**保持当前表情**（不再切 curious）；`tickPet` 对 hover action 早返回 → **停止移动**（速度 0、不衰减、不回退 mood）。离开悬浮 → `walk` + `restMood`。悬浮中的 pet 不参与聊天候选（避免冻结态被打断）。

### 基础 mood（`restMood`，临时 mood 到期回落）

状态驱动，按优先级：

1. `action="sleep"` 或 `fatigue≥80` → `sleepy`
2. `emotion<25` → `sad`
3. `emotion<50` → `calm`
4. `isMaster` → `serious`
5. 默认 → `calm`

> 临时 mood（moodUntil 未到期）优先于基础 mood；到期后回落到 `restMood`。原 `SLEEP_AFTER` 长时无交互 → sleepy 的语义由 fatigue 累积 + 休息机制承担。

## 休息机制

- `PetAction="sleep"` 为单一数据源（不引入 resting 布尔字段，避免双源）。
- **触发**：`fatigue≥80` 自动 / `sleep` 工具手动。
- **行为**：`tickPet` 对 sleep action 跳过移动（**速度=0**）、跳过避让/聊天候选/唠叨目标；`fatigue↓` + `emotion↑`。
- **UI**：`face=sleepy` + `zzz` 浮字（`preset.sleep?.zzz ?? "zZ"`，per-pet 可覆盖）。
- **唤醒**：`fatigue≤10` 自然醒 / 鼠标交互打扰（-emotion 惩罚）→ `walk`。

## 主/子 pet 与部落（从属关系）

多主 pet 共存，每主带一群子 pet，形成部落类群（不同部落视觉/移动分离）。

- **主 pet 产生**：工具栏 `+pet`（`addPet`）→ `generatePet('kaomoji')` 产 preset → 新主 pet（`isMaster=true`，`tribe=自身 instanceId`），全尺寸，工具列前置 `summon`。
- **子 pet 产生**：主 pet 的 `summon` 工具 → `summonSub(master)` → `generatePet('emoji')`，`isMaster=false`，`tribe=master.instanceId`，初始位置在主附近。仅主 pet 持有 `summon`。
- **stewart**：原 `core` 管家概念早已移除；stewart 现仅为 `NAME_POOL` 中一个名字，不再是特殊 preset。多主平等。
- **`resetPets()` / `onMounted` 初始化**：刷 2 主 + 每主 1~2 子；主 `generatePet('kaomoji')`、子 `generatePet('emoji')`。
- **`removePet(pet)`**：任意 pet 可驱逐（无 core 保护）。主被驱逐后其子成为孤儿（`tribe` 找不到主 → 无吸引、自由游走），不自动归并、不连带驱逐。
- **扎堆行为**：
  - 子 pet `retarget` 偏向本主（`master.pos ± TRIBE_CLUSTER_RADIUS`）→ 聚拢；斥力可将其推远，`retarget` 再拉回 → 整体聚类（允许一定程度远离，不必贴堆）。
  - 移动算法抽到 [petMovement.ts](../../web/src/features/pets/petMovement.ts)：**力积分模型**（`stepMovement`）—— 加速度（seek 朝 target）+ 部落间力 → 速度（damping + maxSpeed）→ 位置。`vx/vy` 持久积分（有惯性），非每帧覆盖。靠近时斥力随距离线性渐增，速度渐变方向 → **平滑远离**（非位置硬修正瞬移）。
  - **部落力**（按 `tribe` 同异分施）：同部落 = 引力（`ATTRACT_RADIUS` 环带内拉拢聚拢）+ 小半径斥力（`REPEL_RADIUS` 内近距不重叠）；异部落 = 大半径斥力（`ATTRACT_RADIUS` 内分离，替代旧主-主强斥力）+ 引力（默认 0）。两主异部落 → 大半径强斥 → 不会接近。
  - **直观参数**（`MovementOptions` 覆盖，默认值即下述常量）：`maxSpeed`（移动速度）/ `acceleration`（加速度）/ `tribeAttract`·`tribeRepel`（同部落引/斥）/ `otherAttract`·`otherRepel`（异部落引/斥）/ `repelRadius`·`attractRadius`（斥/引作用半径）。
  - **主 pet 独立物理**：`stepMovement` 全量参数化，`usePetWorld.tickPet` 按 `isMaster` 传独立参数集——主 pet 取**更慢更稳**配置（更低 `maxSpeed`/`acceleration`、更小斥力与半径），稳重首领感；子 pet 用默认值。
  - **初始位排斥采样**（`findSpawnPosition`）：生成时在落点附近尝试多次，选距所有现有 pet 中心 ≥ `MIN_SPAWN_GAP` 的点（找不到退化为最远点）→ 出生即不重叠。子 pet 落点基于主，主 pet 落点基于舞台随机 + 排斥已有主。
- **基础 mood**：主 pet `serious`（见 [基础 mood](#基础-moodrestmood临时-mood-到期回落)）。

## 工具栏

- 名字后 icon 行：`core` 工具常驻（第一行，name 旁）；非 core 默认隐藏，悬浮 `.tools` 时在**第二行居中**展开（`.tools-extra`，与第一行保持间距，`opacity`/`transform` 过渡）。**隐藏延迟 240ms**（`scheduleCloseTools` 定时器），便于鼠标从第一行移到第二行不被中断。原 ⋯ 切换按钮已移除（不再支持触屏点切）。
- 每 icon hover 显示 `label`（CSS `.tip` tooltip，无 element-plus 依赖）。
- 点击 emit `tool` 事件 → `usePetWorld.invokeTool(pet, toolId)`：
  - `pet`→happy+emotion、`feed`→happy+emotion+台词、`sleep`→触发休息（`punch` 工具随 pump preset 拆解退役，无 pet 持有；`invokeTool` 的 punch case 保留为无害死代码）
  - `dismiss`→removePet（任意 pet 可驱逐，无特权保护）
  - `summon`→`summonSub(pet)`（仅主 pet 工具列有 summon，召子入本部落）
- **工具 ↔ agent 能力**：当前工具为养桌宠交互语义；未来 pet 作为 agent 显示层时，`invokeTool` 改为消费后端 RPC（工具=agent 能力 UI 入口）。扩展点见下。

## 抚摸光标

- `.head-row` hover（未拖拽）→ 自定义手形光标（内联 SVG data URI，无外部资源）。
- `.pet.is-dragging .head-row` → `grabbing`。
- cursor 不影响布局，不触发抖动。

## 动画（motion-v）

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

## 渲染分层（PetSprite.vue）

```text
div.pet-wrap                                                       // 根容器（无 z-index/position → 不创建 stacking context，气泡 z-index 跨 pet 比较）
  AnimatePresence > Motion.speech[:style=left/top+zIndex #dialog slot]  // 气泡（.pet 兄弟，独立 z-index，锚点=pet 顶部中心；motion x:"-50%" y:"-100%" 居中+上移自身高度）
  div.pet[:class=is-master|is-sub :style=translate3d(x,y)+zIndex(petBodyZIndex) + --pet-direction + --pet-scale + --tribe-hue]  // RAF 位置容器（无交互）
    span.shadow (CSS 呼吸，随 --pet-scale 缩)
    div.dir[CSS scaleX(--pet-direction)]                          // 朝向瞬切
      Motion.sprite[:animate=spriteMotion(action)]                // grid-template-columns:100% 修复展开抖动
        div.status-row: span.bar.emotion + span.bar.fatigue       // 状态条（头顶，固定尺寸，不触发交互）
        span.head-row[role=button + 长按拖拽/短按抚摸 + keydown + cursor + touch-action + transform:scale(--pet-scale)]  // 命中区=身体（face+hands）
          Motion.hand.left[:animate=handMotion(action,'left')]   hands[mood].left
          Motion.face[:animate=faceMotion(mood)]                  face[mood]
          Motion.hand.right[:animate=handMotion(action,'right')]  hands[mood].right
        div.meta-row: span.name + div.tools                       // 第一行：name + core 工具（不触发交互）
          div.tools-extra                                        // 第二行：非 core 工具，居中、间距、hover 展开
        span.zzz (v-if action=sleep)                             // 休息浮字
```

位置、朝向、主体动作、手部动作、表情滤镜各在独立层，transform 不冲突。`.sprite` 用 `grid-template-columns:100%` 使各 row 独立居中，工具栏展开不再偏移 face（修复抖动）。`--pet-scale`（主 1 / 子 0.62）仅作用于 `.head-row` + `.shadow`——子 pet 体型缩小但 name/tools/status-bar 尺寸不变（工具栏大小不变）。`.status-row` 移至 head-row 之上（头顶），固定尺寸不随 scale 缩。

**命中区**：仅 `.head-row`（身体=face+hands）触发 pointer/hover/keydown；`.pet` 降级为定位容器（无 pointer 事件），name/status-row/shadow/speech/zzz 不触发交互。抚摸/抓取光标、`touch-action:none`、键盘焦点（role=button+tabindex）均在 head-row。

**交互（长按拖拽 + 短按抚摸）**：`pointerdown` 启 300ms 定时器（`LONG_PRESS_MS`）+ 记录落点；**长按超时或移动超阈值（`DRAG_THRESHOLD_PX=5`）**任一触发 → `startDrag`（`setPointerCapture` + 进入 `dragging`）；**短按（<300ms 且未超阈值）松开** → 取消定时器，不拖拽，让 `click` 触发 `clickPet` 抚摸。拖拽结束的 `pointerup` 紧随触发 `click` → `suppressClick` 标志抑制，避免拖拽完又抚摸。长按等待中离开元素（`pointerleave`）取消定时器。`onPointerMove` 在等待中检阈值，进入拖拽后透传 `drag`。

**z-index（inline 动态，气泡与身体分离）**：`.pet-wrap` 无 z-index/position → 不创建 stacking context，故 `.speech` 与 `.pet` 的 z-index 在 stage 层级跨 pet 直接比较。z-index 由 inline `:style` 提供（CSS 仅 fallback）；原 `.is-master`/`.is-chatting`/`.is-dragging` 的 z-index 规则已移除。

| 层 | 公式 | 取值 | 效果 |
|----|------|------|------|
| 身体 `petBodyZIndex` | `dragging→20`；否则 `(hasSpeech?10:0)+(isMaster?2:1)` | 拖拽20；有气泡主12/子11；无气泡主2/子1 | 默认主盖子；**子有气泡主无时子(11)>主(2)→子盖主**；都有时主(12)>子(11) |
| 气泡 `speechZIndex` | `dragging→120`；否则 `100+(isMaster?2:1)` | 拖拽120；主气泡102/子101 | 气泡整体高于身体（100+>20）；气泡间主>子 |

**name 部落色**：同部落（主+子）name 同底色 `hsl(tribe-hue)`；子 name 文字=部落深色，**主 name 文字=动态彩虹流动**——name 拆为 per-char `<span>`，每字符色相按序递增（`--char-i` 计算 `hsl(base + i*step)`），`animation-delay` 按字符序错相 → 整体从左往右波浪流动。

### 对话框 slot

```vue
<AnimatePresence>
  <Motion v-if="pet.speech || $slots.dialog" class="speech"
          :style="{ left: pet.x+width/2, top: pet.y, zIndex: speechZIndex }" ...>
    <slot name="dialog" :pet="pet">{{ pet.speech }}</slot>
  </Motion>
</AnimatePresence>
```
气泡为 `.pet-wrap` 内 `.pet` 的**兄弟**（脱离 `.pet` 的 transform stacking context），独立 z-index（整体高于身体）。锚点 = pet 顶部中心，`left`/`top` 由 inline `speechStyle` 提供，motion `x:"-50%" y:"-100%"` 居中 + 上移自身高度。默认渲染字符串；父级可 `#dialog="{pet}"` 注入复杂内容（先留口）。

## agent 显示层预留

pet 模块当前纯前端，未来作为 agent 显示层时：

- **fatigue ↔ token 上下文**：`fatigue` 改由 agent 真实 token 上下文量驱动（上下文越长越累）。`usePetWorld` 暴露 `setFatigue(pet, v)` / `setEmotion(pet, v)` 供 agent 层注入。
- **工具 ↔ 能力**：`invokeTool` 内 `switch` 保留，未来改为 RPC 调用（对应 agent 的 sense/tool 能力）。
- **对话框 slot**：`#dialog` 可注入 agent 返回内容。
- 接入步骤详见 [扩展点](#扩展点)。

## 文件清单

| 路径 | 职责 |
|------|------|
| [types.ts](../../web/src/features/pets/types.ts) | PetMood/Action/**Form**/Hands/Tool/Behavior/SleepConfig/Preset/Instance 类型 |
| [petPresets.ts](../../web/src/features/pets/petPresets.ts) | face 部件池（KAOMOJI/EMOJI_FACES）+ `HAND_PAIRS` 配对池 + COLOR/TALK/NAME 部件 + `generatePet(form)` + `masterFacePool`/`subFacePool` 双池导出 |
| [petMotion.ts](../../web/src/features/pets/petMotion.ts) | sprite/hand/face/speech variant helper（含 sleep） |
| [PetSprite.vue](../../web/src/features/pets/PetSprite.vue) | 单 pet 渲染：motion 分层 + 部件 + 工具栏 + 状态条 + zzz + 光标 + slot |
| [PetStage.vue](../../web/src/features/pets/PetStage.vue) | 舞台 + toolbar + tool 事件接线 |
| [usePetWorld.ts](../../web/src/features/pets/usePetWorld.ts) | RAF / retarget 策略 / 交互 / chat / 主子部落 / 工具 / 状态系统 / 休息 / 慢速 |
| [petMovement.ts](../../web/src/features/pets/petMovement.ts) | 运动学纯函数：stepMovement（力积分 seek+部落引力/斥力）/ arrivedAtTarget / findSpawnPosition（排斥采样）/ keepInBounds |

## 扩展点

- **加角色形态**：在 [petPresets.ts](../../web/src/features/pets/petPresets.ts) 加 face 部件（`Record<PetMood,string>`）到 `KAOMOJI_FACES`（主池）或 `EMOJI_FACES`（子池）即可被 `generatePet` 随机刷出；无需定义完整 preset（color/talks/hands 由各自部件池随机组合）。
- **加手部配对**：在 `HAND_PAIRS[mood]` 加 `PetHands` 配对（颜文字手臂/装饰或 emoji 动效）。
- **加台词/颜色/名字**：扩 `TALK_PARTS` / `COLOR_PARTS` / `NAME_POOL`。
- **加 mood**：扩 `PetMood` → 补全各角色 `face`/`hands` 该 mood → 在 [petMotion.ts](../../web/src/features/pets/petMotion.ts) 加 face variant → 在 `usePetWorld` 加触发条件。
- **加动作**：扩 `PetAction` → 在 [petMotion.ts](../../web/src/features/pets/petMotion.ts) 加 sprite/hand variant → 在 `usePetWorld` 加行为逻辑。
- **加工具**：扩 `PetTool` 列表 → 在 `invokeTool` 加 case（含 emotion 增量）。
- **调状态**：改 `usePetWorld` 顶部状态常量（`EMOTION_DECAY` / `FATIGUE_*` / 各交互增量）。
- **接入 agent**：`fatigue` 改由 token 上下文驱动（调 `setFatigue`）；`invokeTool` / 对话框 slot 改为消费后端 RPC（[protocol.md](../protocol.md)）。
