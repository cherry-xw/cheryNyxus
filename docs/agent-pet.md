# 主从 Agent 桌宠系统

> 跨前后端设计文档 ｜ 前身：纯装饰桌宠（[docs/web/pet/](./web/pet/)，commit d798ecc）｜ 关联：[protocol.md](./protocol.md)、[service/chat.md](./service/chat.md)、[db.md](./db.md)、[web/pet/](./web/pet/)
>
> 实施分阶段 CP0-CP7，见 [分阶段实施](#分阶段实施-cp0-cp7)。

## 1. 概述

将纯装饰桌宠改造为**主从 Agent 可视化交互系统**：每个 pet 绑定一个 chat（主 pet = 主 agent 会话，子 pet = 子 agent 会话）。主 agent 通过 sense 自主派发/回收子 agent；pet 气泡与历史流可视化 chat 内容；复用后端 chat 流式 + 审批机制。

**核心隐喻**：pet 是 agent 的可视化躯壳；chat 是 agent 的会话实体；主 agent 经 `spawn_role` sense 请求派发子 agent。

## 2. 决策矩阵

| 域 | 决策 |
|----|------|
| 连接 | 打开即建连；复用 [ws.ts](../../web/src/services/ws.ts)/[transport.ts](../../web/src/services/transport.ts)/[stores/connection.ts](../../web/src/stores/connection.ts)；FAB 下方小字显连接状态 |
| 数据模型 | [PetInstance](../../web/src/features/pets/types.ts) 加 `chatId`/`parentChatId`/`agentType`/`isWorking`/`contextUsage`/`runtime?`；chat 表加 `parent_chat_id`；多主并存 |
| **spawn 驱动（关键变更）** | **前端驱动**：spawn_role sense 发 `role_created` notification（含 prompt + 子 chatId）→ 前端创建子 pet + 调 `chat.create`/`chat.send` 跑子 agent → 子 agent done 后结果回传主 pet。**不在后端 sense 内部跑子 agent**（规避 sense 无法 trigger chat.send、跨连接 busy 锁两大风险） |
| spawn wait 语义 | `wait=true`：sense 挂起等前端回传子结果（复用 approvalRegistry 式 Promise 挂起/唤醒，**无超时**），唤醒后返回子 agent content；`wait=false`：sense 立即返回，前端跑完子 agent 后将结果作新消息注入主 chat |
| 角色配置 | 独立 `roles` 模块（名 = 给 AI 的角色名，`{brain, senseGroup}`），不复用 sense_groups 标记 |
| 子 pet 创建 | 主 agent LLM 自主调 `spawn_role`；后端发 `role_created` notification；前端创建子 pet 并驱动子 chat；用户不直接创建子 pet |
| 工具栏 | 主 pet：历史/中止/销毁；子 pet：历史/中止（runtime 切换融入发消息弹窗） |
| 销毁 | 子 agent done 后转 ghost（灵魂态保留显示，`metadata.finished` 标记，不删 DB）；主 agent 由用户工具栏 `chat.delete`（级联子 chat）。`destroy_role` sense 已移除——子 agent 用完即 ghost，不可复用，主 agent 发起新子任务走新 chatId |
| FAB | 页面常驻圆形按钮，启动即显，下方小字连接状态；点击弹预设选择器选预设创建主 pet（无独立 `default`，旧 default 已并入「默认」预设，见 §3.1） |
| 发消息 | 点主 pet → 弹窗（模型+工具+输入+发送合一）；发送按钮在输入框右下角，去背景线框 icon，hover 描边→实心；配置变更 → `runtime.set` 再 `chat.send` |
| 历史流 | 右侧抽屉；群消息样式（用户头像右/内容左，pet 头像左/内容右）；sense 调用独立 box（指令名 + args 折叠：args 为 object，有 `description` 字段则其值作折叠标题、否则标题 'arguments'，展开显其余字段 key:value；result 折叠保持现状；气泡 max-width 92%）；去除文字角色标签，hover 头像弹详情面板（brain/senseGroup/mcpServers/agentType/contextUsage），user 不弹；pet 浮层显示前 20 字 |
| 审批 | pet 气泡内审批卡片（复用 interrupt/accept/rejected notification） |
| 工作气泡 | thinking 阶段全空间显 thinking；thinking 结束主气泡 content 滚动 + 左侧小气泡 thinking |
| context bar | pet 头上 bar = contextUsage / brain.contextLimit；颜色随用量变红。CP7 已实现简化估算（字符数近似，后续接 tokenizer） |
| 组件限制 | 单组件 ≤ 500 行 |

## 3. 配置扩展（[.chery/config.yaml](../../.chery/config.yaml)）

```yaml
# 子 agent 类型模块（名 = 给 AI 的子 agent 名；单一源定义，预设按 type 引用，见 §3.1）
roles:
  read_code:
    brain: longcat           # 需在 llm.brain 列表中
    senseGroup: default   # 工具组 = 能力体现
    mcpServers: []           # MCP server 名（缺省 []，与主 agent 平权）
    # systemPrompt: prompts/reader.md   # 缺省 → 全局 config.global.system_prompt
  read_image:
    brain: longcat
    senseGroup: default
  web_search:
    brain: longcat
    senseGroup: default

# 主 pet 编制 = 预设（presets，见 §3.1）；无独立 default 段——旧 default 已并入「默认」预设。

# 修改：brain 加 contextLimit 字段（context bar 用；CP7 已接简化估算）
llm:
  brain:
    longcat:
      provider: ollama
      model: gemma3:1b
      contextLimit: 128000   # 记忆容量；设置页默认以 K 为单位输入/显示（128 = 128K）
```

设置页为记忆容量提供 `128`、`256`、`512`、`1024` 四个预设，默认单位为 K，因此下拉选项和手动输入均不显示单位；配置中仍保存完整数值（如 `128` 保存为 `128000`）。

**校验（[规则12](../../.claude/CLAUDE.md)）**：`roles.{name}.brain` 必须存在于 `llm.brain`，否则 fail loud。

### 3.1 预设系统（Presets，T5/T6/T8）

预设 = 一套命名的 agent 编制包：组长角色 type（`leader`）+ 选中的角色类型列表（`roles: [type...]`，**引用** `config.roles` 单一源定义，不在预设内重定义）。`leader` 必须是 `roles` 中的一项；主 pet 的编制取该角色的配置。主 pet 启动时选一套预设，**编制（leader 角色的 senseGroup/mcp/systemPrompt + 选中的角色类型集）运行后不可改；leader 角色的 brain 为默认值、每轮可覆盖**（保留框架「Brain 每轮可换」原则）。

```yaml
presets:
  默认:                          # 旧 config.default 迁移而来：FAB 兜底预设
    leader: coordinator_ali       # config.roles 的角色 type；主 pet 编制从该角色取得
    roles: [coordinator_ali, read_code, read_image, plan, coder]
  项目:                          # 项目预设（T10 样例）：多角色分工——主协调（无 update_todo），planner 规划+管 todo / coder 实现 / reviewer 只读评审
    leader: coordinator_proj
    roles: [coordinator_proj, plan, coder, reviewer]
  轻量:                          # 轻量预设（T10 样例）：单 agent 自管 todo（leader 全工具 + plan 的 update_todo），无角色
    leader: coordinator
    roles: [coordinator]       # leader 必须包含在 roles；无其他角色即 solo
```

**多角色样例（项目预设，T10）**：主 agent（`leader` 组，无 `update_todo`）经 `spawn_role(wait=true)` 分派角色子 agent → 主 yield turn → 各子完成依次注入角色回复唤主 → 主汇总。todo 仅显于 planner 子 pet（`plan` 组含 `update_todo`，能力驱动，无 task-scale 判断逻辑）；reviewer 子 pet 用只读 `reviewer` 组（不改代码）。子 agent persona 由 `config.roles.<type>.systemPrompt` 单一源定义（per-type，非 per-preset）——故 planner persona 在所有引用 `plan` 的预设生效。

**字段语义**：
- `presets.<name>.leader`：组长角色 type 名，必须引用 `config.roles` 且包含于该预设的 `roles`。主 agent 的 brain/senseGroup/mcpServers/systemPrompt 均从该角色取得；brain 每轮可覆盖（runtime.set brain-only），sense/mcp/systemPrompt 锁定。
- `presets.<name>.roles`：`string[]`，引用 `config.roles` 中已定义的子 agent type 名（**不在预设内重定义** brain/sense 等）。子 agent 的 brain/senseGroup/mcpServers/systemPrompt 统一在 `config.roles.<type>` 单一源维护。
- `systemPrompt` 路径相对 `.chery`（loadConfig 解析为绝对）；缺省 → 全局。per-agent prompt 数据流见 [agent/prompt.md](./agent/prompt.md)。

**T6 选择与解析（已落地）**：
- **主 pet 创建**（`chat.create`）携带 `preset` 名 → 后端用 `config.presets[preset].leader` 查找对应的 `config.roles[leader]`，从中解析 `{brain, senseGroup, mcpServers}` 作 RuntimeSelection 快照写入 `metadata.runtime`；该角色的 `systemPrompt`（绝对路径）写入 `metadata.promptPathOverride`；`metadata.preset` 记预设名；`metadata.spawnTypes` 快照写入该预设选中的角色 type 列表（编制锁定一致）。主 pet 恒走预设（无独立 default；旧 default 迁为「默认」预设）。
- **编制锁定**：创建即快照入 `metadata.runtime` + `metadata.spawnTypes`，运行后不可改（即便设置面板编辑预设，只影响**未来**新建 pet，已运行 chat 用自身快照）。
- **runtime.set（preset chat）**：仅 `brain` 可覆盖，`senseGroup`/`mcpServers` 强制取现有快照；显式带了不同 senseGroup/mcp → fail loud（防前端绕过锁定）。
- **spawn roster gate**：角色定义恒从 `config.roles[type]` 单一源解析；可 spawn 的类型集 = 该 chat 预设选中的 `spawnTypes` 快照（preset chat），未选中类型 spawn → fail loud。子 chat（无 preset）→ 全集 `config.roles` 可用（递归：子也可 spawn 子）。catalog 描述（LLM 可见）= `config.roles` 全集（模块加载期冻结，sense 定义不支持 per-chat 动态），实际 roster 由执行期 gate 强制。

**与 roles 关系**：`config.roles` 是角色的唯一来源（全字段 brain/senseGroup/mcpServers/systemPrompt）；预设只从中**选择** type 子集。todo 存在与否 = 是否在 senseGroup（无 task-scale 判断逻辑）。

**T8 编辑 UI（已落地）**：设置面板（[SettingsDialog.vue](../../web/src/features/agent/settings/SettingsDialog.vue)）「预设」tab = [PresetsTab.vue](../../web/src/features/agent/settings/tabs/PresetsTab.vue)。每预设一卡片：`leader` 选择 `config.roles` 中的角色 type，`roles` 多选已定义的 type 名；角色的 brain、senseGroup、mcpServers、systemPrompt 均在「角色」tab 维护，不在预设内联编辑。增删预设走底部输入框 + ConfirmPopover。保存统一走外壳 `config.save`，presets 段经后端 schema + `validateRawConfig` 校验 fail loud。**「默认宠物」tab 已移除**（default 并入预设）；默认 brain/senseGroup/mcp 标记（AgentDialog 无 runtime 预选用）派生自「默认」预设的 leader 角色。

**校验**：`presets.<name>.leader` 必须引用 `config.roles` 且存在于同一预设的 `roles`；`presets.<name>.roles[*]` 引用的 type 必须存在于 `config.roles`；每个 `roles.<type>.brain` 必须存在于 `llm.brain`，其 `systemPrompt` 文件须存在（皆 fail loud）。`config.save`（设置面板编辑）的 `presets` 段同样校验（见 [service/README.md](./service/README.md)）。

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
  agentType?: string;          // 角色类型（roles 模块名）
  isWorking: boolean;          // 工作状态（流式中）
  contextUsage: number;        // 上下文用量(0-1)。本轮默认 0，计算后续
  runtime?: RuntimeSelection;  // agent 运行时（brain+senseGroup+mcpServers）。主 pet createMasterPet 设、子 pet role_created 设、AgentDialog runtime.set 后同步；刷新后丢失
}
```

### 4.x P3 错误状态（流式失败 UI 反馈）

`StreamState`（[web/src/stores/agents/types.ts](../../web/src/stores/agents/types.ts)）增 `error?: string` 字段，记录当前流式失败的 message。三个写入路径：

1. **sendMessage 捕获 done Promise**（[web/src/stores/agents/index.ts:319-346](../../web/src/stores/agents/index.ts#L319-L346)）：解构 `{ requestId, done }`，`done.then(res => { if (!res.success) stream.error = res.error?.message; }).catch(e => { stream.error = "连接中断: " + e.message; })`。覆盖 final Response.success:false（后端 P2 修复产 failureResponse 时命中）。
2. **routeNotification error 分支**（[web/src/stores/agents/index.ts:674-676](../../web/src/stores/agents/index.ts#L674-L676)）：error notification 到达时填 `stream.error = errMsg`，覆盖 retry-yielded ErrorChunk 流中路径（done Promise resolve 之前）。
3. **resumeAgent 同样捕获**（[web/src/stores/agents/index.ts:354](../../web/src/stores/agents/index.ts#L354)）。

UI 反馈：[web/src/features/pets/PetSprite.vue](../../web/src/features/pets/PetSprite.vue) 在 work-bubble 旁渲染 `error-bubble`（`v-if="stream?.error"`），红边浅红底，`retainUntil = Date.now() + 30000`（30s 自动隐藏）。Pet action 立即恢复 walk（不等 retain），与 done 后 20s 冻结区分。

> `emotion` 保留为内部 mood 驱动（移除交互增量）；`fatigue` 语义改由 `contextUsage` 驱动 bar（本轮 bar 不生效）。

## 5. 后端扩展

### 5.1 spawn_role sense（新增内置 sense，[agent/sense/spawn.ts](../../src/agent/sense/spawn.ts)）

**前端驱动架构**（与原 plan 后端驱动不同）：

```ts
// description 运行时拼接 catalog（= config.roles 单一源，让 LLM 可见可用类型及能力）
// type 用 z.enum(roles 键) 硬约束（空配置兜底 z.string()），避免 LLM 幻觉类型名
// 注：catalog 为全局全集（sense 定义模块加载期冻结，不支持 per-chat 动态）；实际可 spawn 类型由执行期 roster gate 强制
sense("spawn_role", spawnDescription,   // = "派发子 agent..." + 每类型 brain/senseGroup 清单
  z.object({
    type: typeSchema,          // z.enum(roles 键)（空配置兜底 z.string()）
    prompt: z.string(),        // 交付子 agent 的任务
    wait: z.boolean().default(false)
  }),
  async (args, _sharedData, ctx) => {
    // 1. 子 agent 定义恒从 config.roles[type] 单一源解析（无则 throw）
    //    roster gate：preset chat → metadata.spawnTypes 快照（未选中 type → fail loud）；子 chat（无 preset）→ 全集可用
    // 2. createChat(childChatId, { runtime: { brain, senseGroup, mcpServers: roleCfg.mcpServers ?? [] }, promptPathOverride }, parentChatId=ctx.chatId)
    //    预创建并一次配齐 runtime（metadata.runtime 路径）：前端 notification 后直接 chat.send，
    //    ensureChat 自动恢复 runtime（getChatRuntimeSelection）+ prompt（getChatPromptOverride），无需 chat.create/runtime.set
    // 3. emitRoleCreated：经 spawnBroker.broadcaster 推 role_created notification
    //    {childChatId, parentChatId, type, prompt, brain, senseGroup, wait}
    // 4. wait=true：registerWaitedChild(childChatId,{parentChatId,type}) + 启动 watchdog + ctx.soul.yieldTurn=true
    //    + 立即返回 {content: `子 agent ${type} 已派发，等待结果`, hash}（不再 await 阻塞）
    //    主 loop 见 yieldTurn 立即结束本 turn（done 正常发）；子完成后后端注入角色回复唤起新一轮（见 §5.4）
    //    wait=false：立即返回（纯 fire-and-forget，主 loop 继续，不收子结果）
    // 注：sense 不内部跑子 agent；子 chat 由前端 chat.send 驱动，同 WS 连接按 chatId 路由 chunk
  }, SupervisionLevel.auto)
