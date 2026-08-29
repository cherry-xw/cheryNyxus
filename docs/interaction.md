# 交互流程示例

> [← 返回 README](../README.md) ｜ [协议规范](protocol.md)

> 本文的旧流式交互示例用于兼容期排查。V2 的目标流程和本轮已落地的 root timeline 行为，以
> [multi-agent-canonical-timeline.md](multi-agent-canonical-timeline.md) 为准。

各方法的完整交互序列（C→S / S→C 实际消息流）。协议规范（传输格式、消息结构、字段定义、错误码）见 [protocol.md](protocol.md)。

> 方向标记：`→` C→S，`←` S→C。stream chunk 为二进制帧，其余为 JSON 帧。

---

## 非流式方法（单次请求-响应）

### brain.list

```json
→ {"id":"r1","kind":"request","method":"brain.list","params":{}}
← {"id":"a1","kind":"response","requestId":"r1","success":true,
   "data":{"brains":[{"name":"longcat","provider":"ollama","model":"gemma3:1b","thinking":true,"default":true,"senseGroups":["safe","danger"]}],"mcpServers":["filesystem"]}}
```

> `senseGroups` 返回全局全量分组，每个 brain 相同。`default` 标记是否为「默认」预设 leader 角色使用的 brain。

### sense.list

```json
→ {"id":"r2","kind":"request","method":"sense.list","params":{}}
← {"id":"a2","kind":"response","requestId":"r2","success":true,
   "data":{"senseGroups":[{"name":"safe","senses":["read_file","execute_command:auto","write_file:smart"]}]}}
```

> `senses` 为原始字符串数组，含 `:level` 后缀，未解析。

### sense.tools

```json
-> {"id":"r3","kind":"request","method":"sense.tools","params":{}}
<- {"id":"a3","kind":"response","requestId":"r3","success":true,
   "data":{"tools":[
     {"name":"execute_command","label":"执行命令","description":"执行 shell 命令，可跑任意终端指令（危险）"},
     {"name":"read_file","label":"读取文件","description":"读文件内容，自动截断长文件与日志"}
   ]}}
```

> 列出代码维护的全部内置工具（`BUILTIN_SENSE_TOOLS`）。`name` 作 sense_groups 条目 key，`label` 供 UI 显示，`description` 作解释。自定义/外部/MCP 工具不在内，前端组合框允许自由输入。设置面板「感官分组」tab 打开时调用，填充工具下拉建议。

### sense.tools.docs

```json
-> {"id":"r4","kind":"request","method":"sense.tools.docs","params":{}}
<- {"id":"a4","kind":"response","requestId":"r4","success":true,
   "data":{"docs":[
     {"name":"execute_command","doc":"【作用】在 shell 中执行命令（bash / powershell）……"},
     {"name":"read_file","doc":"【作用】读取文件内容……"}
   ]}}
```

> 统一获取内置工具完整说明文档。params `{tools?: string[]}`：省略/空 = 全量返回（前端一次拉取缓存、按需展示）；提供 `tools` = 后端按 name 列表一次性返回对应说明（未知 name 自动忽略）。每项 `{name, doc}`，`doc` 按【作用】【能力】【边界】【注意】分节、换行分隔，统一定义于 `BUILTIN_SENSE_TOOLS.doc`；`sense.tools` 不携带 doc，避免下拉响应臃肿。设置面板「器官」tab 打开时调用一次并缓存，hover tag 时按需展示，无需每次重新提取。

### runtime.set

```json
→ {"id":"r3","kind":"request","method":"runtime.set",
   "params":{"chatId":"c1","brain":"longcat","senseGroup":"safe","mcpServers":["filesystem"]}}
← {"id":"a3","kind":"response","requestId":"r3","success":true,
   "data":{"chatId":"c1","brain":"longcat","senseGroup":"safe","mcpServers":["filesystem"]}}
```

> 前置：chat 必须已存在。每轮可换 brain + senseGroup + mcpServers。`mcpServers` 缺省为空数组。

### chat.create

```json
→ {"id":"r4","kind":"request","method":"chat.create",
   "params":{"chatId":"c1","brain":"longcat","senseGroup":"safe","mcpServers":["filesystem"]}}
← {"id":"a4","kind":"response","requestId":"r4","success":true,
   "data":{"chatId":"c1","brain":"longcat","senseGroup":"safe","mcpServers":["filesystem"]}}
```

