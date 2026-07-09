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

| 模式 | stream chunk（带 seq） | staged chunk / notification |
|------|------------------------|------------------------------|
| `binary` | 二进制帧 `0x01` | JSON 帧 `0x02` |
| `json` | JSON 字符串 | JSON 字符串 |

二进制帧（stream chunk）格式：

```
[0x01][seq:4 bytes BE][requestId_len:1 byte][requestId:n bytes][payload_json]
```

JSON 帧格式：

```
[0x02][full_json]
```

**消息结构：**

```typescript
interface Request {
  id: string;              // UUID，关联 Response
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
  seq?: number;            // stream 类型序号
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
  runtime?: { brain: string; senseGroups: string[]; mcpServers: string[] }; // content_end 携带：user=发送时配置，assistant=前一条 user runtime（后端关联）
}

interface Notification {
  kind: "notification";
  type: "interrupt" | "accept" | "rejected" | "consumed" | "loaded" | "done" | "error" | "replaced" | "subagent_created" | "subagent_destroyed";
  requestId: string;
  data: InterruptData | AcceptData | RejectedData | ConsumedData | ReplacedData | SubagentCreatedData | SubagentDestroyedData | null | { message: string };
}
```

### Notification 类型

| type | data | 触发时机 |
|------|------|----------|
| `consumed` | `{count}` | 用户输入入队 |
| `interrupt` | `{approvalId, senseName, arguments, supervisionLevel, needsApproval, waitTime, createdAt}` | sense_end（仅 confirm/manual；auto 不推） |
| `accept` | `{approvalId, senseName, result}` | sense 执行成功 |
| `rejected` | `{approvalId, senseName, reason}` | sense 被拒 / 审批取消 |
| `loaded` | `null` | chat.get 历史发完 |
| `done` | `{contextUsage, finished?}` | chat.send/resume loop 结束。`contextUsage` = 当前 chat 总 token / brain.contextLimit（0-1），前端据实时更新 pet.contextUsage（ContextBar）。CP7。`finished`（boolean，仅子 chat 即 `parent_chat_id` 非空时携带）= 子 agent 已完成，前端据 `finished===true` 把子 pet 转 ghost（灵魂态保留）。done 时后端写 `metadata.finished` 持久化，刷新后 `chat.list` 暴露同字段重建 ghost |
| `error` | `{message}` | error chunk 或 handler 异常 |
| `replaced` | `{id, content, originalContent, by}` | 感官去重命中，历史 sense 结果被新读取替换 |
| `subagent_created` | `{chatId, parentChatId, type, prompt, brain, senseGroups, wait}` | spawn_subagent sense 执行时（主从 Agent 桌宠系统 CP3）。前端收此 notification → 创建子 pet + 调 chat.create/chat.send 跑子 agent（前端驱动架构）。`requestId` = 主 chatId（前端按 chatId 路由） |
| `subagent_destroyed` | `{chatId}` | **已失去发出方**（`destroy_subagent` sense 移除，子 agent done 改转 ghost，见 [agent-pet.md §5.6](./agent-pet.md)）。协议项保留作防御；前端收到应移除对应子 pet。`requestId` = 主 chatId |

> `supervisionLevel` 为数字枚举（0/1/2，见 [core/sense.md](./core/sense.md)「Sense 监管等级」）。`needsApproval = supervisionLevel > 0`。auto sense（`needsApproval:false`）不推 `interrupt`（无审批需求，前端不弹审核卡）；仅 confirm/manual 推送。`waitTime` = `global.approval_timeout`（ms，缺省 0 不超时不显倒计时），`createdAt` = 发起时间戳（ms），前端据此算倒计时：`remaining = waitTime - (now - createdAt)`，归零后端超时 reject → `rejected` notification；用户 accept/reject 后前端立即关闭（不等 `accept`/`rejected` notification 回来）。

### Chunk 类型

| type | data | 说明 |
|------|------|------|
| `stream` | `{thinking?, content?, senseCall?}` | 流式增量（带 seq，二进制帧） |
| `staged` | `{type, role?, thinking?, content?, senseName?, arguments?, id?, messageIds?, replace?, originalContent?, runtime?}` | 阶段完成（JSON 帧） |

`staged.type` 取值：`thinking_end` / `content_end` / `sense_end` / `reverse`。`role`（user/assistant/system/sense）仅 chat.get 返回历史时携带。`id` 用于把 `sense_end` 与 `role:"sense"` 的结果块关联起来。`reverse`（携 `messageIds`）由 `chat.send` 在自动撤回末尾 pending sense 时发送，标记客户端回滚对应消息。`replace/originalContent` 仅 chat.get 历史回放命中感官去重时携带。`runtime` 仅 `content_end` 携带：user 消息=发送时配置（来自 `messages.runtime`），assistant=前一条 user 的 runtime（后端关联，不入库 assistant runtime），供前端 hover 历史消息显该消息用的 brain/工具。

### 方法列表