```

**wait 两态语义（2026-07-09 重构，废除原阻塞心跳）**：
- `wait=false`：spawn 立即返回，主 loop **继续**（纯 fire-and-forget，子结果不回传主）。
- `wait=true`：spawn 立即返回 + 主 loop **立即结束本 turn**（`ctx.soul.yieldTurn`）+ 子完成后**后端注入角色回复**唤起主跑新一轮（区别于 user 消息，见 §5.4）。递归：任何有 spawn 能力的 agent（含子）都可被其 spawn 的子唤醒。
- **废除**：原 `subagent.result` RPC、`spawnBroker.pendingSpawns`/`resolveSpawnResult`（legacy 未用）、阻塞心跳（`heartbeatListeners`/`registerHeartbeatListener`/`notifyHeartbeat`/`hasHeartbeatListener`/`clearHeartbeatListener`）。唤醒链改 `waitedChildren` Map（见 §5.4/§5.8）。

**spawnBroker 选型（保留）**：新建 `spawnBroker`（[src/agent/spawnBroker.ts](../../src/agent/spawnBroker.ts)）集中管 spawn 唤醒态，不复用 approvalRegistry（语义错位）。当前职责：`waitedChildren` Map + watchdog + broadcaster 注入 + `rebuildFromDb`（重启重建）。

**notification 推送（保留+扩展）**：`spawnBroker.setSpawnBroadcaster(fn)` 注入式回调，service 层 `installSpawnBroadcaster` 注入实现，反查 ws → `ws.send(transport.encode(notification))`。`role_created` 用 `findWsByChatId(parentChatId)`（主 turn 活跃时绑定在）；`role_reply` 唤醒通知用持久 `findOwnerWsByChatId`（主 turn 已结束、绑定已释放，见 §5.4）。`notification.requestId` 用 `parentChatId`（前端按 chatId 路由）。

### 5.2 destroy_role sense（已移除）

子 agent 用完即转 ghost（见 §5.6），不再支持主 agent 主动销毁。`destroy_role` sense 及其 [src/agent/sense/destroy.ts](../../src/agent/sense/destroy.ts)、`role_destroyed` notification 发出方已移除（`spawnBroker.emitRoleDestroyed` 保留作防御性死代码）。会话列表 ✕（`chat.delete`）仍级联删子 chat。

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
// 子 agent 创建（spawn_role 执行时，后端→前端）
{ kind:"notification", type:"role_created", requestId,
  data:{ chatId, parentChatId, type, prompt, brain, senseGroup, wait } }
// requestId = parentChatId（前端按 chatId 路由）

// 子 agent 销毁（destroy_role 执行时）—— CP6 实现
{ kind:"notification", type:"role_destroyed", requestId,
  data:{ chatId } }
```

