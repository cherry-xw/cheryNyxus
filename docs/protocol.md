# WebSocket 协议规范

> [← 返回 README](../README.md) ｜ [交互流程示例](interaction.md) ｜ [数据存储](db.md)

**连接地址：** `ws://localhost:8182`（端口通过 `.chery/config.yaml` 的 `server.port` 配置）

**消息模式：** RPC 模式，四种消息类型：

| 类型 | 方向 | 说明 |
|------|------|------|
| Request | C→S | 请求消息 |
| Response | S→C | 响应消息 |
| Chunk | S→C | 流式增量 |
| Notification | S→C | 服务端推送 |

**传输格式**（由 `.chery/config.yaml` 的 `server.transport` 配置，默认 `binary`）：

| 模式 | stream chunk | staged chunk / notification |
|------|--------------|------------------------------|
| `binary` | 二进制帧 `0x01` | JSON 帧 `0x02` |
| `json` | JSON 字符串 | JSON 字符串 |

二进制帧（stream chunk）格式：

```
[0x01][requestId_len:1 byte][requestId:n bytes][payload_json]
```

旧客户端的 `payload_json` 直接是 stream data；带业务关联的新帧使用
`{data, chatId?, runId?, seq?}`。两种形式均由客户端兼容解码。

JSON 帧格式：

```
[0x02][full_json]
```

**消息结构：**

```typescript
interface Request {
  id: string;              // UUID；24 小时内同 id + method + params 只执行一次
  kind: "request";
  method: string;          // 方法名
  params: unknown;         // 方法参数
}

interface Response {
  id: string;
  kind: "response";
  requestId: string;       // 对应 Request.id
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

interface Chunk {
  kind: "chunk";
  type: "stream" | "staged";
  requestId: string;
  chatId?: string;         // 所属 chat；客户端不得再由 requestId 推断
  runId?: string;          // 本次 chat.send/chat.resume 运行（= 启动该运行的 Request.id）
  seq?: number;            // 可恢复 chat 事件的单调序号
  data: StreamChunkData | StagedChunkData;
}

interface StreamChunkData {
  thinking?: string;       // thinking 增量
  content?: string;        // content 增量
  senseCall?: SenseCallDelta[];
}

interface StagedChunkData {
  type: "thinking_end" | "content_end" | "sense_end" | "reverse";
  role?: "user" | "assistant" | "system" | "sense";  // 消息角色，chat.get 历史返回时使用
  thinking?: string;
  content?: string;
  senseName?: string;
  arguments?: string;
  id?: string;                     // sense 调用 id，用于关联 sense_end 与 sense 结果
  messageIds?: string[];           // reverse 类型：被撤回的消息 id 列表
  replace?: { state: boolean; by: string; content: string }; // 感官去重替换元数据
  originalContent?: string;        // 被替换时的原内容
  runtime?: { brain: string; senseGroup: string; mcpServers: string[] }; // content_end 携带：user=发送时配置，assistant=前一条 user runtime（后端关联）
}

interface Notification {
  kind: "notification";
  type: "interrupt" | "accept" | "rejected" | "consumed" | "loaded" | "done" | "error" | "replaced" | "role_created" | "role_destroyed" | "role_reply" | "sense_started" | "question_requested" | "question_answered" | "question_batch_requested" | "question_batch_completed";
  requestId?: string;      // 仅与某次 RPC 有直接因果关系时携带
  chatId?: string;         // 异步推送（role_created/role_reply 等）以此路由
  runId?: string;          // 运行中事件的稳定关联 id
  seq?: number;            // 可恢复 chat 事件的单调序号
  data: InterruptData | AcceptData | RejectedData | ConsumedData | ReplacedData | RoleCreatedData | RoleDestroyedData | RoleReplyData | SenseStartedData | null | { message: string };
}
```

### Notification 类型

