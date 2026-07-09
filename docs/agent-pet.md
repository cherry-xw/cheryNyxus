# 主从 Agent 桌宠系统

> 跨前后端设计文档 ｜ 前身：纯装饰桌宠（[docs/web/pet/](./web/pet/)，commit d798ecc）｜ 关联：[protocol.md](./protocol.md)、[service/chat.md](./service/chat.md)、[db.md](./db.md)、[web/pet/](./web/pet/)
>
> 实施分阶段 CP0-CP7，见 [分阶段实施](#分阶段实施-cp0-cp7)。

## 1. 概述

将纯装饰桌宠改造为**主从 Agent 可视化交互系统**：每个 pet 绑定一个 chat（主 pet = 主 agent 会话，子 pet = 子 agent 会话）。主 agent 通过 sense 自主派发/回收子 agent；pet 气泡与历史流可视化 chat 内容；复用后端 chat 流式 + 审批机制。

**核心隐喻**：pet 是 agent 的可视化躯壳；chat 是 agent 的会话实体；主 agent 经 `spawn_subagent` sense 请求派发子 agent。

## 2. 决策矩阵

| 域 | 决策 |
|----|------|
| 连接 | 打开即建连；复用 [ws.ts](../../web/src/services/ws.ts)/[transport.ts](../../web/src/services/transport.ts)/[stores/connection.ts](../../web/src/stores/connection.ts)；FAB 下方小字显连接状态 |
| 数据模型 | [PetInstance](../../web/src/features/pets/types.ts) 加 `chatId`/`parentChatId`/`agentType`/`isWorking`/`contextUsage`/`runtime?`；chat 表加 `parent_chat_id`；多主并存 |
| **spawn 驱动（关键变更）** | **前端驱动**：spawn_subagent sense 发 `subagent_created` notification（含 prompt + 子 chatId）→ 前端创建子 pet + 调 `chat.create`/`chat.send` 跑子 agent → 子 agent done 后结果回传主 pet。**不在后端 sense 内部跑子 agent**（规避 sense 无法 trigger chat.send、跨连接 busy 锁两大风险） |
| spawn wait 语义 | `wait=true`：sense 挂起等前端回传子结果（复用 approvalRegistry 式 Promise 挂起/唤醒，**无超时**），唤醒后返回子 agent content；`wait=false`：sense 立即返回，前端跑完子 agent 后将结果作新消息注入主 chat |
| 子 agent 配置 | 独立 `subagents` 模块（名 = 给 AI 的子 agent 名，`{brain, senseGroups[]}`），不复用 sense_groups 标记 |
| 子 pet 创建 | 主 agent LLM 自主调 `spawn_subagent`；后端发 `subagent_created` notification；前端创建子 pet 并驱动子 chat；用户不直接创建子 pet |
| 工具栏 | 主 pet：历史/中止/销毁；子 pet：历史/中止（runtime 切换融入发消息弹窗） |
| 销毁 | 子 agent done 后转 ghost（灵魂态保留显示，`metadata.finished` 标记，不删 DB）；主 agent 由用户工具栏 `chat.delete`（级联子 chat）。`destroy_subagent` sense 已移除——子 agent 用完即 ghost，不可复用，主 agent 发起新子任务走新 chatId |
| FAB | 页面常驻圆形按钮，启动即显，下方小字连接状态；点击用 `config.default` 创建主 pet |
| 发消息 | 点主 pet → 弹窗（模型+工具+输入+发送合一）；发送按钮在输入框右下角，去背景线框 icon，hover 描边→实心；配置变更 → `runtime.set` 再 `chat.send` |
| 历史流 | 右侧抽屉；群消息样式（用户头像右/内容左，pet 头像左/内容右）；sense 调用独立 box（指令名 + args 折叠：args 为 object，有 `description` 字段则其值作折叠标题、否则标题 'arguments'，展开显其余字段 key:value；result 折叠保持现状；气泡 max-width 92%）；去除文字角色标签，hover 头像弹详情面板（brain/senseGroups/mcpServers/agentType/contextUsage），user 不弹；pet 浮层显示前 20 字 |
| 审批 | pet 气泡内审批卡片（复用 interrupt/accept/rejected notification） |
| 工作气泡 | thinking 阶段全空间显 thinking；thinking 结束主气泡 content 滚动 + 左侧小气泡 thinking |
| context bar | pet 头上 bar = contextUsage / brain.contextLimit；颜色随用量变红。CP7 已实现简化估算（字符数近似，后续接 tokenizer） |
| 组件限制 | 单组件 ≤ 500 行 |

## 3. 配置扩展（[.chery/config.yaml](../../.chery/config.yaml)）

```yaml
# 新增：默认主 agent 配置（FAB 创建主 pet 用）
default:
  brain: longcat
  senseGroups: [default]
  mcpServers: []

# 新增：子 agent 类型模块（名 = 给 AI 的子 agent 名）
subagents:
  read_code:
    brain: longcat           # 需在 llm.brain 列表中
    senseGroups: [default]   # 工具组 = 能力体现
  read_image:
    brain: longcat
    senseGroups: [default]
  web_search:
    brain: longcat
    senseGroups: [default]

# 修改：brain 加 contextLimit 字段（context bar 用；CP7 已接简化估算）
llm:
  brain:
    longcat:
      provider: ollama
      model: gemma3:1b
      contextLimit: 8192     # 上下文长度限制(token)
```

**校验（[规则12](../../.claude/CLAUDE.md)）**：`subagents.{name}.brain` 必须存在于 `llm.brain`，否则 fail loud。

## 4. 数据模型变更

### 4.1 后端 chat 表（[db.md](./db.md) 扩展点）

```sql
ALTER TABLE chats ADD COLUMN parent_chat_id TEXT;  -- 子 agent 关联主 chat，主 chat 为 NULL
```

- [initSoulTables](../../src/db/index.ts) CREATE 加 `parent_chat_id` + `ensureChatColumn` 旧库补列
- [ChatRow](../../src/db/chat.ts) 加 `parent_chat_id?: string`
- `createChat(chatId, metadata?, parentChatId?)` 加第 3 参
- `listAllChats` 返回 `parent_chat_id` 供前端溯源重建 pet 树

### 4.2 前端 PetInstance（[types.ts](../../web/src/features/pets/types.ts)）

```ts
export interface PetInstance extends PetPreset {
  // ...原有视觉字段
  chatId: string;              // 绑定的 chat
  parentChatId?: string;       // 子 pet 关联主 pet 的 chatId
  agentType?: string;          // 子 agent 类型（subagents 模块名）
  isWorking: boolean;          // 工作状态（流式中）
  contextUsage: number;        // 上下文用量(0-1)。本轮默认 0，计算后续
  runtime?: RuntimeSelection;  // agent 运行时（brain+senseGroups+mcpServers）。主 pet createMasterPet 设、子 pet subagent_created 设、AgentDialog runtime.set 后同步；刷新后丢失
}
```

> `emotion` 保留为内部 mood 驱动（移除交互增量）；`fatigue` 语义改由 `contextUsage` 驱动 bar（本轮 bar 不生效）。

## 5. 后端扩展

### 5.1 spawn_subagent sense（新增内置 sense，[agent/sense/spawn.ts](../../src/agent/sense/spawn.ts)）

**前端驱动架构**（与原 plan 后端驱动不同）：

```ts
// description 运行时拼接 config.subagents catalog（每类型 brain+senseGroups），让 LLM 可见可用类型及能力
// type 用 z.enum(可用键) 硬约束（空配置兜底 z.string()），避免 LLM 幻觉类型名
sense("spawn_subagent", spawnDescription,   // = "派发子 agent..." + 每类型 brain/senseGroups 清单
  z.object({
    type: typeSchema,          // z.enum(可用键)（空配置兜底 z.string()）
    prompt: z.string(),        // 交付子 agent 的任务
    wait: z.boolean().default(false)
  }),
  async (args, _sharedData, ctx) => {
    // 1. 从 config.subagents[type] 解析 brain + senseGroups（无则 throw NOT_FOUND）
    // 2. createChat(childChatId, { runtime: { brain, senseGroups, mcpServers: [] } }, parentChatId=ctx.chatId)
    //    预创建并一次配齐 runtime（metadata.runtime 路径）：前端 notification 后直接 chat.send，
    //    ensureChat 自动恢复 runtime（getChatRuntimeSelection），无需 chat.create（避 PRIMARY KEY 冲突）也无需 runtime.set
    // 3. emitSubagentCreated：经 spawnBroker.broadcaster 推 subagent_created notification
    //    {childChatId, parentChatId, type, prompt, brain, senseGroups, wait}
    // 4. wait=true：await createSpawnWait(childChatId) 挂起等前端回传（无超时）
    //    前端跑完子 agent → 调 subagent.result(childChatId, content) → resolveSpawnResult 唤醒 → 返回 {content, hash}
    //    wait=false：立即返回 {content: `子 agent ${type} 已派发`, hash}
    // 注：sense 不内部跑子 agent；子 chat 由前端 chat.send 驱动，同 WS 连接按 chatId 路由 chunk
  }, SupervisionLevel.auto)
```

**wait=true 回传通道（已定）**：新建 RPC `subagent.result`（前端→后端），params `{chatId(子), content}`，handler 调 `resolveSpawnResult(chatId, content)` 唤醒挂起的 spawn Promise，返回 `{chatId, matched}`。

**wait=true 挂起机制选型（已定）**：**新建 `spawnBroker`**（[src/agent/spawnBroker.ts](../../src/agent/spawnBroker.ts)），不复用 approvalRegistry。理由：approvalRegistry 的 `resolveApproval(id, action:"accept"|"reject", reason?)` 返回 `ApprovalDecision`，语义为「审批决策」；spawn 需回传任意 content 字符串（子 agent 最终结果），塞 reason 语义错位、且需改造 approvalRegistry 接口。spawnBroker 逻辑同 approvalRegistry（集中 Map + resolve/reject + 无超时），接口契合 spawn 场景。

**notification 推送（已定）**：agent 层 `spawnBroker.setSpawnBroadcaster(fn)` 注入式回调，service 层启动时（[service/subagent/index.ts](../../src/service/subagent/index.ts) `installSpawnBroadcaster`）注入实际实现，反查 `connectionManager.findWsByChatId(parentChatId)` → `ws.send(transport.encode(notification))`。`notification.requestId` 用 `parentChatId`（sense handler 在 senseMiddleware 内 await 执行，无法取主 agent 当前 WS requestId；前端按 chatId 路由即可）。

### 5.2 destroy_subagent sense（已移除）

子 agent 用完即转 ghost（见 §5.6），不再支持主 agent 主动销毁。`destroy_subagent` sense 及其 [src/agent/sense/destroy.ts](../../src/agent/sense/destroy.ts)、`subagent_destroyed` notification 发出方已移除（`spawnBroker.emitSubagentDestroyed` 保留作防御性死代码）。会话列表 ✕（`chat.delete`）仍级联删子 chat。

### 5.6 子 agent done 转 ghost（灵魂态）

子 agent done 后不删 chat、不移除 pet，转为 ghost 可视化遗迹保留：

- **后端**（[streamMapper.ts](../../src/service/chat/streamMapper.ts) done 分支）：子 chat（`parent_chat_id` 非空）done 时 `updateChatMetadata(chatId, { finished: true })`，并在 done notification data 增 `finished:true`（主 chat 不带）。chat 保留供 `chat.get` 查历史。
- **chat.list 暴露 finished**（[handler.ts](../../src/service/chat/handler.ts) `handleChatList`）：解析 `metadata.finished` 映射到 `ChatSummary.finished`，刷新后前端据 `finished` 重建 ghost pet。
- **前端 ghost 化**（[stores/agents](../../web/src/stores/agents/index.ts)）：done notification `finished===true` → 子 pet `isGhost=true` + pick `ghostFace`（灵魂 emoji 池，**按 tribe 内创建序号顺序取** `GHOST_FACES[N % 池长]`，N=本主已存在 ghost 数；非随机、不跨实例去重--同主 ghost 固定序列 0,1,2...，不同主可同 emoji）；`buildMasterAndChildren` 重建 finished 子 pet 同样设 `isGhost`，N 按 children 迭代顺序（= `ghostCreatedAt` 队列顺序，face 与队列位一一对应）。
- **ghost 视觉**（[PetSprite.vue](../../web/src/features/pets/PetSprite.vue)）：独立形态——尺寸缩 0.42、去左右手、face 换灵魂 emoji、动画极简（微浮，不走 action/mood 闪烁）、半透明 opacity .55、隐藏 status-row；仅保留位置移动（灵魂飘动）。交互极简：仅点击身体 → HistoryDrawer（查历史），禁拖拽/hover/工具栏。
- **名字**：ghost 保留原 pet 名字（身份延续），不重新随机。

### 5.3 协议扩展（[protocol.md](./protocol.md)）

新增 notification 类型：

```ts
// 子 agent 创建（spawn_subagent 执行时，后端→前端）
{ kind:"notification", type:"subagent_created", requestId,
  data:{ chatId, parentChatId, type, prompt, brain, senseGroups, wait } }
// requestId = parentChatId（前端按 chatId 路由）

// 子 agent 销毁（destroy_subagent 执行时）—— CP6 实现
{ kind:"notification", type:"subagent_destroyed", requestId,
  data:{ chatId } }
```

新增 RPC `subagent.result`（wait=true 结果回传，CP3 已实现）：

- params：`{chatId(子), content}`
- response：`{chatId, matched}`（matched=false 表示无挂起 spawn，前端可幂等调用）
- 注册：[service/subagent/result.ts](../../src/service/subagent/result.ts) + schemas zod 校验

### 5.4 异步结果注入（wait=false）

子 agent done 后，**前端**把子 agent 最终 content 作主 agent 新输入触发主 chat：

- 主 agent idle → 前端调 `chat.send(主chatId, "[子agent {type}] {content}")`（role=user）
- 主 agent running → 复用运行中 send 入队机制
- UI：主 agent 流显示为"子 pet name"消息（左侧 pet 位）

> 角色与格式确认：role=user + 前缀 `[子agent {type}]`，UI 标子 pet name。

### 5.5 context usage（CP7 已实现简化估算）

- `chat.get` response 增返 `contextUsage`（当前 chat 总 token / brain.contextLimit，0-1）
- `chat.send`/`chat.resume` 完成时 `done` notification 增携 `contextUsage`（每轮 loop 后实时重算推送）
- `brain.list` response 增返每 brain 的 `contextLimit`（CP2 已实现）
- token 用量计算：**简化估算 `Math.ceil(text.length / 4)`**（字符数近似，英文 4 char/token；中文偏保守），累加 chat 所有非 revoked 消息 content+thinking。实现见 [src/utils/token.ts](../../src/utils/token.ts)。后续接 tokenizer（如 js-tiktoken）时替换 `estimateTokens` 实现，调用点不变
- 估算失败兜底 0 + console.warn（规则 12 fail loud：不阻塞 chat.send/get 主流程）

### 5.7 消息级 runtime 记录（每轮配置溯源）

runtime 每轮可换（AgentDialog 发消息时改 brain/senseGroups），chat 级 `metadata.runtime` 只记最后值，无法反映历史每轮配置。故 **user 消息入库时记当时 runtime**（`messages.runtime`），后续 assistant 回复基于该 user 消息数据。

- **仅 user 消息记**：[observer.ts](../../src/service/chat/observer.ts) `message_created` 入库时，`role==="user"` 传 `runtime = getChatSelection(chatId)`（当前 chat runtime，来自 [runtime.ts](../../src/service/chat/runtime.ts) `chatRuntimes`）；assistant/sense 不记（NULL）。
- **chat.get 回放关联**：[handler.ts](../../src/service/chat/handler.ts) `handleChatGet` 维护 `lastUserRuntime`。content_end role=user 带 `runtime`（从 `messages.runtime`）+ 更新 `lastUserRuntime`；role=assistant 带 `runtime = lastUserRuntime`（关联前一条 user，不入库 assistant runtime）。
- **前端 hover 面板**：[MessageBubble.vue](../../web/src/features/agent/MessageBubble.vue) 从 `item.runtime` 取 brain/senseGroups/mcpServers（不再从 pet.runtime 查）。user 不弹面板。
- **subagent 消息**：role=user 注入（`[子agent type]` 前缀），记注入时主 chat runtime（非子 agent 实际 runtime，限制）。
- **旧消息无 runtime**（迁移前）：parseMessageRow undefined → hover 显「—」（规则12）。

### 5.8 容错机制（断开恢复）

主子 agent 断开恢复容错，覆盖三个场景：

1. **主挂，子完成，刷新后主恢复**：主 ws 断，子完成回传结果丢失 → 刷新后主重新等待，子结果从 DB 重投
2. **主子都挂，刷新后恢复**：主子和 ws 都断 → 刷新后主重建等待，子继续执行
3. **主等待，子挂，主定期检查**：主 wait=true 等子，子挂起 → 主轮询子状态，超时退出

**核心改造：spawn 等待从"被动等 RPC"改为"主动心跳通知"**

#### 5.8.1 心跳机制（子 agent → 主 agent）

- **心跳 middleware**：[heartbeat.ts](../../src/agent/middleware/heartbeat.ts) 注册在 middleware 链最外层（checkpoint 之前），只管 running + error；finished 由 [loop.ts](../../src/agent/middleware/loop.ts) 发
  - running：子 agent 执行过程中，每 5s **直接调** `spawnBroker.notifyHeartbeat(childChatId, "running")`（不经 chunk yield）
  - error：子 agent 某轮出错时（catch 内）yield `heartbeat`（`status: "error"`, `error: 错误信息`），在发生轮立即通知主 reject
  - finished：**loopHandler** 在整个 loop 正常结束后 yield `heartbeat`（`status: "finished"`, `result: 最后 assistant content`）
  - **为何 running 直调**：JS async generator 是 pull-based，外部定时器无法让卡在 `await next()` 的 generator 主动 yield。若 running 走 chunk，LLM 首 token 静默期（generator 阻塞在等下游 chunk）内心跳虽入队却无法 flush，主 30s 窗口收不到 running → 误判子死亡（2026-07-09 chat 3a00530f GLM-5 首 token ~48s 实测）。直调绕过 chunk 流，静默期心跳照发
  - **为何 finished 挂 loopHandler 而非 heartbeat**：heartbeat 是 runChain 最外层，loop 每轮 runChain 都重跑一次 → 每轮流结束都 yield finished → spawn wait=true 在子首轮 assistant 就 resolve（2026-07-09 chat 27b1dbda 实测：主 +6s 收到子首条 assistant 误判完成，自己重做，子 +77s 工作全废）。finished 语义是"整个任务完成"（per-loop），必须挂 loopHandler。error 留 heartbeat（需在发生轮立即通知）
- **心跳传递**：`running` 由 heartbeat middleware 直调 `notifyHeartbeat`（不经 chunk/observer）；`finished`/`error` yield heartbeat chunk，[observer.ts](../../src/service/chat/observer.ts) 检测 `chunk.type === "heartbeat"` → 调 `spawnBroker.notifyHeartbeat(childChatId, status, result?, error?)`
- **心跳监听**：[spawnBroker.ts](../../src/agent/spawnBroker.ts) 新增 `heartbeatListeners` Map + `registerHeartbeatListener(childChatId)` + `hasHeartbeatListener(childChatId)` 函数
  - `hasHeartbeatListener` 守卫：heartbeat（running/error）与 loop（finished）据此判断是否发心跳——仅被 wait 的子 chat 发，过滤主 agent 无消费者心跳（主也跑同链/loop 但无 listener，避免 `notifyHeartbeat` "no listener" warn 噪音）
  - 主 agent wait=true 调 `registerHeartbeatListener`，返回 Promise
  - 收到 `running` 心跳 → 重置 30s 超时计时器
  - 收到 `finished` 心跳 → resolve（子结果）
  - 收到 `error` 心跳 → reject（错误信息）
  - 30s 未收到任何心跳 → reject（超时）
- **spawn.ts 改造**：[spawn.ts:103-107](../../src/agent/sense/spawn.ts#L103-L107) wait=true 分支从 `await createSpawnWait(childChatId)` 改为 `await registerHeartbeatListener(childChatId)`

#### 5.8.2 spawn 去重（避免重连后重复创建子 chat）

- **spawn.ts:84-89**：创建子 chat 前查 `findChatsByParent(parentChatId)`，找未完成（`!finished`）且同 type+prompt 的子 chat
- 命中 → 复用（`childChatId = reusableChild.chatId`），不创建新行
- 未命中 → 创建新子 chat（`randomUUID()` + `createChat`）

#### 5.8.3 前端重连重建（rebuildSpawnWaits）

- **触发时机**：
  - F5 刷新：`initFromChats` 内部调 `rebuildSpawnWaits`
  - 瞬断重连：`App.vue` `onStatus` 检测 `prevStatus === "disconnected"` → 调 `rebuildSpawnWaits`
- **重建逻辑**（[index.ts](../../web/src/stores/agents/index.ts) `rebuildSpawnWaits` 函数）：
  - 扫描所有 chat（从 `agentApi.listChats()`）
  - 子 chat `running=true && finished=false` → 重建 `spawnWaits.set(childChatId, ...)`
  - 子 chat `finished=true && running=false` → 读子结果，调 `subagentResult` 补传（幂等）
  - 主 chat `running=true && finished=false` 但前端无跟踪流（`activeDialogChatId` 不匹配） → 判定卡死，调 `abortAgent` 清死锁

#### 5.8.4 running 字段暴露

- **后端**：[handler.ts](../../src/service/chat/handler.ts) `handleChatList` 对每个 chat 查 `isChatRunning(chatId)`（[runtime.ts](../../src/service/chat/runtime.ts) 新增函数，查 `chatRuntimes.get(chatId)?.builder.isRunning()`），写入 `running` 字段
- **前端**：[agentApi.ts](../../web/src/services/agentApi.ts) `ChatSummary` 类型加 `running?: boolean`

#### 5.8.5 容错边界

- **覆盖**：WS 连接断开（后端进程存活，generator 卡内存）
- **不覆盖**：后端进程崩溃/重启（需 DB 持久化 spawn 等待状态，体量过大，后续单独立项）
- **主卡死恢复**：前端 abort+重发（纯调用层，不改 ws 层/middleware 核心）

## 6. 前端架构设计（≤500 行/组件）

### 6.1 目录结构

```
web/src/
├── App.vue                      # 根：挂 Pinia，onMounted connection.init + 订阅 chunk/notification，渲染 PetStage + 全局UI
├── main.ts                      # createPinia() + app.use(pinia)
├── services/
│   ├── ws.ts                    # [已有] WS 客户端（onChunk/onNotification/rpc 单例）
│   ├── transport.ts             # [已有] 帧编解码
│   └── agentApi.ts              # [新] 高层 RPC 封装
├── stores/
│   ├── connection.ts            # [已有] 连接状态
│   └── agents.ts                # [新] agent/chat 状态管理
├── features/
│   ├── pets/                    # [改造] pet 视觉层（去装饰化）
│   │   ├── PetStage.vue         # 舞台（删 toolbar 装饰）
│   │   ├── PetSprite.vue        # 单 pet 渲染（气泡/工具栏/context bar）
│   │   ├── usePetWorld.ts       # 改为 agent 驱动（删装饰交互）
│   │   ├── petMotion.ts         # [保留]
│   │   ├── petMovement.ts       # [保留]
│   │   ├── petPresets.ts        # [保留]
│   │   ├── petStatus.ts         # [保留，fatigue 语义改 contextUsage]
│   │   └── types.ts             # [改造] PetInstance 加 chatId 等
│   └── agent/                   # [新] agent 交互 UI（CP2+）
│       ├── AgentFab.vue         # FAB 常驻按钮 + 连接状态
│       ├── AgentDialog.vue      # 发消息弹窗（模型+工具+输入+发送）
│       ├── HistoryDrawer.vue    # 右侧抽屉历史流
│       ├── MessageBubble.vue    # 消息气泡
│       ├── SenseCallBox.vue     # sense 调用 box（指令名 + args 折叠[description 作标题,余字段 key:value] + result 折叠）
│       ├── ApprovalCard.vue     # 审批卡片
│       ├── ContextBar.vue       # 上下文用量 bar
│       └── PetToolbar.vue       # pet 工具栏按钮组
```

### 6.2 状态流

```
stores/agents.ts（单一数据源）
  pets: PetInstance[]          ← chat.list + subagent_created/destroyed 维护
  activeDialogChatId           ← 点主 pet 打开 AgentDialog
  activeHistoryChatId          ← 点数字气泡/历史工具打开 HistoryDrawer
  streams: Map<chatId, StreamState>  ← chunk/notification 按 requestId→chatId 路由

agentApi.ts → wsClient.rpc → 后端
wsClient.onChunk/onNotification → agents.ts 路由 → 更新 pet 气泡/contextUsage/工作状态
```

### 6.3 pet 模块改造清单（[web/pet/](./web/pet/) 同步）

**删除**：
- [invokeTool](../../web/src/features/pets/usePetWorld.ts) 装饰分支（pet/feed/sleep/punch/dismiss/summon）
- pet 间 chatting（maybeTriggerChats/triggerChat/CHAT_* 常量）
- randomEmotion/mood 按钮
- PetStage toolbar（+pet/pause/reset/mood）
- emotion 交互增量（保留字段，移除交互驱动）

**保留**：
- 运动（RAF/retarget/stepMovement/部落物理）
- motion 动画（sprite/hand/face/speech variant）
- 拖拽/悬浮（fatigue 语义改 contextUsage，本轮不驱动）
- PetSprite 渲染分层 + `<slot name="dialog">`（agent 内容注入入口）
- petPresets 程序化生成
- setFatigue/setEmotion（agent 注入钩子）

**新增**：
- PetInstance: chatId/parentChatId/agentType/isWorking/contextUsage
- 气泡：thinking/content 双气泡 + 工作流式（CP2）
- 工具栏：PetToolbar 组件（CP2）
- context bar：ContextBar 组件（本轮不生效）
- 审批卡片：ApprovalCard 组件（CP5）

## 7. 生命周期

```
打开页面
  → main.ts 挂 Pinia
  → App.vue onMounted: connection.init() 建连 + 订阅 onChunk/onNotification
  → 建连成功: agentApi.listChats() → 重建 pet 树（主 chat→主 pet，子 chat 按 parent_chat_id 挂主 pet 附近）
  → FAB 常驻，下方显 connected

FAB 点击 → agentApi.createAgent(config.default)（chat.create）→ 主 pet 出现

点主 pet → AgentDialog → 选模型/工具 + 输入 + 发送 → runtime.set(若改) + chat.send → 主 pet isWorking，气泡流式

主 agent LLM 调 spawn_subagent
  → 后端 createChat(parent) + subagent_created notification
  → 前端 agents.ts 收 notification → 创建子 pet + chat.send(子chatId, prompt)
  → 子 pet isWorking，子 agent 流式显示
  → 子 agent done：
      wait=true → 前端 subagent.result 回传 → 后端唤醒主 sense → 主 agent 继续
      wait=false → 前端 chat.send(主chatId, "[子agent type] content") 注入主 agent
      子 chat 标 metadata.finished → 子 pet 转灵魂态（ghost，缩小+半透明+灵魂emoji，留 stage）
      点 ghost 身体 → HistoryDrawer 查子 chat 历史

主 agent 工具栏隐藏 → store.hide（主 pet + 其子/ghost pet 移出 stage，不删 DB）
会话列表 ✕ → chat.delete（级联删子 chat，含 ghost 的）
```

## 分阶段实施 (CP0-CP7)

| 阶段 | 功能点 | 状态 | 验证 |
|------|--------|------|------|
| **CP0** | 本文档 + 更新 [README.md](./README.md)/[web/pet/](./web/pet/) 索引 | ✅ | 文档评审 |
| **CP1** | 连接接线（main Pinia+init）+ chat.list 初始化 + pet↔chat 映射 + 数据模型（parent_chat_id）| ✅ | 建连成功，历史 chat 重建为 pet |
| **CP2** | AgentFab + AgentDialog + 主 pet 双气泡 + 工作状态 + 流式 chunk 消费 + ContextBar（占位，待 CP7 接通后端估算） | ✅ | FAB 创建主 pet，发消息，气泡实时显示 |
| **CP3** | spawn_subagent sense（前端驱动）+ subagent_created notification + 子 pet 创建/显示 + subagents 配置 + subagent.result 回传 | ✅ | 主 agent 派发子任务，子 pet 出现并工作 |
| **CP4** | HistoryDrawer + MessageBubble + SenseCallBox + 群消息样式 | ✅ | 点数字气泡看完整历史 |
| **CP5** | ApprovalCard（interrupt→accept/reject） | ✅ | bash confirm 审批闭环 |
| **CP6** | 中止（chat.abort）+ 隐藏（hide）+ ~~destroy_subagent sense~~（已移除，子 agent done 改转 ghost，§5.6）+ subagent_destroyed notification（失去发出方，保留协议项）+ 异步结果注入 | ✅ | 全生命周期闭环 |
| **CP7** | contextUsage 计算（字符数估算，未接 tokenizer）+ 文档更新 + 验收 | ✅ | 全流程通（tokenizer 精确计算 + compact RPC 仍留待） |

> CP0-CP7 已全部落地。CP7 的 token 估算为字符数近似（`Math.ceil(text.length/4)`，[src/utils/token.ts](../src/utils/token.ts)），后续接 tokenizer 替换 `estimateTokens` 实现即可；compact RPC 仅 UI 预留（PetToolbar 按钮 + PetStage TODO），后端未实现。前端组件层细节见 [web/pet/agent-integration.md](./web/pet/agent-integration.md)。

## 待确认项状态

| 项 | 决策 | 状态 |
|----|------|------|
| spawn 驱动机制 | **前端驱动**（sense 发 notification，前端创建子 pet + 驱动子 chat，结果回传） | ✅ 已定（变更自后端驱动） |
| contextUsage 计算 | CP7 已实现简化估算（字符数 / 4 近似，累加非 revoked 消息 content+thinking）；后续接 tokenizer 替换 `estimateTokens` 即可 | ✅ 已实现（CP7） |
| async 注入角色 | role=user + 前缀 `[子agent {type}]`，UI 标子 pet name | ✅ 已定 |
| 异步注入触发方 | **前端**触发（chat.send 注入主 chat），非后端 | ✅ 已定 |
| wait=true 回传通道 | 新 RPC `subagent.result`（params `{chatId, content}`，返回 `{chatId, matched}`）+ 新建 `spawnBroker`（集中 Map + resolve/reject，**不复用 approvalRegistry** 因 resolve 签名语义错位） | ✅ 已定（CP3 实现） |
| compact 指令语义 | 后端 compact RPC（压缩上下文），具体预留 | ⏳ 预留 |
| 子 pet 点击行为 | 打开 HistoryDrawer（子 pet 无发消息权限） | 推荐 |
| 工作状态 action | 复用 `chatting`（不新增 action） | 推荐 |
| emotion 字段去留 | 保留为内部 mood 驱动，移除交互增量 | 推荐 |