> `chatId` 可选（不传服务端生成 UUID）。必带 brain + senseGroup，可选 mcpServers。创建时一次性加载历史到内存，并把 runtime selection 持久化到 chat metadata。

### chat.list

```json
// 当前舞台（启动用，不查 messages preview；每个当前 preset 只取最新根及后代）
→ {"id":"r5","kind":"request","method":"chat.list","params":{"scope":"stage"}}
← {"id":"a5","kind":"response","requestId":"r5","success":true,
   "data":{"chats":[{"chatId":"c1","createdAt":1718150400000,"updatedAt":1718151000000,"messageCount":12,"parentChatId":null}]}}

// includePreview（会话列表用，按 messages_month 分组批量查首条 user 消息 + 计数）
→ {"id":"r5b","kind":"request","method":"chat.list","params":{"scope":"history","includePreview":true}}
← {"id":"a5b","kind":"response","requestId":"r5b","success":true,
   "data":{"chats":[{"chatId":"c1","createdAt":1718150400000,"updatedAt":1718151000000,"messageCount":12,"parentChatId":null,"preview":"读一下 a.txt","turnCount":3,"pendingApproval":null}]}}
```

> `includePreview=true` 时每项增返 `preview`（首条 user 消息截断 ≤40 字符）+ `turnCount`（user 消息数）。"指令"跳过规则待定，默认取首条 user 消息。lean 模式省略该二字段，免 N+1。
> 历史目录中的 runtime 只用于展示，不进行有效性校验，也不返回任何运行时有效性字段。
> 每项恒带 `pendingApproval`（与 `includePreview` 无关，源自 approvalManager 内存索引，非 messages 查询）：非 null = 该 chat 有 in-flight sense 审批待用户 accept/reject，形如 `{ senseName, waitTime, createdAt }`——`waitTime` = 审批窗口 ms（= `global.approval_timeout`，0 = 不限时），`createdAt` = interrupt 触发时间戳（ms），前端倒计时 = `waitTime - (now - createdAt)`；null = 无挂起审批。供会话列表「琴键」闪烁提示（含未 hydration 的 chat）。与 `chat.get`/`chat.sync` 的 `currentState.pendingApproval`（computeCurrentState 扫事件重建）一致——同为 approval 生命周期。**非请求参数**（响应未做 schema 校验）。

### chat.delete

```json
→ {"id":"r6","kind":"request","method":"chat.delete","params":{"chatId":"c1"}}
← {"id":"a6","kind":"response","requestId":"r6","success":true,"data":{"chatId":"c1","deletedChatIds":["child-c1","c1"]}}
```

`deletedChatIds` 是服务端实际删除的权威集合，包含目标会话及级联删除的全部后代；前端据此原子清理目录、时间线缓存、订阅和 UI 引用。

> 目标为主 chat（无 `parent_chat_id`）时级联删其所有子 chat + 各自消息 + 清内存 runtime（`clearChatRuntime`），避免孤儿子 chat。子 chat 自身删除不级联。
> 若该主 chat 属分支链路（`conversation_branches.task_id` 关联，含分支根 `parent_chat_id=NULL` 的 continuation/detail 会话），则同 task 下**所有分支根**连同各自子 chat 一并级联删除——否则分支根脱离会话列表（`isPianoRootSession` 排除）却残留内容，重开工作台被自动选中造成「列表为空但内容仍在」。`deletedChatIds` 为整条链路（分支根 + 各自身后代）的权威集合。从未分支的普通根不受影响。

### chat.timeline.generation.get — 按需拉取已打包代际

用户点击节点树打包节点 / 历史抽屉代际卡片时调用；前端 LRU 缓存，关闭二层即释放。

```json
// 成功（generationIndex 1-based，指向 RootTimelineSnapshot.generations[].index）
→ {"id":"rg1","kind":"request","method":"chat.timeline.generation.get",
   "params":{"rootChatId":"c1","generationIndex":2}}
← {"id":"ag1","kind":"response","requestId":"rg1","success":true,
   "data":{"rootChatId":"c1",
     "generation":{"index":2,"boundaryMessageId":"m-compact-2","boundaryNodeId":"m-compact-2",
       "boundaryOrderKey":42,"fromOrderKey":17,"summary":"第二段会话摘要…","nodeCount":25,
       "createdAt":1718151000000,"trigger":"auto"},
     "nodes":[{"id":"m-18","orderKey":18,"kind":"message", ...}],
     "edges":[{"id":"edge:sequence:m-18:m-19", ...}]}}

// 代际不存在
→ {"id":"rg2","kind":"request","method":"chat.timeline.generation.get",
   "params":{"rootChatId":"c1","generationIndex":9}}
← {"id":"ag2","kind":"response","requestId":"rg2","success":false,"error":{"code":-32602,"message":"代际 9 不存在"}}
```

