# 主从 Agent 桌宠系统 — 需求设计文档 (v2)

> 状态：设计迭代中 ｜ 前身：纯装饰桌宠（commit d798ecc）｜ 关联：[docs/protocol.md](docs/protocol.md)、[docs/service/chat.md](docs/service/chat.md)、[docs/web/pet.md](docs/web/pet.md)

## 1. 概述

将纯装饰桌宠系统改造为**主从 Agent 可视化交互系统**：每个 pet 绑定一个 chat（主pet=主agent会话，子pet=子agent会话），主agent 通过 sense 自主派发/回收子agent，pet 气泡/历史流可视化 chat 内容，复用后端 chat 流式 + 审批机制。

**核心隐喻**：pet 是 agent 的可视化躯壳；chat 是 agent 的会话实体；主agent 通过 `spawn_subagent` sense 创建子agent（独立 chat，parentChatId 溯源）。

## 2. 决策矩阵

| 域 | 决策 |
|----|------|
| 连接 | 打开即建连；复用 [ws.ts](web/src/services/ws.ts)/[transport.ts](web/src/services/transport.ts)/[stores/connection.ts](web/src/stores/connection.ts)；FAB 下方小字显连接状态 |
| 数据模型 | PetInstance 加 chatId/parentChatId/agentType/isWorking/contextUsage；chat 表加 parent_chat_id；多主并存 |
| spawn 语义 | wait=true：同步等子agent done 返回 content，**无超时**（不限时可一直等）；wait=false：立即返回，子agent done 后注入主agent 新一轮。子agent 内部 sense 审批保留 15min 超时 |
| 子agent配置 | **独立 `subagents` 模块**（名=给AI用的子agent名，{brain, senseGroups[]}），不复用 sense_groups 标记 |
| 子pet创建 | 主agent LLM 自主调 spawn_subagent；新增 `subagent_created` notification 推送；用户不直接创建 |
| 工具栏 | 主pet：历史/中止/销毁；子pet：历史/中止（runtime切换融入发消息弹窗，工具栏无该入口） |
| 销毁 | 子agent 由主agent sense；主agent 由用户工具栏**隐藏**（不删 DB，CP8）；会话列表 ✕ 才真删（chat.delete 级联子 chat） |
| FAB | 页面常驻圆形按钮，启动即显，下方小字连接状态；点击用 config.default 创建主pet |
| 发消息 | 点主pet→弹窗(模型+工具+输入+发送合一)；发送时若配置改了=runtime.set+chat.send |
| runtime切换 | 融入发消息弹窗（每次发消息可改 brain+senseGroups+mcpServers） |
| 历史流 | 右侧抽屉；群消息样式(用户头像右/内容左，pet头像左/内容右)；sense调用独立box(描述+指令+结果可折叠)；pet浮层显示前20字 |
| 审批 | pet气泡内审批卡片 |
| 工作气泡 | thinking阶段全空间显thinking；thinking结束后主气泡content滚动+左侧小气泡thinking(略小可滚动) |
| context bar | pet头上bar=上下文用量/brain.contextLimit；颜色随用量变红；≥50%显compact工具(预留) |
| 空页面 | 空白舞台 |
| 组件限制 | 单组件/功能点 ≤500行 |

## 3. 配置扩展（[.chery/config.yaml](.chery/config.yaml)）

```yaml
# 新增：默认主agent配置（FAB创建主pet用）
default:
  brain: longcat
  senseGroups: [default]
  mcpServers: []

# 新增：子agent类型模块（名=给AI用的子agent名）
subagents:
  read_code:
    brain: longcat           # 需在 llm.brain 列表中
    senseGroups: [default]   # 工具组=能力体现
  read_image:
    brain: longcat
    senseGroups: [default]
  web_search:
    brain: longcat
    senseGroups: [default]

# 修改：brain 加 contextLimit 字段
llm:
  brain:
    longcat:
      provider: ollama
      model: gemma3:1b
      contextLimit: 8192     # 新增：上下文长度限制(token)，用于 context bar
```