| 方法 | 说明 | 流式 |
|------|------|------|
| `brain.list` | 列出所有可用 brain（每项含 `default` 标记 = 是否为 `config.default.brain`；senseGroups 为全局全量）+ 当前已连 MCP server 名（`mcpServers`） | 否 |
| `sense.list` | 列出所有可用 sense group（senses 含 `:level` 后缀未解析） | 否 |
| `sense.tools` | 列出全部内置工具（代码维护的 `BUILTIN_SENSE_TOOLS`），每项 `{name, label, description}`：`name`=原名（作 sense_groups 条目 key）、`label`=中文名（UI 显示）、`description`=解释（tooltip）。自定义/外部/MCP 工具不在此列，靠前端组合框自由输入 | 否 |
| `runtime.set` | 原子设置 chat 的 brain + senseGroups + mcpServers（每轮可换） | 否 |
| `chat.create` | 创建聊天（必带 brain + senseGroups，可选 mcpServers，chatId 可选） | 否 |
| `chat.list` | 列出所有聊天（`params.includePreview=true` 时每项增返 `preview`/`turnCount`，供会话列表渲染；省略=lean，供初始化重建 pet 树，避免 N+1） | 否 |
| `chat.get` | 获取聊天详情（流式载入历史，末条未完成周期时返回 canResume；response 增返 `contextUsage` 供前端 ContextBar 渲染，CP7） | 是 |
| `chat.delete` | 删除聊天（目标为主 chat 即无 `parent_chat_id` 时，级联删其所有子 chat + 各自消息 + 清内存 runtime；CP8） | 否 |
| `chat.send` | 发送聊天消息（仅 chatId + prompt；末尾有 pending 时自动撤回并发 staged.reverse） | 是 |
| `chat.resume` | 续接（无 prompt，恢复执行 pending sense 或继续 loop） | 是 |
| `chat.abort` | 中止当前 chat 运行流（清内存运行时 + 释放连接，不删除 DB） | 否 |
| `sense.approval` | 感官审批（accept/reject） | 否 |
| `bash.list` | 列出当前 chat 挂起的 bash 进程 | 否 |
| `bash.kill` | 显式杀死当前 chat 的挂起 bash 进程组 | 否 |
| `mcp.list` | 列出所有 config 声明的 MCP server 及运行期状态 | 否 |
| `mcp.get` | 单个 MCP server 详情（params: `{name}`） | 否 |
| `mcp.connect` | 连接单个 MCP server（已连幂等；params: `{name}`） | 否 |
| `mcp.disconnect` | 断开单个 MCP server（未连幂等；params: `{name}`） | 否 |
| `mcp.reload` | 重载 MCP server（params: `{name?}`，给出→原子重载单个，省略→全量重读 config） | 否 |
| `subagent.result` | 子 agent 结果回传（spawn wait=true 时前端跑完子 agent，调本方法唤醒主 agent 挂起的 spawn sense；params: `{chatId, content}`，返回 `{chatId, matched}`） | 否 |
| `config.get` | 读取 `.chery/config.yaml` 原文（**除 server 段**）：返回 `default`/`subagents`/`llm.brain`/`sense_groups`/`mcp_servers`/`global` 原始结构（`supervision` 为字符串、`key` 仍为 `$ENV` 占位符、无路径补全），供设置面板编辑 | 否 |
| `config.save` | 保存配置（params: 除 server 外全部字段）：zod 结构校验 + 业务校验（`default`/`subagents` 的 brain 引用必须存在于 `llm.brain`、`supervision` 合法值、`sense_groups` 的 `:level` 后缀合法、`llm.brain.*` 的 `model`/`provider` 必填）-> 通过则保留盘上 `server` 段不动、`js-yaml` dump（无注释）写回 -> 返回 `{needRestart:true}`；失败返 `INVALID_PARAMS` 列出错误、**不写盘**。重启后端后生效 | 否 |

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

`chat.create` / `runtime.set` 携带 `mcpServers: string[]`（enabled server 名，与 `senseGroups` 同层级、同原子性）：

```jsonc
// chat.create
{ "brain": "main", "senseGroups": ["default"], "mcpServers": ["filesystem"] }
// runtime.set
{ "chatId": "...", "brain": "main", "senseGroups": ["default"], "mcpServers": ["filesystem", "remote"] }
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
  "senseGroups": [{"name":"all_senses","default":true},{"name":"safe_senses","default":false},{"name":"dangerous_senses","default":false}],
  "default": {
    "brain": "longcat",
    "senseGroups": ["safe_senses"],
    "mcpServers": []
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `wsPort` | number | WebSocket 服务端口 |
| `webPort` | number | Web 静态服务端口（来自 `WEB_PORT` 环境变量） |
| `transport` | string | 传输格式：`binary` / `json` |
| `senseGroups` | `{name, default}[]` | config.sense_groups 全部键名 + `default` 标记（= 是否在 `config.default.senseGroups` 内，供前端 AgentDialog 渲染单选 + 预选默认项）；config 无 sense_groups 时为 `[]` |
| `default` | object \| undefined | 默认主 agent 配置（CP2，FAB 创建主 pet 用）；config.yaml 未配 `default` 段时不返此字段 |
| `default.brain` | string | 默认 brain 名（已通过启动校验：必在 `llm.brain` 列表） |
| `default.senseGroups` | string[] | 默认启用的感官组 |
| `default.mcpServers` | string[] | 默认启用的 MCP server 名（缺省 `[]`） |

> 前端通过 `fetch('/api/config')` 获取配置，结合 `window.location.hostname` 自动构建 `ws://` 连接地址，无需硬编码端口。

### 错误处理

错误响应结构：

```json
{"id":"...","kind":"response","requestId":"...","success":false,"error":{"code":"INTERNAL","message":"..."}}
```

错误码：

| code | 触发场景 |
|------|----------|
| `INTERNAL` | handler 异常 / 跨连接并发同 chat（Chat busy） |
| `TIMEOUT` | 审批超时（15min） |
| `METHOD_NOT_FOUND` | 方法未注册 |
| `NOT_FOUND` | chat / MCP server 等资源不存在 |
| `INVALID_PARAMS` | 参数缺失或非法 |
