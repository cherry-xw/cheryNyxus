# Pet 桌宠模块

> 源码 [web/src/features/pets/](../../../web/src/features/pets/) ｜ 上级 [web](../README.md) ｜ 动画库 [motion-v](https://motion-v.com) ｜ agent 接入 [./agent-integration.md](./agent-integration.md) ｜ 跨前后端设计 [../../agent-pet.md](../../agent-pet.md)

## 职责

`web/src/features/pets/` 是桌宠视觉/运动层：多个角色在舞台上游走、交互。**CP1-CP8 已全部落地**（见 [agent-integration.md](./agent-integration.md)）：pets 数据源迁至 [stores/agents.ts](../../../web/src/stores/agents.ts)，由 chat.list + WS chunk/notification 驱动；agent 交互 UI 层在 [features/agent/](../../../web/src/features/agent/)（9 组件，见 [文件清单](#文件清单)）。

模块维护两个数值状态：`emotion`（情绪值，交互驱动 mood）与 `fatigue`（疲劳值，移动生活感，≥80 自动休息）。agent 上下文用量由独立字段 `contextUsage`（0-1）承载，经 [ContextBar](../../../web/src/features/agent/ContextBar.vue) 渲染——CP7 已接后端 token 估算（详见 [agent-integration.md](./agent-integration.md)）。

## 模块导航

| 文档 | 内容 |
|------|------|
| [model.md](./model.md) | 核心模型：PetPreset（程序化生成）+ PetInstance 字段（含 runtime） |
| [state.md](./state.md) | 状态系统：emotion/fatigue + Mood/Action/触发 + 休息机制 |
| [movement.md](./movement.md) | 主/子 pet 与部落 + 运动学 + 抚摸光标 |
| [motion.md](./motion.md) | 动画 motion-v（sprite/hand/face/speech variant） |
| [rendering.md](./rendering.md) | 渲染分层 PetSprite + z-index + 4 tier 气泡 + PetIcons slot + 闪烁逻辑 |
| [style.md](./style.md) | 样式 less（变量/mixin/嵌套） |
| [agent-integration.md](./agent-integration.md) | agent 接入 CP1-CP8 落地 + 工具栏去装饰记录 + fatigue/contextUsage 解耦 |

## 文件清单

| 路径 | 职责 |
|------|------|
| [types.ts](../../../web/src/features/pets/types.ts) | PetMood/Action/**Form**/Hands/Tool/Behavior/SleepConfig/Preset/Instance 类型（含 chatId/parentChatId/agentType/isWorking/contextUsage/runtime agent 字段） |
| [petPresets.ts](../../../web/src/features/pets/petPresets.ts) | face 部件池（KAOMOJI/EMOJI_FACES）+ `HAND_PAIRS` 配对池 + COLOR/TALK/NAME 部件 + `generatePet(form, excludeFaces?)`（含 face 去重）+ `masterFacePool`/`subFacePool` 双池导出 |
| [petMotion.ts](../../../web/src/features/pets/petMotion.ts) | sprite/hand/face/speech variant helper（含 sleep） |
| [PetSprite.vue](../../../web/src/features/pets/PetSprite.vue) | 单 pet 渲染：motion 分层 + 部件 + 状态条（emotion + ContextBar）+ PetToolbar + PetIcons + 4 tier 气泡（approval z=400 / error / work-main / speech slot）+ zzz + 光标 + slot |
| [usePetDrag.ts](../../../web/src/features/pets/usePetDrag.ts) | PetSprite 拖拽 composable：长按拖拽/短按抚摸状态机（`LONG_PRESS_MS`/`DRAG_THRESHOLD_PX` + `suppressClick`）+ `petHover` + emit startDrag/drag/endDrag/hover/clickPet；自管 `onBeforeUnmount` |
| [useStreamBubble.ts](../../../web/src/features/pets/useStreamBubble.ts) | PetSprite 工作气泡 composable：4 tier 显隐（approval/error/work-main/speech）+ 侧气泡 + retainUntil 保留 + auto-scroll 底部；收 `petHover` ref 算 `isHovered`；自管 retain 定时器 |
| [PetIcons.vue](../../../web/src/features/pets/PetIcons.vue) | pet 头部右侧 icon slot（CP5 扩展）：history 列（本 chat 最近 5 条 HistoryItem 小圆点，hover 气泡显 preview）+ approval 列（当前实心高亮 + queue 闪烁，频率=remainingSec） |
| [PetStage.vue](../../../web/src/features/pets/PetStage.vue) | 舞台 + agent 事件接线（abort/destroy/history/compact 委托 store）+ PetSprite 渲染（注入 agents.streams[chatId]） |
| [usePetWorld.ts](../../../web/src/features/pets/usePetWorld.ts) | RAF / retarget 策略 / 交互 / 主子部落 / 休息 / 慢速（状态数值逻辑抽到 petStatus.ts）；导出 `createPetInstance` 工厂供 agents store 用 |
| [petStatus.ts](../../../web/src/features/pets/petStatus.ts) | 状态数值算法纯函数：`StatusConfig`（速率/阈值/增量默认值）+ `resolveStatus` + adjustEmotion/adjustFatigue/restMood/stepVitals/shouldSleep/shouldWake |
| [petMovement.ts](../../../web/src/features/pets/petMovement.ts) | 运动学纯函数：stepMovement（力积分 seek+部落引力/斥力）/ arrivedAtTarget / findSpawnPosition（排斥采样）/ keepInBounds |

### agent 交互 UI 层（[features/agent/](../../../web/src/features/agent/)）

| 路径 | 职责 |
|------|------|
| [AgentFab.vue](../../../web/src/features/agent/AgentFab.vue) | 右下常驻圆形按钮 + 连接状态小字（disconnected/connecting/connected 三色）→ `fetchDefaultRuntime` + `createMasterPet`；CP8 增 `+` 下方 ☰ "会话列表"按钮 → `historyListOpen=true` + `fetchHistoryList` |
| [AgentDialog.vue](../../../web/src/features/agent/AgentDialog.vue) | 发消息弹窗：brain 单选 + senseGroup 单选 + mcpServers 多选下拉（并排一行）+ auto-grow 输入 + 发送（按钮在输入框右下角，线框 icon hover 填充）；runtime diff 由 store 处理；`Cmd/Ctrl+Enter` 发送 |
| [ContextBar.vue](../../../web/src/features/agent/ContextBar.vue) | contextUsage 0-1 progressbar，色阶 <50% 绿 / 50-80% 黄 / ≥80% 红 |
| [PetToolbar.vue](../../../web/src/features/agent/PetToolbar.vue) | pet 工具栏按钮组：主[历史/中止/隐藏(destroy=hide)] / 子[历史/中止] / contextUsage≥50% 显 compact；隐藏按钮 isWorking/hasWorkingChild 时 disabled（CP8） |
| [HistoryDrawer.vue](../../../web/src/features/agent/HistoryDrawer.vue) | 右侧抽屉历史流：`activeHistoryChatId` 驱动滑入滑出；`getHistory` 触发 staged 流；空/加载/历史三态 |
| [SessionList.vue](../../../web/src/features/agent/SessionList.vue) | 会话列表抽屉（CP8）：`historyListOpen` 驱动；`fetchHistoryList`（chat.list includePreview）缓存 `historyList`；行显 preview/last-run/轮次，点行 `loadSession`，✕ `deleteSession` |
| [MessageBubble.vue](../../../web/src/features/agent/MessageBubble.vue) | 单条历史消息渲染（群消息样式）：user 右 / assistant 左 / subagent 标名 + thinking 折叠 + senseCalls 嵌套；hover 头像弹详情面板（brain/senseGroup 等），user 不弹 |
| [SenseCallBox.vue](../../../web/src/features/agent/SenseCallBox.vue) | sense 调用独立 box（assistant 消息内子项）：name + 状态指示 + arguments/result 可折叠 |
| [ApprovalCard.vue](../../../web/src/features/agent/ApprovalCard.vue) | 审批卡片（pet 气泡内，z-index 400 单提避开浮层覆盖）：senseName + arguments 折叠 + Accept/Reject + ✕关闭（移队列保留）+ 倒计时 |

## HistoryDrawer 展示层合并（F 改动，2026-07-12）

group 视图（主 chat drawer）合流主+子 chat 历史时，「同一回复」会出现两次：主 chat 注入的 `role:subagent` 行（[wake.ts](../../../../src/service/chat/wake.ts) 写入主 DB）+ 子 chat 的末条 `assistant→role` 改写行（`remapChildHistory`）。**两条消息来自不同 DB 表的不同物理 row，msgId 不可能相等，store 层 msgId dedup 物理无效**。

**解决方案**：不在 store 去重，UI 展示层通过 [historyMerge.ts](../../../../web/src/stores/agents/historyMerge.ts) 生成一条临时 `HistoryItem`（`mergedView='child-to-master'`）；原始 DB 记录和后端 staged 协议均不承载该展示关系。

**字段约定**（[HistoryItem](../../../../web/src/stores/agents/types.ts)）：

- `mergedView?: 'child-to-master'` —— 标记合并产物（仅 HistoryDrawer 写）

**合并规则**（仅 `layout === 'group'` 触发）：

1. B 只取每个 `subPetChatId` 的最后一条映射 assistant 回复；中间回复永不参与合并。
2. A 必须是无 `subPetChatId` 的主 chat 角色回传，且正文与 B 完全相同、B 的时间不晚于 A。
3. 多个候选取时间最近者；距离并列或任一侧缺失时不合并，保留原始两条。
4. 用 A 的时间位置替换 A，保留 B 的 thinking、runtime、senseCalls、子/父 pet 归属。

**合并字段来源**：正文、thinking、runtime、senseCalls、子/父 pet 归属来自 B；`createdAt`、`msgId`、`spawnSenseCallId` 以 A 为准，保持“回传给父 pet”的时间线位置。

**新样式「子发送消息给主」**（[MessageBubble.vue](../../../../web/src/features/agent/MessageBubble.vue)）：

- 大头像 = 子 pet face（pet-sub 紫）+ name-initial 右上角 + 左下角 `→` send-direction 角标
- 小徽章 = 实际父 pet（主 pet 或上层子 pet）
- bubble 复用 `.role-role` 米色
- info-panel name = 发言子 pet 名称
- 仅 layout=group + mergedView 触发（`v-else-if="isMergedChildToMaster && layout === 'group'"` 双条件守卫）

**Edge cases**：

- direct 视图（子 chat 自身抽屉）：保持完整子 chat 历史，无 mergedView 项
- 子 chat 多轮（内部 user↔assistant 多轮 + 末条）：direct 全 N 条；group 前 N-1 中间 role 行无 A 配对保留 + 1 合并项 = N
- 多级 spawn（A→B→C）：A drawer 递归合流全部后代；B 的 direct drawer 只显示 B 自身历史
- A 或 B 缺失：跳过合并，原两条按原样渲染（降级不报错）

**store 层 msgId dedup**（[agents/index.ts](../../../../web/src/stores/agents/index.ts) `getHistory`）只对实际存在的同一物理消息生效；缺失 msgId 的旧历史不会被错误互相去重。详见 [agent-pet.md §5.8.8](../../agent-pet.md)。

## 扩展点

- **加角色形态**：在 [petPresets.ts](../../../web/src/features/pets/petPresets.ts) 加 face 部件（`Record<PetMood,string>`）到 `KAOMOJI_FACES`（主池）或 `EMOJI_FACES`（子池）即可被 `generatePet` 随机刷出；无需定义完整 preset（color/talks/hands 由各自部件池随机组合）。池容量 = face 去重上限（主 8 / 子 15），加 face 即放宽不撞脸上限。
- **加手部配对**：在 `HAND_PAIRS[mood]` 加 `PetHands` 配对（颜文字手臂/装饰或 emoji 动效）。
- **加台词/颜色/名字**：扩 `TALK_PARTS` / `COLOR_PARTS` / `NAME_POOL`。
- **加 mood**：扩 `PetMood` → 补全各角色 `face`/`hands` 该 mood → 在 [petMotion.ts](../../../web/src/features/pets/petMotion.ts) 加 face variant → 在 `usePetWorld` 加触发条件。详见 [motion.md](./motion.md)。
- **加动作**：扩 `PetAction` → 在 [petMotion.ts](../../../web/src/features/pets/petMotion.ts) 加 sprite/hand variant → 在 `usePetWorld` 加行为逻辑。
- **加工具**：扩 `PetTool` 列表 → 在 `invokeTool` 加 case（含 emotion 增量）。
- **调状态**：改 [petStatus.ts](../../../web/src/features/pets/petStatus.ts) 的 `DEFAULT_STATUS_CONFIG`（速率/阈值/增量默认值），或在 `usePetWorld` 模块级 `resolveStatus(overrides)` 传覆盖。详见 [state.md](./state.md)。
- **接入 agent**：CP1-CP8 已落地，详见 [agent-integration.md](./agent-integration.md) 与跨前后端设计 [agent-pet.md](../../agent-pet.md)。`contextUsage` 由后端 token 估算驱动（[src/utils/token.ts](../../../src/utils/token.ts)）；pet 工具栏/气泡/对话均已在 [features/agent/](../../../web/src/features/agent/) 实现。后续唯一扩展点：替换 `estimateTokens` 为 tokenizer、补 compact RPC。