新增 RPC `subagent.result`（wait=true 结果回传，CP3 已实现）：

- **2026-07-09 废除**：wait=true 重构为「yield turn + 后端注入唤醒」（§5.4），结果不再由前端 RPC 回传。`subagent.result` handler + [service/subagent/result.ts](../../src/service/subagent/result.ts) + `spawnBroker.resolveSpawnResult` 全删；前端 `agentApi.subagentResult` 方法 + wait=true 回传分支删。

新增 notification 类型（wait=true 唤醒）：

```ts
// 子完成唤主（子 loop 结束 + waitedChildren 命中时，后端→前端）
{ kind:"notification", type:"role_reply", requestId,
  data:{ parentChatId, childChatId, type, content } }
// requestId = parentChatId；前端收后自动 chat.resume(parentChatId) 跑唤醒轮
// content 仅即时展示用，权威内容已注入主 chat DB（role:subagent）
```

### 5.4 wait=true 唤醒机制（B1：后端注入 + 前端续跑）

wait=true 子完成后唤主跑新一轮。**传输架构 B1**（探索确认 streamMapper 沿请求 socket 回 + `findWsByChatId` 仅主 turn 活跃时有效，后端无法 turn 后流式推）：后端只注入回复 + 推一个 notification，实际唤醒轮由**前端 `chat.resume`** 发起（新 socket，复用全部现有流式路径，零后端起流风险）。