> 直接按 `orderKey` 区间 `(fromOrderKey, boundaryOrderKey]` 读持久 `execution_nodes/execution_edges`，不重跑 projector、不触发回填；edges 两端节点均在区间内。响应体量有界（单代 ≈ 一个上下文窗口节点量）。配套：`chat.timeline.get` root 路径 `knownRevision >= revision` → `{"chatId","revision","unchanged":true}` 短路；`chat.open` root 路径 `knownTimelineRevision >= revision` → 省略 `rootTimeline` + `"timelineUnchanged":true`。

### sense.approval

```json
// accept
→ {"id":"r7","kind":"request","method":"sense.approval","params":{"approvalId":"call_abc","action":"accept"}}
← {"id":"a7","kind":"response","requestId":"r7","success":true,"data":{"approvalId":"call_abc","action":"accept"}}

// reject（含理由）
→ {"id":"r7","kind":"request","method":"sense.approval","params":{"approvalId":"call_abc","action":"reject","reason":"危险操作"}}
← {"id":"a7","kind":"response","requestId":"r7","success":true,"data":{"approvalId":"call_abc","action":"reject"}}
```

> `approvalId` = sense_end 的 id。confirm 后触发 approvalPromise resolve，senseMiddleware 继续。

### utils.models

```json
// 成功（openai）
→ {"id":"ru1","kind":"request","method":"utils.models","params":{"provider":"openai","url":"https://api.openai.com/v1","key":"sk-..."}}
← {"id":"au1","kind":"response","requestId":"ru1","success":true,"data":{"models":[{"id":"gpt-4o","name":"gpt-4o","ownedBy":"system"},{"id":"gpt-4o-mini","name":"gpt-4o-mini","ownedBy":"system"}]}}

// 成功（ollama）
→ {"id":"ru2","kind":"request","method":"utils.models","params":{"provider":"ollama","url":"http://localhost:11434"}}
← {"id":"au2","kind":"response","requestId":"ru2","success":true,"data":{"models":[{"id":"llama3","name":"llama3"},{"id":"qwen2:7b","name":"qwen2:7b"}]}}

// 失败（url/key 无效、provider 不支持等）— models 空数组 + error 字段，非 RpcError
→ {"id":"ru3","kind":"request","method":"utils.models","params":{"provider":"openai","url":"https://invalid.example.com/v1","key":"bad"}}
← {"id":"au3","kind":"response","requestId":"ru3","success":true,"data":{"models":[],"error":"connect ECONNREFUSED"}}

// 失败（openai 缺 key 或占位符未替换）— 中文友好提示，前端 BrainCard 刷新按钮展示
→ {"id":"ru4","kind":"request","method":"utils.models","params":{"provider":"openai","url":"https://api.openai.com/v1","key":"$OPENAI_API_KEY"}}
← {"id":"au4","kind":"response","requestId":"ru4","success":true,"data":{"models":[],"error":"密钥占位符 $OPENAI_API_KEY 未替换，请先在 .env 或环境变量里配置"}}

// 成功（anthropic）- 原生 fetch GET {base}/models，header x-api-key + anthropic-version
-> {"id":"ru5","kind":"request","method":"utils.models","params":{"provider":"anthropic","url":"https://api.anthropic.com/v1","key":"sk-ant-..."}}
← {"id":"au5","kind":"response","requestId":"ru5","success":true,"data":{"models":[{"id":"claude-sonnet-4-5","name":"Claude Sonnet 4.5"},{"id":"claude-opus-4-5","name":"Claude Opus 4.5"}]}}

// 提示（openai，SDK 对伪 200 不抛错→空列表被识别为异常并提示补版本段；真返回 {"data":[]} 的网关同样收到此提示，属可接受歧义）
→ {"id":"ru9","kind":"request","method":"utils.models","params":{"provider":"openai","url":"https://gw.example.com","key":"sk-..."}}
→ {"id":"au9","kind":"response","requestId":"ru9","success":true,"data":{"models":[],"error":"未获取到任何模型：若地址缺少版本段（如 /v1），请在地址末尾补上后重试；也可直接手填模型名"}}

// 成功（anthropic，双尝试回退命中）：主尝试 Anthropic 原生 /models?limit=1000 失败（如网关只认 Bearer 或未实现该路径），
// 且未勾选 fullUrl → 自动回退 OpenAI 兼容 GET {base}/models（仅 Authorization: Bearer），返回非空列表
→ {"id":"ru7","kind":"request","method":"utils.models","params":{"provider":"anthropic","url":"https://api.minimaxi.com/v1","key":"$MINIMAX_KEY"}}
→ {"id":"au7","kind":"response","requestId":"ru7","success":true,"data":{"models":[{"id":"MiniMax-M2.7","name":"MiniMax-M2.7"}]}}

// 失败（anthropic，双尝试均无产出）：error 聚合主尝试与回退两段失败原因（各自带 status/片段）
→ {"id":"ru8","kind":"request","method":"utils.models","params":{"provider":"anthropic","url":"https://gw.example.com/v1","key":"sk-..."}}
→ {"id":"au8","kind":"response","requestId":"ru8","success":true,"data":{"models":[],"error":"Anthropic 接口返回 404：not found；OpenAI 兼容回退（GET /models + Bearer）亦失败：upstream 401"}}

// 成功（openai，勾选「完整 URL」fullUrl=true → 不补全，baseURL 直接用用户地址，须含版本段）
→ {"id":"ru6","kind":"request","method":"utils.models","params":{"provider":"openai","url":"https://api.openai.com/v1","key":"sk-...","fullUrl":true}}
← {"id":"au6","kind":"response","requestId":"ru6","success":true,"data":{"models":[{"id":"gpt-4o","name":"gpt-4o","ownedBy":"system"}]}}
```