| type | data | 触发时机 |
|------|------|----------|
| `consumed` | `{count}` | 用户输入入队 |
| `interrupt` | `{approvalId, senseName, arguments, supervisionLevel, needsApproval, waitTime, createdAt}` | sense_end（仅 confirm/manual；auto 不推） |
| `sense_started` | `{id, senseName, arguments}` | sense_end（**仅 auto**；confirm/manual 走 interrupt）。auto 工具开始执行信号，前端据 `id` 维护「运行中工具」列表（pet bar 右侧显 icon）；对应 `accept`（`approvalId=id`）到达时移除 |
| `accept` | `{approvalId, senseName, result}` | sense 执行成功（全工具推；`approvalId`=sense 调用 id，前端据此移除「运行中工具」同 id 项） |
| `rejected` | `{approvalId, senseName, reason}` | sense 被拒 / 审批取消 |
| `loaded` | `null` | chat.get 历史发完 |
| `done` | `{contextUsage, contextBreakdown, used?, total?, finished?, finalMessage?}` | chat.send/resume loop 结束。`contextUsage` = 当前 chat 总 token /（brain.contextLimit KB × 256）（0-1），前端据实时更新 pet.contextUsage（ContextBar）。CP7。`contextBreakdown` = 6 段分解 `{system,userSystem,memory,skills,tools,conversation:Segment, total, usage}`（各段 `{tokens,count?}`：系统/用户系统提示词·记忆（条数）·技能（skill 数）·工具定义（tool 数）·用户对话（消息条数，含 sense 调用结果）），前端据更新 pet.contextBreakdown 渲染分段进度条。`used`/`total` = 已用/上限 token。`finished`（boolean，仅子 chat 即 `parent_chat_id` 非空时携带）= 子 agent 已完成，前端据 `finished===true` 把子 pet 转 ghost（灵魂态保留）。done 时后端写 `metadata.finished` 持久化，刷新后 `chat.list` 暴露同字段重建 ghost。`finalMessage`（`{msgId,role:"assistant",content,thinking?,createdAt,agentChatId?}`，仅本轮末条为 assistant 时携带）= 刚完成的权威回复，前端实时追加进 `stream.history`（PetIcons 圆点气泡即时显新内容，不再等 `chat.get` 重载）；`msgId` 供下次 `chat.get` 合流按 msgId 去重；`agentChatId` 标识该消息来源 chatId（默认 = 当前 chatId），供前端反向溯源（filter `agentChatId === X` 取该 agent 完整 history，无需正向溯源） |
| `error` | `{message}` | 仅由 agent generator 在流中抛出 error chunk 时触发（见 [streamMapper.ts](./service/chat.md)），**handler 异常路径不再发 error notification**——失败仅靠 final Response（含 `error` 字段） |
| `replaced` | `{id, content, originalContent, by}` | 感官去重命中，历史 sense 结果被新读取替换 |
| `role_created` | `{taskId, chatId, parentChatId, type, prompt, brain, senseGroup, wait}` | spawn_role sense 执行时。前端收此 notification → 创建子 pet + 调 `chat.startSpawn({taskId})` 原子领取任务；重放不产生第二次初始 prompt。事件外层 `chatId` = `parentChatId`。 |
| `role_destroyed` | `{chatId}` | **已失去发出方**（`destroy_role` sense 移除，子 agent done 改转 ghost，见 [agent-pet.md §5.6](./agent-pet.md)。协议项保留作防御）；外层 `chatId` 为其主 chat。 |
| `role_reply` | `{parentChatId, childChatId, type, content, spawnSenseCallId?, msgId?}` | wait=true 子完成唤主。子 loop 结束后已把子结果以 role:role 注入主 chat DB，前端收此 notification → 自动 `chat.resume(parentChatId)`。`content` 仅即时展示，权威内容在主 chat；事件外层 `chatId` = `parentChatId`。 |
| `question_batch_requested` | `{batchId, assistantMessageId, createdAt, questions:[{questionId,position,question,header?,options,multiSelect,createdAt}]}` | 一个 assistant turn 的完整问题批次。`batchId = assistantMessageId`，服务端在所有 placeholder sense 和批次领域状态持久化完成后才发出；事件按 `batchId` 幂等，可安全重放。前端只保存本地草稿，不逐题回传。 |
| `question_batch_completed` | `{batchId}` | 整批答案已在单个 SQLite 事务中写入 sense 消息并关闭批次。事件进入 chat event log，前端收到或重放时仅清理对应批次；是否启动 `chat.resume` 由 `sense.question.batchAnswer` RPC 的 `shouldResume` 决定，避免重复续跑。 |
| `question_requested` / `question_answered` | 旧逐题结构 | 仅兼容历史事件和旧客户端；新前端不再据此构造问题状态。 |