**校验**：`subagents.{name}.brain` 必须存在于 `llm.brain` 列表，否则 fail loud（[规则12](.claude/CLAUDE.md)）。

## 4. 数据模型变更

### 4.1 后端 chat 表（[db.md](docs/db.md) 扩展点）
```sql
ALTER TABLE chats ADD COLUMN parent_chat_id TEXT;  -- 子agent关联主chat，主chat为NULL
```
- `createChat(chatId, metadata?, parentChatId?)` 支持 parentChatId
- `listAllChats` 返回 `parent_chat_id` 供前端溯源重建 pet 树

### 4.2 前端 PetInstance（[types.ts](web/src/features/pets/types.ts)）
```ts
export interface PetInstance extends PetPreset {
  // ...原有视觉字段
  chatId: string;              // 绑定的 chat
  parentChatId?: string;       // 子pet关联主pet的chatId
  agentType?: string;          // 子agent类型（subagents 模块名）
  isWorking: boolean;          // 工作状态（流式中）
  contextUsage: number;        // 上下文用量(0-1，相对 brain.contextLimit)
  // 删除：emotion/fatigue 装饰数值（contextUsage 取代 fatigue 的 bar 语义）
}
```

> emotion 保留为内部 mood 驱动（可简化），fatigue 语义改为 contextUsage 驱动 bar。

## 5. 后端扩展

### 5.1 spawn_subagent sense（新增内置 sense，[agent/sense/](src/agent/sense/)）
```ts
sense("spawn_subagent", "派发子agent执行子任务",
  z.object({
    type: z.string(),          // subagents 模块名
    prompt: z.string(),        // 交付子agent的任务
    wait: z.boolean().default(false)
  }),
  async (args, sharedData, ctx) => {
    // 1. 从 config.subagents[type] 解析 brain + senseGroups（无则 throw NOT_FOUND）
    // 2. createChat(parentChatId=ctx.chatId, brain, senseGroups)
    // 3. 推送 subagent_created notification（子chatId+type+prompt+parentChatId+brain+senseGroups）
    // 4. 触发子chat.send(prompt)
    // 5. wait=true：同步等子agent done（**无超时，不限时可一直等**），返回 {content: 子agent最终content, hash}
    //    wait=false：立即返回 {content: `子agent ${type} 已派发`, hash}
    // 6. wait=false 子agent done 后：注入主agent 新一轮（见 5.4）
    // 注：wait=true 等待期间主agent sense 挂起，子agent 后台独立 chat 运行（同连接，按 chatId 路由）；
    //     子agent 内部 sense 审批（bash confirm）保留 15min 超时，spawn 等待本身无超时
  }, SupervisionLevel.auto)
```

### 5.2 destroy_subagent sense（新增）
```ts
sense("destroy_subagent", "销毁子agent",
  z.object({ chatId: z.string() }),
  async (args) => {
    // chat.delete + 推送 subagent_destroyed notification（chatId）
  }, SupervisionLevel.auto)
```

### 5.3 协议扩展（[protocol.md](docs/protocol.md)）
新增 notification 类型：
```ts
// 子agent创建（spawn_subagent 执行时）
{ kind:"notification", type:"subagent_created", requestId,
  data:{ chatId, parentChatId, type, prompt, brain, senseGroups } }

// 子agent销毁（destroy_subagent 执行时）
{ kind:"notification", type:"subagent_destroyed", requestId,
  data:{ chatId } }
```

### 5.4 异步结果注入（wait=false）
子agent done 后，后端把子agent 最终 content 作为主agent 新输入触发主agent run：
- 主agent idle → 自动 run（role=user，content=`[子agent {type}] {content}`）
- 主agent running → 入队（复用运行中 send 入队机制）
- UI：主agent 流显示为"子pet name"消息（左侧 pet 位）