> 独立工具方法，不依赖 chat/brain 运行时。后续该模块会扩展其他便捷信息查询工具。

---

## 流式方法

### chat.route.suggest — 会话目标选择（流式 Shadow 工作流程）

> 发送动作触发：前端调 `suggestConversationRouteStream`，后端先实时推送 `type:'route'` chunk（`data.delta` 的 thinking/content 累积增量），结束后推送最终 `data`（含 `target`/`trace`，无 `delta` 字段）。前端据此在发送面板右侧渲染路由小窗（候选会话 + 最终选择 + 实时思考/正文）。

```json
→ {"id":"r7","kind":"request","method":"chat.route.suggest","params":{"presetId":"p1","draft":"帮我看看昨天的报告","requestVersion":1}}

// 实时增量（thinking/content 为增量，前端累积拼接）
← {"kind":"chunk","type":"route","requestId":"r7","data":{"delta":{"thinking":"需要判断这条消息应继续哪个历史会话。","content":""}}}
← {"kind":"chunk","type":"route","requestId":"r7","data":{"delta":{"thinking":"候选中有两个预设会话，其中「项目周报」与报告相关。","content":"正在调用 select_conversation 选择目标。"}}}

// 最终结果（无 delta 字段）
← {"kind":"chunk","type":"route","requestId":"r7","data":{"requestVersion":1,"target":{"chatId":"c2","confidence":0.9,"reason":"与历史报告会话语义相关"},"trace":{"context":{"draft":"帮我看看昨天的报告","candidates":[{"chatId":"c1","preview":"闲聊","lastUserActivityAt":1700000000000},{"chatId":"c2","preview":"项目周报","lastUserActivityAt":1700000000001}]},"response":{"content":"已确定目标会话。","toolCall":{"name":"select_conversation","arguments":{"chatId":"c2","confidence":0.9,"reason":"与历史报告会话语义相关"}}}}}}

// 最终响应
← {"id":"a7","kind":"response","requestId":"r7","success":true,"data":{"requestVersion":1,"target":{"chatId":"c2","confidence":0.9,"reason":"与历史报告会话语义相关"},"trace":{"context":{"draft":"帮我看看昨天的报告","candidates":[{"chatId":"c1","preview":"闲聊","lastUserActivityAt":1700000000000},{"chatId":"c2","preview":"项目周报","lastUserActivityAt":1700000000001}]},"response":{"content":"已确定目标会话。","toolCall":{"name":"select_conversation","arguments":{"chatId":"c2","confidence":0.9,"reason":"与历史报告会话语义相关"}}}}}}
```

