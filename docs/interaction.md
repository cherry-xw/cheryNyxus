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
// lean（初始化重建 pet 树用，不查 messages）
→ {"id":"r5","kind":"request","method":"chat.list","params":{}}
← {"id":"a5","kind":"response","requestId":"r5","success":true,
   "data":{"chats":[{"chatId":"c1","createdAt":1718150400000,"updatedAt":1718151000000,"messageCount":12,"parentChatId":null}]}}

// includePreview（会话列表用，按 messages_month 分组批量查首条 user 消息 + 计数）
→ {"id":"r5b","kind":"request","method":"chat.list","params":{"includePreview":true}}
← {"id":"a5b","kind":"response","requestId":"r5b","success":true,
   "data":{"chats":[{"chatId":"c1","createdAt":1718150400000,"updatedAt":1718151000000,"messageCount":12,"parentChatId":null,"preview":"读一下 a.txt","turnCount":3}]}}
```

> `includePreview=true` 时每项增返 `preview`（首条 user 消息截断 ≤40 字符）+ `turnCount`（user 消息数）。"指令"跳过规则待定，默认取首条 user 消息。lean 模式省略该二字段，免 N+1。

### chat.delete

```json
→ {"id":"r6","kind":"request","method":"chat.delete","params":{"chatId":"c1"}}
← {"id":"a6","kind":"response","requestId":"r6","success":true,"data":{"chatId":"c1"}}
```

> 目标为主 chat（无 `parent_chat_id`）时级联删其所有子 chat + 各自消息 + 清内存 runtime（`clearChatRuntime`），避免孤儿子 chat。子 chat 自身删除不级联。

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
```

> 独立工具方法，不依赖 chat/brain 运行时。后续该模块会扩展其他便捷信息查询工具。

---

## 流式方法

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
