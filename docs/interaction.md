# 交互流程示例

> [← 返回 README](../README.md) ｜ [协议规范](websocket.md)

各方法的完整交互序列（C→S / S→C 实际消息流）。协议规范（传输格式、消息结构、字段定义、错误码）见 [websocket.md](websocket.md)。

> 方向标记：`→` C→S，`←` S→C。stream chunk 为二进制帧，其余为 JSON 帧。

---

## 非流式方法（单次请求-响应）

### brain.list

```json
→ {"id":"r1","kind":"request","method":"brain.list","params":{}}
← {"id":"a1","kind":"response","requestId":"r1","success":true,
   "data":{"brains":[{"name":"longcat","provider":"ollama","model":"gemma3:1b","thinking":true,"senseGroups":["safe","danger"]}]}}
```

> `senseGroups` 返回全局全量分组，每个 brain 相同。

### sense.list

```json
→ {"id":"r2","kind":"request","method":"sense.list","params":{}}
← {"id":"a2","kind":"response","requestId":"r2","success":true,
   "data":{"senseGroups":[{"name":"safe","senses":["read_file","execute_command:auto","write_file:confirm"]}]}}
```

> `senses` 为原始字符串数组，含 `:level` 后缀，未解析。

### runtime.set

```json
→ {"id":"r3","kind":"request","method":"runtime.set",
   "params":{"chatId":"c1","brain":"longcat","senseGroups":["safe"]}}
← {"id":"a3","kind":"response","requestId":"r3","success":true,
   "data":{"chatId":"c1","brain":"longcat","senseGroups":["safe"]}}
```

> 前置：chat 必须已存在。每轮可换 brain + senseGroups。

### chat.create

```json
→ {"id":"r4","kind":"request","method":"chat.create",
   "params":{"chatId":"c1","brain":"longcat","senseGroups":["safe"]}}
← {"id":"a4","kind":"response","requestId":"r4","success":true,"data":{"chatId":"c1"}}
```

> `chatId` 可选（不传服务端生成 UUID）。必带 brain + senseGroups。创建时一次性加载历史到内存。

### chat.list

```json
→ {"id":"r5","kind":"request","method":"chat.list","params":{}}
← {"id":"a5","kind":"response","requestId":"r5","success":true,
   "data":{"chats":[{"chatId":"c1","createdAt":1718150400000,"updatedAt":1718151000000,"messageCount":12}]}}
```

### chat.delete

```json
→ {"id":"r6","kind":"request","method":"chat.delete","params":{"chatId":"c1"}}
← {"id":"a6","kind":"response","requestId":"r6","success":true,"data":{"chatId":"c1"}}
```

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

---

## 流式方法

### chat.get — 流式返回历史

```json
→ {"id":"r8","kind":"request","method":"chat.get","params":{"chatId":"c1"}}

// 每条历史消息拆成 staged chunk（带 role）
← {"kind":"chunk","type":"staged","requestId":"r8","data":{"type":"thinking_end","role":"assistant","thinking":"..."}}
← {"kind":"chunk","type":"staged","requestId":"r8","data":{"type":"content_end","role":"assistant","content":"你好"}}
← {"kind":"chunk","type":"staged","requestId":"r8","data":{"type":"sense_end","role":"sense","senseName":"read_file","arguments":"{...}"}}

// 历史发完
← {"kind":"notification","type":"loaded","requestId":"r8","data":null}

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

// 2. LLM 流式增量（二进制帧，seq 递增）
← {"kind":"chunk","type":"stream","requestId":"r9","seq":1,"data":{"content":"我来"}}
← {"kind":"chunk","type":"stream","requestId":"r9","seq":2,"data":{"content":"读取"}}
← {"kind":"chunk","type":"stream","requestId":"r9","seq":3,"data":{"thinking":"..."}}
← {"kind":"chunk","type":"stream","requestId":"r9","seq":4,"data":{"senseCall":[{"index":0,"id":"call_abc","name":"read_file","arguments":"{\"path\":\"/a.txt\"}"}]}}

// 3. 阶段完成（JSON 帧）
← {"kind":"chunk","type":"staged","requestId":"r9","data":{"type":"thinking_end","thinking":"..."}}
← {"kind":"chunk","type":"staged","requestId":"r9","data":{"type":"content_end","content":"读取文件"}}
← {"kind":"chunk","type":"staged","requestId":"r9","data":{"type":"sense_end","senseName":"read_file","arguments":"{\"path\":\"/a.txt\"}"}}

// 4. 感官触发（auto 则 needsApproval:false，confirm 则 true）
← {"kind":"notification","type":"interrupt","requestId":"r9",
   "data":{"approvalId":"call_abc","senseName":"read_file","arguments":"{...}","supervisionLevel":0,"needsApproval":false}}

// —— auto 模式：直接执行 ——
← {"kind":"notification","type":"accept","requestId":"r9",
   "data":{"approvalId":"call_abc","senseName":"read_file","result":"1\t文件内容..."}}

// 5. 第二轮 LLM 基于结果回复（loop 继续）
← {"kind":"chunk","type":"stream","requestId":"r9","seq":5,"data":{"content":"文件内容是..."}}
← {"kind":"chunk","type":"staged","requestId":"r9","data":{"type":"content_end","content":"文件内容是..."}}

// 6. 结束
← {"kind":"notification","type":"done","requestId":"r9","data":null}

// 最终响应
← {"id":"a9","kind":"response","requestId":"r9","success":true,"data":{"chatId":"c1"}}
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

// Case 1：末尾有 pending sense → 进 loop 跳过 chat 层（senseMiddleware 不调 next，不调 LLM），重发 sense_end → interrupt（按监管等级）
← {"kind":"notification","type":"interrupt","requestId":"r10",
   "data":{"approvalId":"call_abc","senseName":"read_file","arguments":"{...}","supervisionLevel":1,"needsApproval":true}}

// —— 同默认审批流 ——
C→S sense.approval {action:"accept"}
← {"kind":"notification","type":"accept","requestId":"r10","data":{"approvalId":"call_abc","senseName":"read_file","result":"..."}}

// 后续轮次正常调 LLM 继续
← {"kind":"chunk","type":"stream","requestId":"r10","seq":1,"data":{"content":"文件内容是..."}}
← {"kind":"chunk","type":"staged","requestId":"r10","data":{"type":"content_end","content":"文件内容是..."}}
← {"kind":"notification","type":"done","requestId":"r10","data":null}

// 最终响应
← {"id":"a10","kind":"response","requestId":"r10","success":true,"data":{"chatId":"c1"}}
```