> `supervisionLevel` 为数字枚举（0/1/2，见 [core/sense.md](./core/sense.md)「Sense 监管等级」）。`needsApproval = supervisionLevel > 0`。auto sense（`needsApproval:false`）不推 `interrupt`（无审批需求，前端不弹审核卡）；仅 confirm/manual 推送。`waitTime` = `global.approval_timeout`（ms，字段约束 `>= 0`：`0` = 不限时，不显倒计时；省略 = `0` 同义），`createdAt` = 发起时间戳（ms），前端据此算倒计时：`remaining = waitTime - (now - createdAt)`，归零后端超时 reject → `rejected` notification；用户 accept/reject 后前端立即关闭（不等 `accept`/`rejected` notification 回来）。`approval_timeout` 的范围校验在 [config.ts §validateRawConfig](./utils/config.md) 与 [schemas.ts §globalSchema](./service/message.md) 双层执行。

### Chunk 类型

| type | data | 说明 |
|------|------|------|
| `stream` | `{thinking?, content?, senseCall?}` | 流式增量（二进制帧） |
| `staged` | `{type, role?, thinking?, content?, senseName?, arguments?, id?, messageIds?, replace?, originalContent?, runtime?, agentChatId?}` | 阶段完成（JSON 帧） |

`staged.type` 取值：`thinking_end` / `content_end` / `sense_end` / `reverse`。`role`（user/assistant/system/sense）仅 chat.get 返回历史时携带。`id` 用于把 `sense_end` 与 `role:"sense"` 的结果块关联起来。`reverse`（携 `messageIds`）由 `chat.send` 在自动撤回末尾 pending sense 时发送，标记客户端回滚对应消息。`replace/originalContent` 仅 chat.get 历史回放命中感官去重时携带。`runtime` 仅 `content_end` 携带：user 消息=发送时配置（来自 `messages.runtime`），assistant=前一条 user 的 runtime（后端关联，不入库 assistant runtime），供前端 hover 历史消息显该消息用的 brain/工具。`agentChatId` 仅 chat.get 历史回放携带（= 当前回放的 chatId），供前端 HistoryItem 反向溯源（filter `agentChatId === X` 取该 agent 完整 history）。

### 流协议终态语义

单一权威终态 = **final Response**（RPC 协议层）：
- 成功路径：streaming chunks/staged chunks → `done` notification（业务终态，含 `contextUsage`+`finished?`）→ **final Response** (`success:true`)。
- 异常路径：streaming chunks/staged chunks → **final Response** (`success:false`, `error:{code,message}`)；**不再双发 `error` notification**。前端 UI 据 final Response 触发终态，`error` notification 仅由 agent generator 在流中产生 error chunk 时触发。

`done` 与 `error` 是业务事件，最终 RPC 成功与否仍由 final Response 判定；客户端必须以 `chatId/runId` 路由事件、以 final Response 判断请求成功。

### 方法列表