**唤醒链 `waitedChildren`**（[spawnBroker.ts](../../src/agent/spawnBroker.ts)）：`Map<childChatId, {parentChatId, type}>`。spawn wait=true 时 `registerWaitedChild`；唤醒后 `clearWaitedChild`。递归天然支持（任何 agent 的 spawn 子都在此 Map，子可再 spawn）。

**唤醒流**：
1. 子 agent loop 结束（[loop.ts](../../src/agent/middleware/loop.ts) ~L111）：`getWaitedParent(ctx.soul.chatId)` 命中 → yield `child_done` chunk `{childChatId, content:末条 assistant content}`（替代原 heartbeat yield）。
2. 子 [observer.ts](../../src/service/chat/observer.ts) 消费 `child_done` → `getWaitedParent` → 调 `wakeParent(parentChatId, childChatId, type, content)`：
   - `ensureChat(parent)` → builder journal `appendRoleReply({content, agentType})` 写 soul.messages（内存，守单一写者）+ `addMessage` 直接落库 role:subagent（主 observer 未运行，不走 effect 路径）。
   - 推 `role_reply` notification（`findOwnerWsByChatId(parent)`，rid=parentChatId）。
   - `clearWaitedChild` + clearWatchdog + 子 metadata `wait:false`（标记已消费）。
3. 前端收 `role_reply` → 自动 `chat.resume(parentChatId)` → 主跑新一轮：loop 见末条 role:subagent → continue → LLM 响应 → 正常流式。

**subagent role**：新增后端 role（4 处类型 widening：[adapter.ts](../../src/agent/provider/../message/adapter.ts) Role + [db/chat.ts](../../src/db/chat.ts) MessageData + [core/middleware/types.ts](../../src/core/middleware/types.ts) AgentMessage + [service/message/types.ts](../../src/service/message/types.ts) StagedChunkData；DB role 自由 TEXT 无迁移）。Provider buildMessages 加 `subagent→user` 映射（防 OpenAI 拒未知 role）。前端 `subagent` 本就是显示 role（MessageBubble 零改），accumulateStaged 加 role:subagent 分支承接注入消息。