### 5.5 context usage（[service/chat.md](docs/service/chat.md)）
- `chat.get` response 增返 `contextUsage`（当前上下文 token 用量 / brain.contextLimit，0-1）
- token 用量计算：暂用简化估算（消息数×系数 or 调 tokenizer），实现细节预留
- `brain.list` response 增返每个 brain 的 `contextLimit`

## 6. 前端架构设计（≤500行/组件）

### 6.1 目录结构
```
web/src/
├── App.vue                      # 根：挂 Pinia，渲染 PetStage + 全局UI
├── main.ts                      # 挂 createPinia()
├── services/
│   ├── ws.ts                    # [已有] WS客户端
│   ├── transport.ts             # [已有] 帧编解码
│   └── agentApi.ts              # [新] 高层RPC封装
├── stores/
│   ├── connection.ts            # [已有] 连接状态
│   └── agents.ts                # [新] agent/chat状态管理
├── features/
│   ├── pets/                    # [改造] pet视觉层
│   │   ├── PetStage.vue         # 舞台（删toolbar装饰）
│   │   ├── PetSprite.vue        # 单pet渲染（气泡/工具栏/context bar）
│   │   ├── usePetWorld.ts       # 改造为agent驱动（删装饰交互）
│   │   ├── petMotion.ts         # [保留]
│   │   ├── petMovement.ts       # [保留]
│   │   ├── petPresets.ts        # [保留]
│   │   ├── petStatus.ts         # [保留，fatigue语义改contextUsage]
│   │   └── types.ts             # [改造] PetInstance加chatId等
│   └── agent/                   # [新] agent交互UI
│       ├── AgentFab.vue         # FAB常驻按钮+连接状态
│       ├── AgentDialog.vue      # 发消息弹窗(模型+工具+输入+发送)
│       ├── HistoryDrawer.vue    # 右侧抽屉历史流
│       ├── MessageBubble.vue    # 消息气泡(用户右/pet左)
│       ├── SenseCallBox.vue     # sense调用box(描述+指令+结果可折叠)
│       ├── ApprovalCard.vue     # 审批卡片
│       ├── ContextBar.vue       # 上下文用量bar
│       └── PetToolbar.vue       # pet工具栏按钮组
```

### 6.2 模块职责（每个≤500行）

| 模块 | 行数预估 | 职责 |
|------|---------|------|
| [services/agentApi.ts](web/src/services/agentApi.ts) | ~150 | 封装 RPC：createAgent/sendMessage/spawnSubagent(内部)/destroyAgent/abortAgent/approval/listChats/getHistory/setRuntime |
| [stores/agents.ts](web/src/stores/agents.ts) | ~300 | pets数组(chat驱动)、流式chunk消费、notification路由、pet↔chat映射、contextUsage更新 |
| [features/pets/usePetWorld.ts](web/src/features/pets/usePetWorld.ts) | ~300(瘦身后) | RAF/retarget/拖拽/悬浮/工作状态视觉；删装饰交互(pet/feed/sleep/punch/chatting/randomEmotion) |
| [features/pets/PetSprite.vue](web/src/features/pets/PetSprite.vue) | ~400 | 单pet渲染：motion分层+气泡(thinking/content双气泡)+工具栏+context bar+审批卡片 |
| [features/agent/AgentFab.vue](web/src/features/agent/AgentFab.vue) | ~80 | 常驻圆形按钮+下方连接状态小字 |
| [features/agent/AgentDialog.vue](web/src/features/agent/AgentDialog.vue) | ~350 | brain选择+senseGroups多选+mcpServers多选+多行输入+发送；发送时diff配置→runtime.set+chat.send |
| [features/agent/HistoryDrawer.vue](web/src/features/agent/HistoryDrawer.vue) | ~300 | 右侧抽屉，chat.get流式载入，渲染MessageBubble+SenseCallBox |
| [features/agent/MessageBubble.vue](web/src/features/agent/MessageBubble.vue) | ~150 | 单条消息：用户(右)/pet(左)，含thinking折叠 |
| [features/agent/SenseCallBox.vue](web/src/features/agent/SenseCallBox.vue) | ~120 | sense调用box：描述+指令(可折叠)+结果(可折叠) |
| [features/agent/ApprovalCard.vue](web/src/features/agent/ApprovalCard.vue) | ~100 | accept/reject按钮→sense.approval |
| [features/agent/ContextBar.vue](web/src/features/agent/ContextBar.vue) | ~80 | 用量bar，颜色随usage变红(绿→黄→红) |
| [features/agent/PetToolbar.vue](web/src/features/pets/../agent/PetToolbar.vue) | ~100 | 工具栏按钮组：主pet[历史/中止/销毁]，子pet[历史/中止] |

