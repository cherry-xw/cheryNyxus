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

## ghost 队列路径拟合（母鸡带小鸡）

ghost（子 agent `finished` 后灵魂态，见 [model.md](./model.md)）同 `tribe`（同主）按 `ghostCreatedAt` 排序成队列（**历史 ghost 按 `createdAt` ASC 序赋 `performance.now()`** = spawn 先后；实时 done 沿用 `performance.now()` -> 单位一致、先建=队首首领；`buildMasterAndChildren` 对子 chat 按 `createdAt` ASC 排序后赋值，避 listChats 的 `updated_at DESC` 序错排），**蛇形跟随首领移动路径**（非横向排排站、非吸附前驱当前位）。

- **首领（idx 0，最早 ghost）**：
  - **可拖**（[PetSprite](../../../web/src/features/pets/PetSprite.vue) `ghostDraggable` prop，由 [PetStage](../../../web/src/features/pets/PetStage.vue) 算 `leaderIds` 集合传入；非首领 ghost 仍仅 click→history）；长按拖、短按开历史。
  - **随机游走 + 近本主/远他主**：`retarget` 朝本主 `±TRIBE_CLUSTER_RADIUS`（[usePetWorld](../../../web/src/features/pets/usePetWorld.ts)）+ 异部落斥力（`stepMovement` `otherRepel` 远他主）；**零同部落力**（`tribeAttract`/`tribeRepel` = 0 → 不斥/引跟随者，跟随者方能贴上，不被首领斥力撑开）。未被拖时 `arrivedAtTarget`→idle→retarget 循环。
  - **喂 trail**：RAF `loop` 内每帧对首领当前 `(x,y)` 调 `pushTrail`（拖拽/wander/idle 均喂；tickPet 拖拽早返不影响，dragPet 已帧间更新 x/y）。
- **跟随者（idx > 0）**：
  - **路径拟合取点**：`getGhostQueueTarget` 从首领 trail 取弧长 `idx × GHOST_QUEUE_SPACING(40px)` 处的点（`pointAtArc` 线性插值），作为 seek target → 保留首领路径形状（转弯曲线），非固定 x 偏移。间距 40px（> emoji 命中区 ~26px，留余量避对角重叠遮挡；原 28px 配 `.pet` 72×96 命中区时 `.pet` 框大面积重叠致 hover/click 命中错位 ghost、leader 拖不动，收窄命中区后加大间距双保险）。
  - **弹簧追 trail 点 + 零力 seek**：跟随者 `maxSpeed × 1.25`（恒定上限）+ 加速度 = `min(GHOST_SPRING_MAX, GHOST_SPRING_K × 距 trail 点)`（弹簧力∝距离，`GHOST_SPRING_K=10` 临界阻尼 `k≈λ²/4`，`λ=-ln(0.9)×60≈6.34`）-> damping 临界阻尼平滑收敛，到点加速度->0、速度连续衰减，无硬停/无停冲（恒加速 seek + arrive 到 0/死区清零会"到点硬停->trail 点随首领移偏移又冲"一抖一抖）；`stepMovement` 传 `tribeAttract/tribeRepel/otherAttract/otherRepel = 0`（纯 seek trail 点，无邻居抖动；近本主/远他主由首领路径继承）。
  - **锁定不可拖**：`ghostDraggable=false` → `onPointerDown` 早返。
  - trail 不足（< 2 点）→ 退化为首领当前位（跟随者堆叠收敛，待 trail 增长展开）。
- **hover 静止 + 命中区收窄到 emoji**：ghost `.pet` 设 `pointer-events:none`（72×96 框不捕获 -> 消队列内 `.pet` 重叠遮挡；原重叠致 hover/click 命中错误 ghost、leader 拖不动），仅 `.head-row`（`min-width/height:0` 收缩到 `.face` emoji ~26px）`pointer-events:auto` 承接 hover/click/drag。ghost 悬停时 `hoverPet` 设 `action="hover"` → `tickPet` 早返停移动（同普通 pet）。便于点击（移动中 click 难命中 → 首领不可点击根因）+ 避免跟随者追抖动首领而抖。**hover 提层级**：`petBodyZIndex` 加 hovered 分支（z=15，低于 drag 20）-> 被悬停 ghost 置顶，残余对角重叠不被遮挡；`@pointerenter/leave` 绑 `.head-row` guard `isGhost`（非 ghost 仍由 `.pet` 大区 hover）。离开恢复 `walk`。
- **trail 纯函数**（[petMovement.ts](../../../web/src/features/pets/petMovement.ts) `GhostTrail`/`pushTrail`/`pointAtArc`）：`pts` newest-first（`pts[0]`=首领当前）；距离阈值采样（移动 >6px 才记点，保持稀疏）+ 点数上限 80；状态存 `usePetWorld` 闭包 `Map<tribe, GhostTrail>`（单 stage）。首领 hide/destroy → trail key 失联，新首领（次早 ghost）重建空 trail。

## 抚摸光标

- `.head-row` hover（未拖拽）→ 自定义手形光标（内联 SVG data URI，无外部资源）。
- `.pet.is-dragging .head-row` → `grabbing`。
- cursor 不影响布局，不触发抖动。命中区/拖拽细节见 [rendering.md](./rendering.md)。