| 方法 | 说明 | 流式 |
|------|------|------|
| `brain.list` | 列出所有可用 brain（含 `capabilities`：Tool Call、三类媒体输入/生成；每项 `default` 标记 = 是否为「默认」预设 `leader` 角色用的 brain；`senseGroups` 支持 `string \| string[]`——前者单组，后者为历史多组兼容）+ 当前已连 MCP server 名（`mcpServers`） | 否 |
| `sense.list` | 列出所有可用 sense group（senses 含 `:level` 后缀未解析） | 否 |
| `sense.tools` | 列出全部内置工具（代码维护的 `BUILTIN_SENSE_TOOLS`），每项 `{name, label, description, icon}`：`name`=原名（作 sense_groups 条目 key）、`label`=中文名（UI 显示）、`description`=解释（tooltip）、`icon`=glyph/emoji 字符串（pet bar 运行中工具图标用，非内置工具前端 fallback ⚙）。自定义/外部/MCP 工具不在此列，靠前端组合框自由输入 | 否 |
| `skills.list` | 实时列出 `.chery/skills/` 中的用户技能元数据，返回 `{skills:[{name,description,trigger?,contextTokens}]}`；`contextTokens` 是加载完整技能指令的近似 token 增量（`ceil(字符数/4)`），供发送窗口 `/` 菜单的 hover 卡片展示。内置 `/compact` 不在此列表、不对应配置目录文件。 | 否 |
| `prompts.list` | 递归列出 `.chery/prompts/` 下全部 `.md`（含子文件夹），每项为相对 `.chery/` 的路径（如 `prompts/prefebMain/leader.md`）。供设置面板 `systemPrompt` 级联选择器（`el-cascader`）建目录树；叶 `value`=全路径=存储值。目录为空返 `[]` | 否 |
| `runtime.set` | 原子设置 chat 的 brain + senseGroup + mcpServers（每轮可换）。`toolCall:false` 的 brain 只接受空工具组/MCP；preset chat 下仅 `brain` 生效（编制锁定，senseGroup/mcp 强制取创建快照；显式带不同值 fail loud） | 否 |
| `chat.create` | 创建聊天。可选 `preset`：从 `config.presets[preset].leader` 解析 brain+senseGroup+mcp+systemPrompt（编制快照入 metadata，运行后锁定）。主 pet 恒带 `preset`（旧 `config.default` 已并入「默认」预设）；显式 brain+senseGroup 路径仅子 agent 用 | 否 |
| `chat.list` | 列出所有聊天（`params.includePreview=true` 时每项增返 `preview`/`turnCount`，供会话列表渲染；省略=lean，供初始化重建 pet 树，避免 N+1） | 否 |
| `chat.get` | 获取聊天详情（流式载入历史）。response 包含 `canResume`、上下文用量及 `{snapshotSeq,pendingQuestionBatches}` 问题权威快照；旧会话首次读取时按 assistant message 自动回填批次。 | 是 |
| `chat.delete` | 删除聊天（目标为主 chat 即无 `parent_chat_id` 时，级联删其所有子 chat + 各自消息 + 清内存 runtime；CP8） | 否 |
| `chat.send` | 发送聊天消息（`{chatId, prompt, attachments?}`）。Response.data 必含 `{chatId,runId}`；运行中再次发送仅入队并返 `{queued:true,runId:<活跃运行>}`，不会新建空流。 | 是 |
| `chat.resume` | 续接（无 prompt，恢复执行 pending sense 或继续 loop）。Response.data `{chatId,runId}`；已有运行时返 `alreadyRunning:true`。 | 是 |
| `chat.sync` | 补发 `afterSeq` 之后的持久 chat 事件。返回 `{chatId,latestSeq,minSeq?,reset,snapshotSeq,pendingQuestionBatches}`；前端在事件重放后以问题快照 replace 本地批次，再从 `snapshotSeq` 补放并发到达的新事件。`reset:true` 时另拉 `chat.get` 消息快照。 | 是 |
| `chat.startSpawn` | 原子启动 `role_created` 携带的 `{taskId}`。同一 task 只会写入一次初始 user prompt；重放时会附着现有运行或恢复中断任务。 | 是 |
| `chat.abort` | 中止当前 chat 运行流；可选 `{runId}` 做条件中止。若目标与活跃运行不同，返回 `CONFLICT`，避免旧客户端误中止新一轮。 | 否 |
| `sense.approval` | 感官审批（accept/reject） | 否 |
| `sense.question.batchAnswer` | 原子回答完整批次。params `{chatId,batchId,answers:[{questionId,selectedLabels,freeText?,cancelled?}]}`，必须恰好覆盖批次中所有 pending 项；服务端校验单/多选和合法 label，在同一事务中写入全部 sense 答案并关闭批次。返回 `{chatId,batchId,completed,shouldResume}`。 | 否 |
| `sense.question.answer` | 旧单题兼容接口；仅允许单题批次，多题批次会拒绝并要求使用 `sense.question.batchAnswer`。 | 否 |
| `bash.list` | 列出当前 chat 挂起的 bash 进程 | 否 |
| `bash.kill` | 显式杀死当前 chat 的挂起 bash 进程组 | 否 |
| `mcp.list` | 列出所有 config 声明的 MCP server 及运行期状态 | 否 |
| `mcp.get` | 单个 MCP server 详情（params: `{name}`） | 否 |
| `mcp.connect` | 连接单个 MCP server（已连幂等；params: `{name}`） | 否 |
| `mcp.disconnect` | 断开单个 MCP server（未连幂等；params: `{name}`） | 否 |
| `mcp.reload` | 重载 MCP server（params: `{name?}`，给出→原子重载单个，省略→全量重读 config） | 否 |
| ~~`subagent.result`~~ | **2026-07-09 废弃**：wait=true 重构为 yield turn + 后端注入唤醒（[agent-pet.md §5.4](./agent-pet.md) B1），结果不再由前端 RPC 回传。handler + schema 删 | — |
| `config.get` | 读取 `.chery/config.yaml` 原文（**除 server 段**）：返回 `roles`/`presets`/`llm.brain`/`sense_groups`/`mcp_servers`/`global` 原始结构（`supervision` 为字符串、`key` 仍为 `$ENV` 占位符、无路径补全），供设置面板编辑 | 否 |
| `config.save` | 保存配置（params: 除 server 外全部字段）：zod 结构校验 + 业务校验（`roles.<name>.brain` 引用必须存在于 `llm.brain`、`presets.*.roles[*]` 引用的 type 必须存在于 `config.roles`、`supervision` 合法值、`sense_groups` 的 `:level` 后缀合法、`llm.brain.*` 的 `model`/`provider` 必填、`systemPrompt` existsSync）-> 通过则保留盘上 `server` 段不动、`js-yaml` dump（无注释）写回 -> 返回 `{needRestart:true}`；失败返 `INVALID_PARAMS`、**不写盘**（结构校验失败：message 一行中文 + `tracingId`，完整 Zod issues 走 logger；业务校验失败：列出中文错误）。重启后端后生效 | 否 |
| `utils.models` | 独立工具：基于用户提供的 `{provider, url, key?}` 拉取可用模型列表。`provider` 支持 `openai`/`ollama`；`url` 必填（API base URL）；`key` 可选（ollama 通常无需）。返回 `{models: [{id, name?, ownedBy?}], error?}`；请求失败时 `models` 为空数组、`error` 携带错误信息（非 RpcError，前端可展示）。后续该模块会扩展其他便捷信息查询工具 | 否 |
| `utils.openFile` | 打开指定文件（用配置的文本编辑器或系统默认）。`path` 相对 `CHERY_DIR`（如 `.env`、`.chery/config.yaml`）。优先使用 `global.textEditor` 配置的编辑器（支持 `$ENV` 占位符），未配置则由后端进程调用系统默认打开器（Windows: `cmd /c start`，macOS: `open`，Linux: `xdg-open`）。成功返回空对象，失败返 RpcError | 否 |
| `utils.openConfigDir` | 在**后端所在主机**的系统文件管理器中打开配置目录。params 必须为严格空对象 `{}`；目标固定为 `join(getCheryDir(), ".chery")`，客户端不能传路径。远程浏览器调用时不会打开浏览器客户端机器的目录。成功返回空对象，失败返 RpcError | 否 |
| `utils.editors` | 检测后端主机可用的文本编辑器，返回 `{editors: [{name, command, available}]}`，供设置页选择 `global.textEditor` | 否 |

