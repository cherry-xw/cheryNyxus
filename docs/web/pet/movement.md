# 主/子 pet 与部落 + 运动学 + 抚摸光标

> 源码 [petMovement.ts](../../../web/src/features/pets/petMovement.ts) + [usePetWorld.ts](../../../web/src/features/pets/usePetWorld.ts) ｜ 上级 [README.md](./README.md) ｜ 基础 mood 见 [state.md](./state.md)

## 主/子 pet 与部落（从属关系）

多主 pet 共存，每主带一群子 pet，形成部落类群（不同部落视觉/移动分离）。

> **CP1 去装饰化后的产生路径**：`addPet`/`summonSub`/`removePet`/`resetPets` 装饰入口已移除——主 pet 现由 [AgentFab](../../../web/src/features/agent/AgentFab.vue) 触发 agents store `createMasterPet`（`chat.create` + `generatePet('kaomoji')`）；子 pet 由 `role_created` notification 触发（CP3，见 [agent-integration.md](./agent-integration.md)）；初始化由 `initFromChats` 从 `chat.list` 重建。下方扎堆行为/部落物理/基础 mood 描述运动学，**仍生效**（RAF/stepMovement 未变）。

- **主 pet 产生**：工具栏 `+pet`（`addPet`）→ `generatePet('kaomoji', 已用 face 集合)` 产 preset → 新主 pet（`isMaster=true`，`tribe=自身 instanceId`），全尺寸，工具列前置 `summon`。已用集合 = 当前 `pets` 全部 face（两池不相交，混合集合无害）。
- **子 pet 产生**：主 pet 的 `summon` 工具 → `summonSub(master)` → `generatePet('emoji', 已用 face 集合)`，`isMaster=false`，`tribe=master.instanceId`，初始位置在主附近。仅主 pet 持有 `summon`。
- **stewart**：原 `core` 管家概念早已移除；stewart 现仅为 `NAME_POOL` 中一个名字，不再是特殊 preset。多主平等。
- **`resetPets()` / `onMounted` 初始化**：刷 2 主 + 每主 1~2 子；主 `generatePet('kaomoji', used)`、子 `generatePet('emoji', used)`。循环前建局部 `usedFaces` 集合，每只 generate 后 `add(preset.face)` → 同批不撞脸。
- **`removePet(pet)`**：任意 pet 可驱逐（无 core 保护）。主被驱逐后其子成为孤儿（`tribe` 找不到主 → 无吸引、自由游走），不自动归并、不连带驱逐。
- **扎堆行为**：
  - 子 pet `retarget` 偏向本主（`master.pos ± TRIBE_CLUSTER_RADIUS`）→ 聚拢；斥力可将其推远，`retarget` 再拉回 → 整体聚类（允许一定程度远离，不必贴堆）。
  - 移动算法抽到 [petMovement.ts](../../../web/src/features/pets/petMovement.ts)：**力积分模型**（`stepMovement`）—— 加速度（seek 朝 target）+ 部落间力 → 速度（damping + maxSpeed）→ 位置。`vx/vy` 持久积分（有惯性），非每帧覆盖。靠近时斥力随距离线性渐增，速度渐变方向 → **平滑远离**（非位置硬修正瞬移）。
  - **部落力**（按 `tribe` 同异分施）：同部落 = 引力（`ATTRACT_RADIUS` 环带内拉拢聚拢）+ 小半径斥力（`REPEL_RADIUS` 内近距不重叠）；异部落 = 大半径斥力（`ATTRACT_RADIUS` 内分离，替代旧主-主强斥力）+ 引力（默认 0）。两主异部落 → 大半径强斥 → 不会接近。
  - **直观参数**（`MovementOptions` 覆盖，默认值即下述常量）：`maxSpeed`（移动速度）/ `acceleration`（加速度）/ `tribeAttract`·`tribeRepel`（同部落引/斥）/ `otherAttract`·`otherRepel`（异部落引/斥）/ `repelRadius`·`attractRadius`（斥/引作用半径）。
  - **主 pet 独立物理**：`stepMovement` 全量参数化，`usePetWorld.tickPet` 按 `isMaster` 传独立参数集——主 pet 取**更慢更稳**配置（更低 `maxSpeed`/`acceleration`、更小斥力与半径），稳重首领感；**且 `tribeAttract=0`（只斥力不引力）**——子 pet `retarget` 聚拢本主 + 同部落引力双向拉拢会把主 pet 钉在子 pet 堆中心，被围到屏幕边缘后斥力顶住 `keepInBounds` 边界出不去 → 全部堆积边缘不动；关引力后主 pet 凭 seek（全屏 `randomTarget`）自由游走，近距斥力仅防重叠（不重叠即无力）；子 pet 用默认值（仍受同部落引力聚拢本主）。
  - **初始位排斥采样**（`findSpawnPosition`）：生成时在落点附近尝试多次，选距所有现有 pet 中心 ≥ `MIN_SPAWN_GAP` 的点（找不到退化为最远点）→ 出生即不重叠。子 pet 落点基于主，主 pet 落点基于舞台随机 + 排斥已有主。
- **基础 mood**：主 pet `serious`（见 [state.md](./state.md)）。

## Ghost 队列路径拟合（主 Agent 带队）

同一 tribe 的主 Agent 是唯一队首；已完成 Ghost 按 `ghostCreatedAt` 排序，全部作为跟随者。RAF 每帧把主 Agent 当前 `(x,y)` 写入该 tribe 的 trail，主 Agent 自由游走、拖拽、工作冻结或停下都不会切换队首。

- 第 idx 个 Ghost 从主 Agent trail 取弧长 `(idx + 1) × GHOST_QUEUE_SPACING(32px)` 处的点；trail 不足时退化为主 Agent 当前位。
- Ghost 以弹簧加速度追踪目标点，关闭全部邻居引/斥力，避免多个点互相推挤产生抖动。
- Ghost 不进入睡眠、疲劳、hover、chatting 或拖拽状态机；缺失主 Agent 的孤儿 Ghost 才退化为普通 seek。
- Ghost 使用 `GhostDot` 纯展示组件，整个节点 `pointer-events:none`，没有点击历史、悬浮冻结、键盘焦点或工具栏。
- `GhostTrail` 的 `pts` newest-first；移动超过 6px 才采样，最多保留 80 点。多个主 Agent 按 tribe 各自维护独立 trail。

## 抚摸光标

- `.head-row` hover（未拖拽）→ 自定义手形光标（内联 SVG data URI，无外部资源）。
- `.pet.is-dragging .head-row` → `grabbing`。
- cursor 不影响布局，不触发抖动。命中区/拖拽细节见 [rendering.md](./rendering.md)。