**wait=false（纯 fire-and-forget）**：spawn 立即返回，主 loop 继续，**子结果不回传主**（移除原前端 `[子agent]` 注入）。主不感知子结果。

**看门狗**（`asyncWatchdogs` Map，5min）：spawn wait=true 启动；子完成 clear；超时 → `wakeParent(parent, child, type, "[子agent type] 执行超时")` + `abortChatRuntime(child)`（规则12 fail loud）。超时回调由 service 启动期 `setAsyncWakeHandler` 注入（agent 层不直调 service）。

**持久 chat→ws owner**（[connection.ts](../../src/service/websocket/connection.ts)）：`chatOwnerConnections` Map（bindChatConnection 同步设，releaseChatConnection **不清**，connection.close + chat delete 清）+ `findOwnerWsByChatId`。`role_reply` 推送用它（主 turn 已结束、activeChatConnections 已释放）。

### 5.5 context usage（CP7 已实现简化估算）

- `chat.get` response 增返 `contextUsage`（当前 chat 总 token / brain.contextLimit，0-1）
- `chat.send`/`chat.resume` 完成时 `done` notification 增携 `contextUsage`（每轮 loop 后实时重算推送）
- `brain.list` response 增返每 brain 的 `contextLimit`（CP2 已实现）
- token 用量计算：**简化估算 `Math.ceil(text.length / 4)`**（字符数近似，英文 4 char/token；中文偏保守），累加 chat 所有非 revoked 消息 content+thinking。实现见 [src/utils/token.ts](../../src/utils/token.ts)。后续接 tokenizer（如 js-tiktoken）时替换 `estimateTokens` 实现，调用点不变
- 估算失败兜底 0 + console.warn（规则 12 fail loud：不阻塞 chat.send/get 主流程）

### 5.7 消息级 runtime 记录（每轮配置溯源）

runtime 每轮可换（AgentDialog 发消息时改 brain/senseGroup），chat 级 `metadata.runtime` 只记最后值，无法反映历史每轮配置。故 **user 消息入库时记当时 runtime**（`messages.runtime`），后续 assistant 回复基于该 user 消息数据。

- **仅 user 消息记**：[observer.ts](../../src/service/chat/observer.ts) `message_created` 入库时，`role==="user"` 传 `runtime = getChatSelection(chatId)`（当前 chat runtime，来自 [runtime.ts](../../src/service/chat/runtime.ts) `chatRuntimes`）；assistant/sense 不记（NULL）。
- **chat.get 回放关联**：[handler.ts](../../src/service/chat/handler.ts) `handleChatGet` 维护 `lastUserRuntime`。content_end role=user 带 `runtime`（从 `messages.runtime`）+ 更新 `lastUserRuntime`；role=assistant 带 `runtime = lastUserRuntime`（关联前一条 user，不入库 assistant runtime）。
- **前端 hover 面板**：[MessageBubble.vue](../../web/src/features/agent/MessageBubble.vue) 从 `item.runtime` 取 brain/senseGroup/mcpServers（不再从 pet.runtime 查）。user 不弹面板。
- **subagent 消息**：wait=true 子完成后由后端 `wakeParent` 注入 role:subagent 消息（见 §5.4，非 user 前缀），记注入时主 chat runtime。
- **旧消息无 runtime**（迁移前）：parseMessageRow undefined → hover 显「—」（规则12）。

### 5.8 容错机制（断开恢复 + 重启恢复）

主子 agent 断开/重启恢复容错。2026-07-09 重构后唤醒链 `waitedChildren` 持久化（子 metadata.wait）+ 重连/重启重建，覆盖原「进程崩溃不覆盖」缺口。看门狗兜底未完成子。

#### 5.8.1 唤醒链持久化

- **spawn wait=true**：子 chat metadata 加 `{wait:true, type}`（parent_chat_id 已链）。
- **wakeParent 成功**（含看门狗超时）：清子 metadata `wait`（标记已消费）+ clearWaitedChild + clearWatchdog。
- **子 loop 结束**：已设 metadata.finished（现有）。故持久态可判：`wait=true && finished=false`（interrupted 待续）、`wait=true && finished=true`（完成待补唤）、`wait=false/无`（已消费/非 wait）。

#### 5.8.2 后端启动重建（spawnBroker.rebuildFromDb）

[service/index.ts](../../src/service/index.ts) init 调：扫子 chat metadata.wait=true：
- `finished=true`（子完成、崩溃前未唤）→ `wakeParent` 从 DB 末条 assistant content 补唤主（notification 无连接则丢，回复已落 DB）。
- `finished=false`（interrupted）→ 重建 `waitedChildren` + 重启看门狗（待前端重连续跑子）。

#### 5.8.3 前端重连同调（rework rebuildSpawnWaits）

- **触发**：F5 刷新 `initFromChats` 调；瞬断重连 `App.vue onStatus` 调。
- **逻辑**（[index.ts](../../web/src/stores/agents/index.ts)）：扫描 chat.list（需暴露子 `wait` 标记，ChatSummary 增 `wait?:boolean`）：
  - wait-子 `!finished && canResume` → `chat.resume(child)` 续跑中断 turn → 完成 → child_done → 唤主（后端已重建链）。
  - 主含未处理 subagent-reply（末条 role:subagent 且 idle）→ 由 `chat.list` 的 `canResume` 字段同步到 pet，`PetToolbar` 显「▶ 继续」按钮让用户确认（**不再自动 resume**，避免未确认即执行）。
  - 主 `running && !finished` 但前端无跟踪流 → 判卡死，`abortAgent` 清死锁。