> `chatId:null` 表示选择新建对话。失败时消息不得发送，由用户手动选目标。

#### 前端目标选择状态（quickTarget）生命周期约定

> 2026-08-20 修复「指定历史会话发送仍莫名新建会话」引入。根因：`quickTarget`（AgentDialog/WorkbenchDialog 内持有的发送目标选择，含 `{target:'new'}`）此前无任何重置时机，且 composer 原生窗 keepAlive（close=hide 不销毁组件），残留的 `'new'` 会在后续发送时跳过用户确认直接 `chat.create` 新会话。

| 清空时机 | 理由 |
|----------|------|
| `chatId` 变化（`watch` 清空） | 会话列表/历史列表/retarget 等外部切换不经过目标选择器，旧选择对新会话无意义；残留 `'new'` 会把消息发进意外新建的会话 |
| 发送成功且 `target === 'new'` | `'new'` 是**一次性**语义：会话已创建并接收本条消息，继续持有会让下一条消息再建一个新会话 |
| AI 选择（`source:'ai'`）被用户操作覆盖 | 既有行为：`clearAiQuickTarget` / picker `clear-target` |

交互约束：「＋新会话」按钮与历史会话一致走**两段式确认**（第一次点击半选高亮、第二次点击锁定），不得一次点击即锁定为 `'new'`——历史会话列表末尾的该按钮极易误触，一次锁定即静默新建会话。

### chat.get — 流式返回历史

```json
→ {"id":"r8","kind":"request","method":"chat.get","params":{"chatId":"c1"}}

// 每条历史消息拆成 staged chunk（带 role）；content_end 带 runtime（user=发送时配置，assistant=前一条 user runtime，供前端 hover 显该消息用的 brain/工具）
← {"kind":"chunk","type":"staged","requestId":"r8","data":{"type":"thinking_end","role":"assistant","thinking":"..."}}
← {"kind":"chunk","type":"staged","requestId":"r8","data":{"type":"content_end","role":"assistant","content":"你好","runtime":{"brain":"longcat","senseGroup":"default","mcpServers":[]}}}
← {"kind":"chunk","type":"staged","requestId":"r8","data":{"type":"sense_end","role":"sense","senseName":"read_file","arguments":"{...}"}}

// 历史发完
← {"kind":"notification","type":"loaded","requestId":"r8","chatId":"c1","data":null}

// 最终响应（末条为未完成周期时携带 canResume:true）
← {"id":"a8","kind":"response","requestId":"r8","success":true,"data":{"chatId":"c1","canResume":true}}
```

> 末条为 loop 未自然结束（pending sense，或 done sense 无后续 assistant）时 response 携带 `canResume:true`，前端据此两选一：
>
> - **发新消息** `chat.send` → 撤回整个当前周期 AI 响应（发 `staged.reverse` chunk）+ 用新 prompt 重跑
> - **点续接按钮** `chat.resume`（无 prompt）→ 恢复执行 pending sense 或继续 loop

### chat.send — 发送消息（核心流程）