#### `chat.list` 响应字段

每项 `ChatSummary`：

| 字段 | 类型 | 说明 |
|------|------|------|
| `chatId` | string | chat id |
| `createdAt` / `updatedAt` | number | 创建 / 最后运行时间戳（ms） |
| `messageCount` | number | 消息总数（冗余列，免 N+1） |
| `parentChatId` | string \| null | 子 chat 关联主 chat；主 chat 为 null |
| `preview` | string \| undefined | 仅 `includePreview=true` 返。首条 user 消息截断（≤40 字符），供会话列表辨识。"指令"跳过规则待定（默认 `isDirective=false`，取首条 user 消息） |
| `turnCount` | number \| undefined | 仅 `includePreview=true` 返。user 角色消息数 = 会话轮次 |
| `contextUsage` / `contextUsed` / `contextTotal` / `contextBreakdown` | number / [ContextBreakdown](../src/utils/token.ts) \| undefined | 仅 `includePreview=true` 返。上下文用量比例（0-1）/ 已用 token / 上限 token / 6 段分解（系统·用户系统提示词·记忆·技能·工具定义·用户对话，各段 `{tokens,count?}`） |
| `finished` | boolean \| undefined | 子 chat done 后置 true（`metadata.finished` 解析）。前端据 `finished===true` 把子 pet 重建为 ghost（灵魂态）。主 chat 恒无此字段 |