- **废除原逻辑**：`finished && !running` 子补传 `subagentResult`（subagent.result RPC 已废，改后端 rebuildFromDb 补唤）；`spawnWaits` 去 `wait` 字段。

#### 5.8.4 spawn 去重（避免重连后重复创建子 chat）

- [spawn.ts](../../src/agent/sense/spawn.ts)：创建子 chat 前查 `findChatsByParent(parentChatId)`，找未完成（`!finished`）且 **type + spawnPromptHash 都匹配**的子 chat → 复用 childChatId，不创建新行；未命中 → 新建。
- **匹配条件强化**（90ecacf2 案例）：原仅按 `finished` 匹配导致 LLM 一次 fire-and-forget 多任务全部挤到同一未完成子 chat（hash 撞 → `replaceSense` 错误折叠 → 原始 prompt 丢失）。现增加 `type === input.type`（不同角色不能复用）+ `metadata.spawnPromptHash === hashGenerator("prompt", type, prompt)`（不同任务即使 type 相同也不能复用）双匹配，确保子 chat 复用严格化。
- 创建子 chat 时同时写入 `metadata.spawnPromptHash` 字段（与 `metadata.type` 一起作为复用判据）。

#### 5.8.5 字段暴露

- **running**：[handler.ts](../../src/service/chat/handler.ts) `handleChatList` 查 `isChatRunning(chatId)`（[runtime.ts](../../src/service/chat/runtime.ts)，`chatRuntimes.get(chatId)?.builder.isRunning()`）→ `ChatSummary.running`。
- **finished**：解析 `metadata.finished` → `ChatSummary.finished`（ghost 重建用）。
- **wait**：解析子 `metadata.wait` → `ChatSummary.wait`（前端重连识别 wait-子用）。

#### 5.8.6 容错边界

- **覆盖**：WS 瞬断（后端存活，generator 卡内存）；**后端进程重启**（waitedChildren 持久化 + rebuildFromDb 重建 + 前端重连续跑 interrupted 子）；子卡死（看门狗 5min 超时唤主 + abort）。
- **残留限制**：前端永不重连时 wait-子靠看门狗超时兜底唤主（可接受）；多 wait-子并发完成多次注入+多次 resume 串行（isRunning 守卫防双 generator）。

#### 5.8.7 常见 lifecycle 场景答复

四个用户常问的 lifecycle 行为，明确答复如下（与代码行为对齐，2026-07-12 文档化）。

**场景 1：刷新浏览器 / 关闭 WebSocket 是否中断运行中的 agent？**

**答：仅停止接收输出，后端 loop 继续运行。** 设计上 generator 与 WebSocket 解耦（`chatRuntimes` Map 持 generator，`ws.send` 失败静默）。后端 loop 仅在以下情形自动停止：

