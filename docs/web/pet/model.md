# 核心模型

> 源码 [types.ts](../../../web/src/features/pets/types.ts) + [petPresets.ts](../../../web/src/features/pets/petPresets.ts) ｜ 上级 [README.md](./README.md) ｜ 状态见 [state.md](./state.md) ｜ 主/子产生见 [movement.md](./movement.md)

## 角色（PetPreset）— 程序化生成（部件池 + `generatePet`）

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

- **程序化生成**：pet 不再是固定 preset 数组，由 [petPresets.ts](../../../web/src/features/pets/petPresets.ts) 的 `generatePet(form, excludeFaces?)` 运行时组合部件产出 `PetPreset`：`face`（`KAOMOJI_FACES`/`EMOJI_FACES` 池）+ `hands`（`HAND_PAIRS` 每 mood 抽一对）+ `color`/`accent`（`COLOR_PARTS`）+ `talks`（`TALK_PARTS`）+ `name`（`NAME_POOL`）；`tools`/`behaviors` 沿用默认，`sleep` 不设（默认 `zZ`）。**face 去重**：`excludeFaces` 传入同类已用 face 集合（`Set`，按对象引用相等），`generatePet` 从池中排除已用项；池耗尽则回退全池随机（允许重复），`+pet`/`summon` 始终可用。仅 `face` 去重，`color`/`name`/`talks` 仍随机。
- **form 三态**（`PetForm`）：`'kaomoji'`=主池（颜文字 face）/ `'emoji'`=子池（emoji face）/ `'random'`=按池容量比例纯随机。导出 `masterFacePool`/`subFacePool` 两个 face 部件数组（即主/子池）。两池对象不相交 → face 去重只在同类内生效（主不与子撞脸）。
- **手部配对池** `HAND_PAIRS: Record<PetMood, PetHands[]>`：每 mood ~8 配对，含颜文字手臂/装饰（参考 lddgo.net/common/emoticons）+ emoji 动效（跑→happy/panicked、汗→surprised/panicked、放屁→nagging、哭→sad、掀桌→angry）。`buildHands()` 每 mood 独立抽一对 → 跨 mood 混搭、单 mood L/R 协调。
- **混合渲染**：emoji 角色 `face`=emoji、颜文字角色 `face`=眼睛/嘴部件；`hands` 跨类型混搭（颜文字 + emoji）。渲染拼装：`hands[mood].left` + `face[mood]` + `hands[mood].right`（无独立 body 字符）。详见 [rendering.md](./rendering.md)。
- **主/子 pet 为运行时状态**（`isMaster`/`tribe`，见下）；**主 pet 由 `generatePet('kaomoji')` 产出，子 pet 由 `generatePet('emoji')` 产出**（见 [movement.md](./movement.md)）。

## 实例状态（PetInstance）

每个 pet 实例除 preset 字段外，运行时维护：

| 字段 | 说明 |
|------|------|
| `isMaster` | 主 pet 标记。主 = 全尺寸 + 持有 `summon` 工具 + 基础 mood `serious`；子 = 体型缩小（`--pet-scale`）。 |
| `tribe` | 部落 id = 本主 pet 的 `instanceId`。主 pet 的 `tribe` = 自身 instanceId；子 pet 的 `tribe` = 其主 instanceId。同 `tribe` = 同部落（聚拢），异 `tribe` = 异部落（避让分离）。 |
| `emotion` 0-100 | 情绪值。交互驱动（抚摸+、戳-），随时间缓降。低值 → `sad`/`angry` 基础 mood |
| `fatigue` 0-100 | 疲劳值。移动/拖拽累积，≥80 自动休息；休息时下降。**与 contextUsage 解耦**：contextUsage 是独立字段（CP7 已接后端 token 估算，反映 agent 上下文负担），fatigue 仅保留为 pet 移动生活感。 |
| `mood` / `action` | 当前表情与动作（见 [state.md](./state.md)） |
| `moodUntil` / `interactionUntil` | 临时 mood / 聊天结束时间戳 |
| `draggingPointerId` / `dragOffset*` | 拖拽状态 |
| `runtime?` | agent 运行时配置（`RuntimeSelection`：brain + senseGroups + mcpServers）。主 pet 由 `createMasterPet` 设；子 pet 由 `subagent_created` notification 设（brain/senseGroups 来自 notification）；AgentDialog `runtime.set` 后同步。**刷新后丢失**（initFromChats 不恢复）→ hover 详情面板显「—」。详见 [agent-integration.md](./agent-integration.md)。 |