> **续接规则**（同默认 send 流完全一致，首轮仅跳过 chat 层不调 LLM）：
>
> - **末尾有 pending sense** → senseMiddleware 检测到 pending，重发 `sense_end` → `interrupt`，按监管等级处理（auto 直接执行 / confirm 等客户端审批），不调 `next` 进 chat；执行后 loop 正常继续
> - **末尾全 done（无 pending）** → 直接进 loop，正常调 LLM 处理 sense 结果并回复
> - **sense 群中有工具不在当前 senseTable**（sense group 已换 / 工具移除）→ 跳过监管，静默处理，写结果「无此工具」（占位回执，LLM 据此感知工具不存在）
> - Phase 0（send 自动恢复执行 pending sense）已移除，续接必须由显式 `chat.resume` 按钮触发
>
> 无 prompt。前置：须 `chat.create` 或 `runtime.set` 注入完整 runtime。

---

## 端到端标准流程

### 流程 A：纯文本对话（auto，无 sense 调用）

```text
C→S brain.list                    → response(brains)
C→S sense.list                    → response(senseGroups)
C→S chat.create {brain,sense}     → response(chatId)
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
  ← interrupt {supervisionLevel:0, needsApproval:false}
  ← accept {result}              ← auto 直接执行，无需客户端审批
  ← stream.content（第二轮）
  ← staged content_end
  ← done
```

### 流程 C：confirm sense + 审批（write_file:confirm）

```text
C→S chat.send {prompt}
  ← consumed
  ← stream.content / staged content_end
  ← staged sense_end
  ← interrupt {supervisionLevel:1, needsApproval:true}
     [服务端启动 15min 审批超时]

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
C→S chat.create {chatId,brain,sense}  → response   ← 重建内存 runtime（必需，重启后内存丢失）
C→S chat.get {chatId}            → staged ×N + loaded + response{chatId,canResume:true}

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
← {"kind":"notification","type":"done","requestId":"r9","data":null}
← {"id":"a9","kind":"response","requestId":"r9","success":true,"data":{"chatId":"c1"}}
```

**硬失败**（handler 抛异常，如 chat 不存在 / LLM 错误 / Chat busy）：

```json
← {"kind":"notification","type":"error","requestId":"r9","data":{"message":"..."}}
← {"id":"a9","kind":"response","requestId":"r9","success":false,"error":{"code":"INTERNAL","message":"..."}}
```

**跨连接并发**（同一 chat 已在另一连接活跃，send/resume 被拒）：

```json
← {"kind":"notification","type":"error","requestId":"r9","data":{"message":"Chat \"c1\" is busy (active on another connection)"}}
← {"id":"a9","kind":"response","requestId":"r9","success":false,"error":{"code":"INTERNAL","message":"Chat \"c1\" is busy (active on another connection)"}}
```

**审批超时**（15min）或连接断开：

```json
← {"id":"a9","kind":"response","requestId":"r9","success":false,"error":{"code":"TIMEOUT","message":"Approval timeout - chat ended"}}
[连接关闭]
```

> 超时/断开后 pending sense 不执行（abort 触发 reject 解除挂起的 generator），content 保持空，重连后 `chat.get` 仍返回 `canResume:true` 可继续 `chat.resume`。

**方法未注册**：

```json
← {"id":"a9","kind":"response","requestId":"r9","success":false,"error":{"code":"METHOD_NOT_FOUND","message":"Method \"xxx\" not found"}}
```

> 错误码全集见 [websocket.md](websocket.md)「错误处理」。