- `await approvalPromise` 收到 `AgentAbortError`（连接关闭 / `chat.abort` / 审批超时）
- `WATCHDOG_TIMEOUT_MS = 5min`（[spawnBroker.ts:119](../../src/agent/spawnBroker.ts#L119)）触发的 wait=true 子超时
- `defaultApprovalTimeout = 15min`（[connection.ts:41](../../src/service/websocket/connection.ts#L41)）触发的审批超时
- 用户从新连接发起 `chat.abort`（[send.ts:264-276](../../src/service/chat/send.ts#L264-L276)）
- 后端进程退出

纯 LLM stream / sense 执行无自动停止机制。`chat.abort` 或进程杀是确定性结束的唯一手段。**无 stream-rejoin 协议**：重连后只能用 `chat.resume` 续跑（不会接管正在跑的 generator，`isRunning` 检查跳过），或 `chat.get` 看持久化历史。

**场景 2：手动结束主 agent，子 agent 会怎样？**

**答：子继续运行，主对子的唤醒被丢弃。** `handleChatAbort`（[send.ts:264-276](../../src/service/chat/send.ts#L264-L276)）只 `abortChatRuntime(data.chatId)` + `clearWaitedChildrenByParent`，不触达 child runtimes。子直到完成 / 5min 看门狗 / 显式 `chat.abort` / 进程退出 才停。

唤醒链清理后，子完成时 `wakeParent` 仍执行（写入 `role:subagent` 到主 DB），但主 runtime 已清空 → notification 找不到 owner ws → dropped。`role:subagent` 落库等用户下次 `chat.list` 看到，主重建 `ensureChat` 后可见（若用户接着发新消息，`revokeTrailingCycle` 会丢弃未消费的 trailing cycle）。

**场景 3：主在 wait=true 子上挂着，用户手动结束子，能恢复吗？**

**答：能，主拿到 `[角色 X] 执行出错` 注入，可由用户主动 chat.resume 续跑。** 子 `chat.abort` → `compose.abort().throw(AgentAbortError)` → 中间件链抛出 → `observer.ts:115-122` 捕获 → 若 chat 是 waited child → `wakeParent(parent, child, type, "[角色 type] 执行出错: ...")`. 主 next resume 时 loop 决策（[loop.ts:80-89](../../src/agent/middleware/loop.ts#L80-L89)）看到 `lastVisible.role === "role"` → continue，LLM 据新上下文决定下一步。

无需特殊操作：用户从主 chat 重发或调 `chat.resume(parent)` 即可续跑。

**场景 4：主 agent 意外结束后（进程崩溃 / OOM / kill -9），还有 resume 消息能续跑吗？**

**答：有，通过两路径恢复。**

- **路径 A（DB 持久化优先）**：所有 `messages` 行已落库（[messageJournal.ts](../../src/core/middleware/messageJournal.ts) 是 single writer，DB+内存双写）。进程重启后 `chat.get` 拉历史 → 前端渲染。`metadata.finished` / `metadata.wait` / `metadata.type` 标识子 chat 状态。
- **路径 B（唤醒链重建）**：后端 `startService` 调 `rebuildWaitedChildren`（[wake.ts:104-136](../../src/service/chat/wake.ts#L104-L136)）：
  - 子 `finished=true && wait=true`（崩溃前子完成但未唤主）→ 从 DB 末条 assistant content `wakeParent` 补唤
  - 子 `finished=false && wait=true`（interrupted）→ 重建 `waitedChildren` + 5min 看门狗；前端重连 `rebuildSpawnWaits`（[index.ts:211](../../web/src/stores/agents/index.ts#L211)）调 `chat.resume(child)` 续跑

前端 `chat.get` 返回的 `canResume` 字段在末条为 `sense`、`user`、`role` 或旧 `subagent` 时为 true。子完成但前端离线时，`wakeParent` 会写入主 chat 的 `metadata.resumePending=true`；`chat.list` 同时暴露 `resumePending` 与 `canResume`（后者覆盖 resumePending 丢失场景）。前端重连后**不自动** resume 主 chat（避免未确认即执行），改由 `PetToolbar` 的「▶ 继续」按钮（`isMaster && !isWorking && canResume` 时显示）让用户确认触发 `chat.resume(parent)`。父 chat 运行中收到并发角色回复时，loop 用 `roleReplyPending` 在当前 assistant 输出后继续处理。

#### 5.8.8 HistoryDrawer 展示层合并（F 改动，2026-07-12）

> **现行实现说明：** 下方早期的 `mergedChildChatId` / `messages.metadata.childChatId` 透传方案已废弃。展示合并现在完全在前端 [historyMerge.ts](../../web/src/stores/agents/historyMerge.ts) 完成：仅以每个子 chat 的最终 assistant 回复为候选，与正文完全相同且时间不晚于它的主 chat `role` 回传一对一匹配；并列或缺失时保留两条。原始 DB 记录与 staged 协议不携带展示配对字段。主 group 历史递归纳入全部后代，子 direct 历史只显示自身。合并项保留子回复的内容、thinking、runtime 和工具调用，使用回传时间，并显示“子 pet → 实际父 pet”混合头像。

group 视图（主 chat drawer）合流主+子 chat 历史时，「同一回复」会出现两次：主 chat 注入的 `role:subagent` 行（wake.ts 写入主 DB）+ 子 chat 的末条 `assistant→role` 改写行（remapChildHistory）。**两条消息来自不同 DB 表的不同物理 row，msgId 不可能相等，store 层 dedup 物理无效**。

**解决方案**：不在 store dedup，UI 展示层把两条合为一条 HistoryItem（`mergedView='child-to-master'`）。新样式「子发送消息给主」——既不是子自己的 reply，也不是 master→subagent 样式。

**字段约定**（[HistoryItem](../../web/src/stores/agents/types.ts)）：

- `mergedChildChatId?: string` —— 配对 key
  - A 行（主 chat 注入式 `role_reply` handler push）=`notification.data.childChatId`
  - A 行（staged 回放路径）=`staged chunk.data.childChatId`（来自后端 yield，见下文）
  - B 行（`remapChildHistory` 改写）=`childChatId`（与 `subPetChatId` 同值）
- `mergedView?: 'child-to-master'` —— 标记合并产物（仅 HistoryDrawer 写）
- `role` 联合类型不变（合并产物 `role='role'`，复用现有 markdown 路径）

**后端链路（childChatId 透传）**：

主 chat 的 `role:subagent` row 经两条路径触达前端，均需携带 childChatId：

1. **实时推送**（[wake.ts:61-68](../../src/service/chat/wake.ts#L61-L68)）—— `wakeParent` 推 `role_reply` notification 时 `data.childChatId` 携带。
2. **staged 回放**（[handler.ts:172-188](../../src/service/chat/handler.ts#L172-L188)）—— `handleChatGet` 遍历 messages 时，对 `role:subagent`/`role=role` row yield `content_end` staged chunk 带 `childChatId` 字段。

后端持久化：wake.ts 写入主 chat role:subagent row 时把 childChatId 存到 `messages.metadata`（[wake.ts:41](../../src/service/chat/wake.ts#L41) `addMessage(msgId, parentChatId, { role: "role", content, metadata: { childChatId } })`）。messages 表 schema 见 [db/index.ts:152-154](../../src/db/index.ts#L152-L154) `ensureMessageColumn(db, "metadata", "TEXT")` 迁移机制（已有列迁移框架，新增列即生效旧库）。

前端累积：[streamAccumulator.ts:92-98](../../web/src/stores/agents/streamAccumulator.ts#L92-L98) 处理 `content_end role=role/subagent` 时写入 `mergedChildChatId: d.childChatId`。

**合并算法**（[HistoryDrawer.vue:49-57](../../web/src/features/agent/HistoryDrawer.vue#L49-L57)）：

```ts
function mergeChildToMaster(items: HistoryItem[]): HistoryItem[] {
  // 1) 按 mergedChildChatId 分组，区分 A（注入式：无 subPetChatId）与 B（合并式：有 subPetChatId）
  // 2) 每个 group 内 a/b 按 createdAt 升序排序，两两配对（贪心 + Math.min 防多配）
  // 3) 重建数组：跳过 B 被配对的；A 位置替换为合并项
  // 4) 缺一边 → 跳过合并 → 原两条按原样渲染（降级不报错）
}
```

**触发条件**：仅 `layout === 'group'` 启用；direct 视图（子 chat 自身抽屉）保持完整子 chat 历史。

**合并字段来源**：

| 字段 | 来源 | 原因 |
|------|------|------|
| `content` | A | 保留 `[角色 X]` 前缀身份标识 |
| `createdAt` / `runtime` / `senseCalls` | B | 子 chat 实际完成时间 + 触发 sense 记录 |
| `spawnSenseCallId` | A | 指向主 chat 的 spawn sense call，点击头像跳转 |
| `subPetChatId` / `callerSubPetChatId` | B | MessageBubble caller 查询用 |
| `petName` | A | =type，info-panel tooltip 兜底 |

**新样式「子发送消息给主」**（[MessageBubble.vue](../../web/src/features/agent/MessageBubble.vue)）：

- 大头像 = 子 pet face（pet-sub 紫）+ name-initial 右上角 + 左下角 `→` send-direction 角标
- 小徽章 = 主 pet masterText（pet-master 米色）
- bubble 复用 `.role-role` 米色（不增新色避免视觉冗余）
- info-panel name = callerPetName（主 pet name）+ 「↗」前缀 = 「Coder 发送给主 pet」语义
- 仅 layout=group + mergedView 触发（`v-else-if="isMergedChildToMaster && layout === 'group'"` 双条件守卫）

**Edge cases 验证**：

| # | 场景 | 期望 |
|---|------|------|
| 1 | 标准 wait=true spawn | group 视图合并项**只 1 条** |
| 2 | direct 视图 | 完整子 chat 历史，无 mergedView 项 |
| 3 | 子 chat 多轮（内部 user↔assistant 多轮 + 末条） | direct 全 N 条；group 前 N-1 中间 role 行无 A 配对保留 + 1 合并项 = N |
| 4 | A 行缺失（role_reply 失败） | B 行按 role-role 样式正常渲染 |
| 5 | B 行缺失（子 chat 未完成） | A 行按 role-role 样式渲染（徽章走 masterText fallback） |
| 6 | 多级 spawn（A→B→C） | A drawer：A→B 合并；B drawer：B→C 合并（各 drawer 独立链路） |
| 7 | stream.history reset + reload | mergedHistory computed 响应式依赖 items，重载后合并正确 |
| 8 | store msgId dedup 与合并共存 | dedup 丢一边 → groups 一边空 → 跳过合并 → 降级渲染（安全） |
| 9 | content 来源 | 用 A 的 `[角色 coder] xxx` 前缀形式 |
| 10 | senseCalls 来源 | 用 B 的（子 pet 触发的 sense 记录） |

**store 层 msgId dedup 保留为兜底**（[agents/index.ts:493-500](../../web/src/stores/agents/index.ts#L493-L500)）——实际不命中但无害，注释注明 UI 展示层做合并。

**不修改**：后端 wake.ts / observer.ts / messageJournal.ts（契约稳定）；streamAccumulator.ts（direct 路径，不写 mergedChildChatId）；HistoryDrawer.vue:319-335 v-for（`item` 透传 mergedView 字段即可）；MessageBubble 现有 master/role 分支。

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
│       ├── ApprovalCard.vue     # 审批卡片（z=400 单提避浮层覆盖 + ✕关闭入队）
│       ├── PetIcons.vue         # pet 头部右侧 icon slot（history 列 + 审批列闪烁）
│       ├── ContextBar.vue       # 上下文用量 bar
│       └── PetToolbar.vue       # pet 工具栏按钮组
```

### 6.2 状态流

```
stores/agents.ts（单一数据源）
  pets: PetInstance[]          ← chat.list + role_created/destroyed 维护
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
- 气泡：thinking/content 双气泡 + 工作流式（CP2）；审批气泡 z-index 单独提到 400 避开浮层覆盖（CP5 扩展）
- 工具栏：PetToolbar 组件（CP2）
- context bar：ContextBar 组件（CP7）
- 审批卡片：ApprovalCard 组件 + approvalQueue 队列 + PetIcons 闪烁 icon 列（CP5；多审批堆叠自动推进；✕关闭移队列保留可重新唤起）

## 7. 生命周期

```
打开页面
  → main.ts 挂 Pinia
  → App.vue onMounted: connection.init() 建连 + 订阅 onChunk/onNotification
  → 建连成功: agentApi.listChats() → 重建 pet 树（主 chat→主 pet，子 chat 按 parent_chat_id 挂主 pet 附近）
  → FAB 常驻，下方显 connected

FAB 点击 → 选择 preset → agentApi.createAgent({preset})（chat.create）→ 主 pet 出现

点主 pet → AgentDialog → 选模型/工具 + 输入 + 发送 → runtime.set(若改) + chat.send → 主 pet isWorking，气泡流式

主 agent LLM 调 spawn_role
  → 后端 createChat(parent) + role_created notification
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
| **CP3** | spawn_role sense（前端驱动）+ role_created notification + 子 pet 创建/显示 + roles 配置 + subagent.result 回传 | ✅ | 主 agent 派发子任务，子 pet 出现并工作 |
| **CP4** | HistoryDrawer + MessageBubble + SenseCallBox + 群消息样式 | ✅ | 点数字气泡看完整历史 |
| **CP5** | ApprovalCard（interrupt→accept/reject）+ ✕关闭入队 + approvalQueue + PetIcons 闪烁列 + 审批 z-index 提到 400 避开浮层覆盖 | ✅ | bash confirm 审批闭环 + 关闭可重唤起 |
| **CP6** | 中止（chat.abort）+ 隐藏（hide）+ ~~destroy_role sense~~（已移除，子 agent done 改转 ghost，§5.6）+ role_destroyed notification（失去发出方，保留协议项）+ 异步结果注入 | ✅ | 全生命周期闭环 |
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