> `includePreview` 按 `messages_month` 分组批量查每 chat 首条 user 消息 + 计数，避免逐 chat N+1。lean 模式（省略）不查 messages，仅供 `initFromChats` 重建 pet 树。


### MCP 管理 API

MCP 分**连接层**与**挂载层**，二者解耦：

- **连接层**（global registry）：哪些 MCP server 连着、其 sense 已注册进全局 senseRegistry。经 `mcp.*` RPC 热重载，**不重启服务**。
- **挂载层**（per-chat schema）：chat 启用哪些**已连** server → 其全部 `mcp__<server>__*` tools 合并进该 chat 的 LLM schema。经 `chat.create` / `runtime.set` 的 `mcpServers` 字段设置，**不走 sense_groups**。

> **关键边界：连接 ≠ 对 chat 可见。** `mcp.connect` 只把 server 接入 registry；chat 必须经 `mcpServers` 显式启用，其 tools 才进 schema。反之 `mcp.disconnect` 后，已启用该 server 的 chat 下次 resolve 时会 fail loud（NOT_FOUND）。

#### 连接层（mcp.\*）

| 方法 | params | 返回 | 语义 |
|------|--------|------|------|
| `mcp.list` | `{}` | `{servers: McpServerInfo[]}` | 列出 config 所有 server + 状态（connected/disconnected/failed） |
| `mcp.get` | `{name}` | `{server: McpServerInfo}` | 单个详情；config 无名 → `NOT_FOUND` |
| `mcp.connect` | `{name}` | `{server: McpServerInfo}` | 已连幂等；config 无名 → `NOT_FOUND` |
| `mcp.disconnect` | `{name}` | `{server: McpServerInfo}` | 未连幂等；反注册其 sense + close client |
| `mcp.reload` | `{name?}` | `{servers, connected, failed, totalSenses}` | 给出 name → 原子重载单个；省略 → 重读 config 全量重载 |

`McpServerInfo`：

```typescript
{
  name: string;
  status: "connected" | "disconnected" | "failed";
  transport: "stdio" | "streamable-http";
  supervision?: number;      // server 级默认监管（0/1/2）
  senseNames: string[];      // 该 server 注册的 sense 名（仅 connected 非空）
  error?: string;            // status==="failed" 时的原因
}
```

**原子 reload**：单个 server 重载按「建新连接 → 同步 register 新 + unregister 旧差集 → close 旧」交换，注册表任意时刻对同名 sense 有效，无缺失窗口；建新失败则旧态保留。全量 reload 逐 server 容忍，单个失败计入 `failed` 不中断其他。