```json
→ {"id":"r9","kind":"request","method":"chat.send","params":{"chatId":"c1","prompt":"读一下 a.txt"}}

// 0. 仅 chat.get 恢复场景（重启后末尾留有未完成周期）：发 reverse chunk，撤回整个当前周期 AI 响应（think+content+tool+pending sense）回退到上一周期结束
← {"kind":"chunk","type":"staged","requestId":"r9","data":{"type":"reverse","messageIds":["msg_5","msg_6"]}}

// 1. 输入已消费
← {"kind":"notification","type":"consumed","requestId":"r9","data":{"count":1}}

// 2. LLM 流式增量（每个可恢复 chat 事件显式带 chatId/runId/seq；断线后 chat.sync 补发）
← {"kind":"chunk","type":"stream","requestId":"r9","chatId":"c1","runId":"r9","data":{"content":"我来"}}
← {"kind":"chunk","type":"stream","requestId":"r9","data":{"content":"读取"}}
← {"kind":"chunk","type":"stream","requestId":"r9","data":{"thinking":"..."}}
← {"kind":"chunk","type":"stream","requestId":"r9","data":{"senseCall":[{"index":0,"id":"call_abc","name":"read_file","arguments":"{\"path\":\"/a.txt\"}"}]}}

// 3. 阶段完成（JSON 帧）
← {"kind":"chunk","type":"staged","requestId":"r9","data":{"type":"thinking_end","thinking":"..."}}
← {"kind":"chunk","type":"staged","requestId":"r9","data":{"type":"content_end","content":"读取文件"}}
← {"kind":"chunk","type":"staged","requestId":"r9","data":{"type":"sense_end","senseName":"read_file","arguments":"{\"path\":\"/a.txt\"}"}}

// 4. 感官触发：auto 不推 interrupt（无审批）；smart/manual 推 interrupt 携 waitTime/createdAt 待审批
// —— auto 模式：直接执行（无 interrupt）——
← {"kind":"notification","type":"accept","requestId":"r9",
   "data":{"approvalId":"call_abc","senseName":"read_file","result":"1\t文件内容..."}}

// 5. 第二轮 LLM 基于结果回复（loop 继续）
← {"kind":"chunk","type":"stream","requestId":"r9","data":{"content":"文件内容是..."}}
← {"kind":"chunk","type":"staged","requestId":"r9","data":{"type":"content_end","content":"文件内容是..."}}

// 6. 结束
← {"kind":"notification","type":"done","requestId":"r9","chatId":"c1","runId":"r9","data":{"contextUsage":0.12}}

// 最终响应
← {"id":"a9","kind":"response","requestId":"r9","success":true,"data":{"chatId":"c1","runId":"r9"}}
```

> 内部 effect chunk（`message_created`/`message_updated`/`sense_pending`）由 service observer 消费，不发出传输层。
>
> **当前执行配置关联**：历史 `metadata.runtime` 不参与新执行。主会话按稳定 `presetId`（旧数据回退 preset 名）关联当前 leader，子会话按历史 type 关联当前 role；缺少关联时返回 `RUNTIME_SELECTION_REQUIRED`，用户显式选择当前运行配置后再执行。
>
> **末尾未完成自动撤回（仅 chat.get 恢复场景）**：此情况只在服务重启后 `chat.get` 暴露出末尾未完成周期时出现——正常运行中 loop 会自动续接，不会留下 pending。此时 `chat.send` 触发撤回：先发 `staged.reverse` chunk（携带被撤回的 messageIds），**撤回整个当前周期的 AI 响应（think + content + tool/senseCalls + pending sense），回退到上一周期结束**（标记 `revoked`，buildMessages 过滤），再用新 prompt 重跑。
>
> **运行中 send**（loop 活跃，如 pending 审批等待）：不撤回，仅入队输入，下一个 loop 周期消费。
>
> 运行中再次 `chat.send` 只入队输入，复用同一运行流；下一轮 loop 消费累积输入时 `consumed` 的 `count` 可能 >1。

### chat.resume — 续接（无 prompt，恢复执行 / 继续 loop）

> 前置：`chat.get` 返回 `canResume:true`。前端点续接按钮发起，**无 prompt**。把上次未完成状态走到完成，整体同默认 send 流一致，仅首轮跳过 chat 层（不调 LLM）。

```json
→ {"id":"r10","kind":"request","method":"chat.resume","params":{"chatId":"c1"}}

// Case 1：末尾有 pending sense → 进 loop 跳过 chat 层（senseMiddleware 不调 next，不调 LLM），重发 sense_end → interrupt（仅 smart/manual；auto 直接执行不推）
← {"kind":"notification","type":"interrupt","requestId":"r10",
   "data":{"approvalId":"call_abc","senseName":"read_file","arguments":"{...}","supervisionLevel":1,"needsApproval":true,"waitTime":30000,"createdAt":1700000000000}}

// —— 同默认审批流 ——
C→S sense.approval {action:"accept"}
← {"kind":"notification","type":"accept","requestId":"r10","data":{"approvalId":"call_abc","senseName":"read_file","result":"..."}}

// 后续轮次正常调 LLM 继续
← {"kind":"chunk","type":"stream","requestId":"r10","data":{"content":"文件内容是..."}}
← {"kind":"chunk","type":"staged","requestId":"r10","data":{"type":"content_end","content":"文件内容是..."}}
← {"kind":"notification","type":"done","requestId":"r10","chatId":"c1","runId":"r10","data":{"contextUsage":0.12}}

// 最终响应
← {"id":"a10","kind":"response","requestId":"r10","success":true,"data":{"chatId":"c1","runId":"r10"}}
```