### 6.3 状态流
```
stores/agents.ts (单一数据源)
  pets: PetInstance[]          ← chat.list + subagent_created/destroyed 维护
  activeDialogChatId           ← 点主pet打开 AgentDialog
  activeHistoryChatId          ← 点数字气泡/历史工具打开 HistoryDrawer
  streams: Map<chatId, StreamState>  ← chunk/notification 按 requestId→chatId 路由

agentApi.ts → wsClient.rpc → 后端
wsClient.onChunk/onNotification → agents.ts 路由 → 更新 pet 气泡/contextUsage/工作状态
```

## 7. UI 组件设计

### 7.1 AgentFab（FAB常驻按钮）
- 页面右下角常驻圆形按钮，启动即显
- 按钮下方小字显连接状态：`disconnected`/`connecting`/`connected`（颜色：灰/黄/绿）
- 点击 → `agentApi.createAgent(config.default)` → 主pet 出现
- props: 无；emit: `created(chatId)`

### 7.2 AgentDialog（发消息弹窗，runtime切换合一）
- 触发：点主pet
- 内容：brain 下拉 + senseGroups 多选 + mcpServers 多选 + 多行输入框 + 发送 icon
- 发送逻辑：
  - 若配置与当前 chat runtime 不同 → `runtime.set` 再 `chat.send`
  - 相同 → 直接 `chat.send`
  - 首次发消息（chat 刚由 FAB 创建）→ `chat.send`（runtime 已是 default）
- 关闭：发送后关闭弹窗，主pet 进入工作状态
- props: `chatId`；emit: `sent`

### 7.3 工作气泡（PetSprite 内）
- thinking 阶段：主气泡全空间显示 thinking（流式增量，可滚动）
- thinking 结束（content_end）：主气泡切换为 content（流式滚动）；thinking 移至左侧独立小气泡（略小、可滚动）
- 限宽高，溢出滚动
- 工作中 `isWorking=true`，action=chatting/working（视觉指示）

### 7.4 HistoryDrawer（右侧抽屉）
- 触发：点 pet 头上小数字气泡 / 工具栏"历史"
- 从右侧滑入抽屉，宽 ~40% 视口
- 内容：`chat.get` 流式载入历史，渲染：
  - 用户消息 → MessageBubble（头像右、内容左）
  - pet AI 消息 → MessageBubble（头像左、内容右，标 pet name）
  - sense 调用 → SenseCallBox（独立 box：描述+指令+结果可折叠）
  - 子agent 回传 → MessageBubble（pet左，标子pet name）
- 角色标注：用户/主pet name/子pet name

### 7.5 ApprovalCard（审批卡片）
- 触发：interrupt notification 到达，关联 pet 气泡内显示
- 内容：senseName + arguments + accept/reject 按钮
- 操作：`sense.approval(approvalId, action)`

### 7.6 ContextBar
- pet 头上 bar（取代原 fatigue bar）
- 宽度 = contextUsage（0-1）
- 颜色：<50% 绿，50-80% 黄，>80% 红
- ≥50% 时 pet 工具栏显示 compact 按钮（预留，点击发 compact 指令，后续实现）

### 7.7 PetToolbar
- 主pet：历史 / 中止(chat.abort) / 隐藏(✕ destroy=hide，CP8 修订：仅前端移除，不删 DB；isWorking/hasWorkingChild 时 disabled)
- 子pet：历史 / 中止(chat.abort)
- compact 按钮（≥50% 时显，预留）

