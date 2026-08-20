# 状态系统（养桌宠）

> 源码 [petStatus.ts](../../../web/src/features/pets/petStatus.ts) ｜ 上级 [README.md](./README.md) ｜ 模型见 [model.md](./model.md) ｜ 渲染见 [rendering.md](./rendering.md)

> 数值算法（衰减/恢复速率、阈值、交互增量）抽到 [petStatus.ts](../../../web/src/features/pets/petStatus.ts) 的纯函数 + `StatusConfig` 默认值；`usePetWorld` 模块级 `status = resolveStatus()` 统一注入（可传 overrides 覆盖默认）。下方数值均为默认值。

## emotion（情绪值）

- **初始 70**（`StatusConfig.emotionInit`），clamp(0,100)。
- **衰减**：每秒缓降（`StatusConfig.emotionDecay`，默认 0.6），促使玩家持续照料。
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

- **影响 mood**：见 [基础 mood](#基础-moodrestmood临时-mood-到期回落)。

## fatigue（疲劳值）

- **初始 0**，clamp(0,100)。
- **累积**：移动（walk 每秒）、拖拽、聊天均累积；休息时下降。
- **自动休息**：`fatigue ≥ StatusConfig.fatigueSleep`（默认 80）→ `action="sleep"`（谓词 `shouldSleep`）。
- **恢复**：休息时 `fatigue↓` 且 `emotion↑`（睡觉双回血），由 `stepVitals(pet, dt, status)` 在 sleep 分支处理。
- **唤醒**：`fatigue ≤ StatusConfig.fatigueWake`（默认 10，谓词 `shouldWake`）或被鼠标交互打扰 → 醒（`walk`）。
- **contextUsage 已接入**：pet 作为 agent 显示层，`contextUsage` 字段（独立于 fatigue）由当前执行完成时的 `done` notification 驱动（CP7，[src/utils/token.ts](../../../src/utils/token.ts)），由 [ContextBar](../../../web/src/features/agent/ContextBar.vue) 渲染。纯历史查看不计算该值。

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
>
> **hover 检测区 = 整个 `.pet`**（`pointerenter/leave` 绑 `.pet`，非 head-row）：悬浮 head/toolbar/name/status-row 任意位置即冻结移动，使 toolbar 按钮可稳定点中（否则悬浮移到 toolbar 触发 head-row `pointerleave` → 恢复 walk → pet 跑开追不上点）。拖拽/点击/keydown 仍在 head-row。详见 [rendering.md](./rendering.md)。

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