> **续接规则**（同默认 send 流完全一致，首轮仅跳过 chat 层不调 LLM）：
>
> - **末尾有 pending sense** → senseMiddleware 检测到 pending，重发 `sense_end` → auto 直接执行（不推 interrupt）/ smart 推 `interrupt` 等客户端审批，不调 `next` 进 chat；执行后 loop 正常继续
> - **末尾全 done（无 pending）** → 直接进 loop，正常调 LLM 处理 sense 结果并回复
> - **sense 群中有工具不在当前 senseTable**（sense group 已换 / 工具移除）→ 跳过监管，静默处理，写结果「无此工具」（占位回执，LLM 据此感知工具不存在）
> - Phase 0（send 自动恢复执行 pending sense）已移除，续接必须由显式 `chat.resume` 按钮触发
>
> 无 prompt。前置：chat 必须已有可恢复的 runtime selection。新建/更新时由 `chat.create` 或 `runtime.set` 写入 `metadata.runtime`；服务重启后 `chat.get` / `chat.send` / `chat.resume` 会从 metadata 自动恢复。

### 工作台树级暂停与续接

```text
C→S chat.abort {chatId:root, commandId:pauseId}
  → 按孙→子→根停止当时活跃 run，持久化精确目标集和 termination
  ← {pauseId,status:"paused",results:[...]}

C→S chat.resumeTree {rootChatId:root,pauseId,commandId}
  → 只启动仍属于该暂停集的目标；后代优先、根最后
  ← {pauseId,status:"completed|partial",results:[...]}
  ← root subscription 持续收到各 chat 的 run.updated/stream/done
```

**目标可续语义（回落）**：`tree_control_targets.status` 由 `paused`→`resumed` 后，若续跑中途再次失败/被暂停，目标不会在 DB 回落回 `paused`。判定"可续"以**运行时为准**：目标为 `paused`/`failed`，或虽为 `resumed` 但该 chat 最新 run 处于 `paused` 且 `computeCanResume` 成立 → 均可续。`chat.resumeTree` 匹配放宽到该判据（不再要求 `latest.runId===target.pausedRunId`），续接前把 `paused_run_id` 对齐到当前 run。已被 `send_to_child` 接管的 `delegated` 目标与 `skipped` 目标不参与续接。

**提问态与继续的关系**：`chat` 存在 `status='pending'` 的提问批（`question_batches`）时，`chat.list`/`chat.get` 的 `canResume=false` 是设计——答案必须走 `chat.answerQuestionBatch`（批完成 → 置 `resumePending` → 返回 `shouldResume`），由前端在批完成后调 `chat.resume` 续跑。因此：
- `chat.resume` **拒绝**带 pending 批的直接调用（防御守卫），避免带着未答问题跑执行死循环。
- 前端**必须保证**工作台/会话打开即恢复提问快照（hydrateTree→syncOne→pendingQuestionBatches），不得出现"无卡片无按钮"的硬死锁。
- 孤立 pending 批（`status='pending'` 但零 `status='pending'` 的 item）视为僵尸，会被读时自愈清扫标 `completed`，不再阻塞 `canResume`。清扫语义单测见 [test/db/questionOrphanSweep.test.ts](../test/db/questionOrphanSweep.test.ts)。

暂停后用户直接发送新消息时，不等价于 `chat.resumeTree`：服务端只启动根 Agent。若本次暂停还有子 Agent 目标，则在用户消息之后追加一条持久 system 执行事件，列出角色、`chatId` 和 `pauseId`；根 Agent 据此决定是否调用 `send_to_child`。事件 ID 由 `pauseId + 输入 commandId` 稳定派生；若进程在输入确认后、事件落库前退出，恢复 accepted input 时必须检测并补回，已存在则不得重复。被 `send_to_child` 接管的目标标记为 `delegated`，旧暂停命令不再恢复它。

---

## 端到端标准流程

### 流程 A：纯文本对话（auto，无 sense 调用）

```text
C→S brain.list                    → response(brains)
C→S sense.list                    → response(senseGroups)
C→S chat.create {brain,senseGroup,mcpServers?} → response(chatId,brain,senseGroup,mcpServers)
C→S chat.send {prompt}
  ← consumed {count:1}
  ← stream.content ×N
  ← staged content_end
  ← done
  ← response(chatId)
```