## 8. 生命周期与初始化

```
打开页面
  → main.ts 挂 Pinia
  → App.vue onMounted: connection.init() 建连
  → 建连成功: agentApi.listChats() → 重建 pet 树
    （主chat→主pet，子chat 按 parent_chat_id 挂到主pet 附近）
  → FAB 常驻显示，下方显 connected

FAB 点击
  → agentApi.createAgent(config.default)  # chat.create
  → 主pet 出现（默认配置）

点主pet
  → AgentDialog 打开
  → 选模型/工具 + 输入消息 + 发送
  → runtime.set(若改) + chat.send
  → 主pet isWorking=true，气泡流式显示

主agent LLM 调 spawn_subagent
  → 后端创建子chat + subagent_created notification
  → 前端 agents.ts 收 notification → 创建子pet（落点主pet 附近）
  → 子pet isWorking=true（子chat.send 启动）

主agent 工具栏隐藏（CP8 修订：原"销毁"）
  → store.hide：仅前端移除主pet + 其子pet 出 pets，不调 chat.delete
  → 运行中（isWorking 或任一子 isWorking）禁用

会话列表行 ✕ 删除（CP8）
  → store.deleteSession：chat.delete（后端级联子 chat）→ historyList + pets 移除

主agent 调 destroy_subagent
  → subagent_destroyed notification → 子pet 移除

contextUsage ≥50%
  → pet 工具栏显 compact 按钮（预留）
```

## 9. 分阶段实施 checkpoint

| 阶段 | 功能点 | 验证 |
|------|--------|------|
| **CP0** | 文档落 docs/（agent-pet.md + 更新 README.md/pet.md 索引） | 文档评审 |
| **CP1** | 连接接线(main挂Pinia+init) + chat.list 初始化 + pet↔chat 映射 + 数据模型(parent_chat_id, contextLimit) + brain.list 返 contextLimit | 建连成功，历史 chat 重建为 pet |
| **CP2** | AgentFab + AgentDialog + 主pet 气泡(thinking/content双气泡) + 工作状态 + 流式chunk消费 + ContextBar | FAB创建主pet，发消息，气泡实时显示，context bar 工作 |
| **CP3** | 后端 spawn_subagent sense + subagent_created notification + 子pet 创建/显示 + subagents 配置 | 主agent 派发子任务，子pet 出现并工作 |
| **CP4** | HistoryDrawer + MessageBubble + SenseCallBox + 群消息样式 | 点击数字气泡看完整历史 |
| **CP5** | ApprovalCard（interrupt→accept/reject） | bash confirm 审批闭环 |
| **CP6** | 中止(chat.abort) + 隐藏(hide，原销毁改为前端隐藏，CP8) + destroy_subagent sense + subagent_destroyed notification + 异步结果注入 | 全生命周期闭环 |
| **CP7** | compact 工具预留(≥50%显示) + 文档更新 + 验收 | 全流程通 |

## 10. 待确认/推荐方案

| 项 | 推荐方案 | 状态 |
|----|---------|------|
| 异步注入角色 | user role + 前缀 `[子agent {type}]`，UI 显示子pet name 左侧 | 推荐，待确认 |
| spawn 在主agent 流显示 | sense box（spawn_subagent 调用记录） | 推荐，待确认 |
| context usage 计算 | 简化估算（消息数×系数），后续接 tokenizer | 推荐，待确认 |
| compact 指令语义 | 后端 compact RPC（压缩上下文），具体预留 | 预留 |
| 子pet 点击行为 | 打开 HistoryDrawer（子pet 无发消息权限） | 推荐，待确认 |
| 工作状态 action | 复用 `chatting`（不新增 action，减 motion 改动） | 推荐，待确认 |
| 子agent 运行连接 | 复用主 WS 连接，按 requestId/chatId 路由到对应 pet | 推荐，待确认 |
| 文档落点 | docs/ 根 `agent-pet.md`（跨前后端）+ 更新 docs/README.md 索引 | 待确认 |
| emotion 字段去留 | 保留为内部 mood 驱动，移除交互增量 | 推荐，待确认 |