**幂等**：`connect` 对已连 server 为 no-op；`disconnect` 对未连 server 为 no-op（config 有名即成功，无名 `NOT_FOUND`）。reload 期间在途 `callTool` 接受降级（executor try/catch → 错误 content），同 SIGINT。

#### 挂载层（mcpServers）

`chat.create` / `runtime.set` 携带 `mcpServers: string[]`（enabled server 名，与 `senseGroup` 同层级、同原子性）：

```jsonc
// chat.create
{ "brain": "main", "senseGroup": "default", "mcpServers": ["filesystem"] }
// runtime.set
{ "chatId": "...", "brain": "main", "senseGroup": "default", "mcpServers": ["filesystem", "remote"] }
```

- enabled server 的**全部** `mcp__<server>__*` sense 合并进 LLM schema，监管用 sense 自带的 server 级 `supervision`（无 `:level` 覆盖，因绕过 sense_groups）。
- `mcpServers` 缺省 `[]`（关闭所有 MCP）；响应回显生效值（`brain.list` 的 `mcpServers` 返回当前已连 server 供前端渲染开关）。
- 持久化于 `metadata.runtime`，服务重启 `ensureChat` 自动恢复；旧 chat（无此字段）视为 `[]`，行为不变。
- enable 一个未连 server → `chat.create`/`runtime.set` 抛 `MCP server "X" not connected`（fail loud，NOT_FOUND 语义）。

详见 [core/mcp.md](./core/mcp.md)。

### HTTP API

Web 静态服务（端口由环境变量 `WEB_PORT` 指定，默认 `8183`；原 `config.server.web_port` 已废弃；实现见 [service/http.md](./service/http.md)）除托管前端文件外，提供以下 HTTP 端点：

#### `GET /api/config`

返回可公开的服务配置，供前端自动构建 WebSocket 连接地址。

**响应示例：**

```json
{
  "wsPort": 8182,
  "webPort": 8183,
  "transport": "binary",
  "senseGroups": [{"name":"leader","default":true},{"name":"plan","default":false}],
  "presets": [{"name":"默认","leader":"coordinator_ali","brain":"ali_glm5","roles":["coordinator_ali","read_code","read_image","plan"]}],
  "default": {
    "brain": "ali_glm5",
    "senseGroup": "leader",
    "mcpServers": []
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `wsPort` | number | WebSocket 服务端口 |
| `webPort` | number | Web 静态服务端口（来自 `WEB_PORT` 环境变量） |
| `transport` | string | 传输格式：`binary` / `json` |
| `senseGroups` | `{name, default}[]` | config.sense_groups 全部键名 + `default` 标记（= 是否在「默认」预设 `leader` 角色的 `senseGroup` 内，供前端 AgentDialog 渲染单选 + 预选默认项）；config 无 sense_groups 时为 `[]` |
| `presets` | `{name, leader, brain, roles:string[]}[]` | 全部预设（FAB 预设选择器用）；`leader` = 组长角色 type 名，`brain` = 该角色使用的 brain，`roles` = 该预设引用的角色 type 名列表 |
| `default` | object \| undefined | 派生自「默认」预设 `leader` 角色（brain+senseGroup+mcpServers）；AgentDialog 无 runtime 时预选用。无「默认」预设时不返此字段 |

> 前端通过 `fetch('/api/config')` 获取配置，结合 `window.location.hostname` 自动构建 `ws://` 连接地址，无需硬编码端口。

### 错误处理

错误响应结构：

```json
{"id":"...","kind":"response","requestId":"...","success":false,"error":{"code":"INTERNAL","message":"..."}}
```

错误码：

| code | 触发场景 |
|------|----------|
| `INTERNAL` | 未分类 handler 异常 |
| `CONFLICT` | chat busy / 条件 abort 的 runId 与活跃运行不一致 |
| `TIMEOUT` | 审批超时（以 `interrupt.data.waitTime` 为准，`0` = 不限时） |
| `METHOD_NOT_FOUND` | 方法未注册 |
| `NOT_FOUND` | chat / MCP server 等资源不存在 |
| `INVALID_PARAMS` | 参数缺失或非法 |