### 流程 B：auto sense（read_file:auto）

```text
C→S chat.send {prompt}
  ← consumed
  ← stream.content / stream.thinking / stream.senseCall(delta)
  ← staged thinking_end / content_end / sense_end
  ← accept {result}              ← auto 直接执行，无 interrupt、无需客户端审批
  ← stream.content（第二轮）
  ← staged content_end
  ← done
```

### 流程 C：smart sense + 审批（write_file:smart）

```text
C→S chat.send {prompt}
  ← consumed
  ← stream.content / staged content_end
  ← staged sense_end
  ← interrupt {supervisionLevel:1, needsApproval:true, waitTime, createdAt}
     [服务端启动审批超时 = waitTime（来自 `global.approval_timeout`，字段约束 `>= 0`：0 = 不限时）；前端倒计时 = waitTime - (now - createdAt)，用户 accept/reject 后立即关闭]

C→S sense.approval {approvalId, action:"accept"}
  → response(approval)
  ← accept {result}
  ← stream.content（第二轮，LLM 收到写入结果）
  ← done

// 若 reject:
C→S sense.approval {action:"reject", reason:"..."}
  ← rejected {reason}
  ← stream.content（LLM 收到"被拒绝:..."）
  ← done
```

### 流程 D：服务重启后恢复

```text
C→S chat.get {chatId}            → ensureChat 从 metadata.runtime 恢复 runtime
                                → staged ×N + loaded + response{chatId,canResume:true}

# 两选一：
# (a) 发新消息（撤回整个当前周期 + 重跑）
C→S chat.send {chatId, prompt}
  ← staged.reverse {messageIds:[...]}   ← 撤回整个当前周期 AI 响应（think+content+tool+pending sense）
  ← consumed / stream / staged / done

# (b) 点续接按钮（恢复执行 / 继续 loop）
C→S chat.resume {chatId}              ← 无 prompt
  ← interrupt（pending sense 重发，按等级执行）  或  直接 stream（全 done 进 loop）
  ← accept / stream / staged / done
```

---

## 错误路径

**软失败**（middleware 产出 ErrorChunk，如 maxLoop 超限）：

```json
← {"kind":"notification","type":"error","requestId":"r9","data":{"message":"已达到最大循环次数限制 (30)"}}
← {"kind":"notification","type":"done","requestId":"r9","chatId":"c1","runId":"r9","data":{"contextUsage":0.12}}
← {"id":"a9","kind":"response","requestId":"r9","success":true,"data":{"chatId":"c1","runId":"r9"}}
```

**硬失败**（handler 抛异常，如 chat 不存在 / Chat busy）：

```json
← {"id":"a9","kind":"response","requestId":"r9","success":false,"error":{"code":"INTERNAL","message":"..."}}
```

**跨连接并发**（同一 chat 已在另一连接活跃，send/resume 被拒）：

```json
← {"id":"a9","kind":"response","requestId":"r9","success":false,"error":{"code":"CONFLICT","message":"Chat \"c1\" is busy (active on another connection)"}}
```

**限时审批超时**（`interrupt.data.waitTime > 0`，到点未决）= 自动拒绝：

```json
← {"id":"a9","kind":"notification","type":"rejected","data":{"approvalId":"<senseId>","senseName":"...","reason":"用户超时已自动拒绝"}}
```

> 限时超时由 core approvalRegistry 独占管理（`createApproval(id, global.approval_timeout)`，见 tool.ts）：registry 内部 timer fire → resolve as reject → senseMiddleware await 解除 → 子 loop **继续运行**（= 用户点 Reject 的正常路径，发 `rejected` notification）。service websocket 层不起 timer、不发 TIMEOUT response、不断 WS。

**连接断开**（WS close）：

> close(ws) → `approvalManager.park(approvalId)`（reject `AgentParkError` 解除挂起 generator，observer 静默不唤主）。pending sense content 保持空，子 chat 保持 `canResume:true`，重连后 `chat.get` 返回 `canResume:true`，`chat.resume` Case1 重建 pending sense 续跑。

**方法未注册**：

```json
← {"id":"a9","kind":"response","requestId":"r9","success":false,"error":{"code":"METHOD_NOT_FOUND","message":"Method \"xxx\" not found"}}
```

> 错误码全集见 [protocol.md](protocol.md)「错误处理」。