## 11. 前端 pet 模块改造清单（[docs/web/pet.md](docs/web/pet.md) 同步）

**删除**：
- invokeTool 装饰分支（pet/feed/sleep/punch/dismiss/summon）
- pet 间 chatting（maybeTriggerChats/triggerChat/CHAT_*）
- randomEmotion/mood 按钮
- PetStage toolbar（+pet/pause/reset/mood）
- emotion 交互增量（保留字段，移除交互驱动）

**保留**：
- 运动（RAF/retarget/stepMovement/部落物理）
- motion 动画（sprite/hand/face/speech variant）
- 拖拽/悬浮/休息（fatigue 语义改 contextUsage）
- PetSprite 渲染分层
- petPresets 程序化生成

**新增**：
- PetInstance: chatId/parentChatId/agentType/isWorking/contextUsage
- 气泡：thinking/content 双气泡 + 工作流式
- 工具栏：PetToolbar 组件（主/子不同按钮）
- context bar：ContextBar 组件
- 审批卡片：ApprovalCard 组件

## 12. 会话列表 + 销毁语义分离 (CP8)

> 一个 pet = 一个会话，日均可上百。stage 默认显最近 5 个；历史会话列表查看/加载/删除。

### 12.1 stage 默认 5 个
- `initFromChats`：`chat.list`（lean）→ 主 chat 按 `sessionRecency = max(master.updatedAt, 其子 updatedAt)` 排序取前 5 → 建主+子 pet。
- 允许临时超过 5（+ 新建 / 历史加载不挤）；用户手动 hide 才减。

### 12.2 销毁语义分离
| 动作 | 触发 | 行为 |
|------|------|------|
| 隐藏 | stage pet 工具栏 ✕（仅主 pet） | `store.hide`：移 pets（含子）+ 清 streams/spawnWaits，留 runtimes，**不调 chat.delete**；isWorking/hasWorkingChild 时 disabled |
| 删除 | 会话列表行 ✕ | `store.deleteSession`：`chat.delete`（后端级联子 chat）→ 移 historyList + pets |

### 12.3 会话列表 UI
- 入口：AgentFab `+` 下方 ☰ "会话列表"按钮 → `historyListOpen=true` + `fetchHistoryList()`。
- `fetchHistoryList`：`chat.list({includePreview:true})` → 缓存 `historyList: ChatSummary[]`。
- 行：`preview`（首条 user 消息截断 ≤40，"指令"跳过规则待定，默认 `isDirective=false`）+ last-run（`updatedAt`）+ 轮次（`turnCount`=user 消息数）；hover 显 chatId/创建时间。
- 点行 → `loadSession(chatId)`：从缓存建主+子 pet 入 `pets`（允许 >5）。
- 命名区分：`HistoryDrawer`=单 pet 消息史（▤）；`SessionList`=会话列表（☰）。

### 12.4 后端
- `chat.list` 增 `includePreview?:boolean`：true 时按 messages_month 分组批量查每 chat 首条 user 消息 → `preview`（截断）+ `turnCount`（user 消息数）；false=lean。
- `chat.delete` 级联：目标为主 chat → 删所有 `parent_chat_id===chatId` 子 chat（`deleteChat`+`clearChatRuntime`）→ 再删主。修复孤儿子 chat 缺口。

### 12.5 不持久化隐藏
- 重连重取 top-5，隐藏但仍 top-5 的 pet 会重现（transient，不增 schema）。

### 12.6 待确认
- "指令"判定规则（默认 `isDirective=false`，取首条 user 消息；系统无 `/` 指令约定，语义判定待定义）。

---

> **迭代说明**：本文档为 v2 草案，吸收 5 轮澄清 + 本轮反馈。待确认项请标注调整。定稿后落 docs/agent-pet.md，按 CP0-CP8 分阶段实施。
