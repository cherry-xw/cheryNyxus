# 命令系统（Commands）

> 源码 [src/service/command/handler.ts](../../src/service/command/handler.ts) ｜ [src/service/chat/autoCompact.ts](../../src/service/chat/autoCompact.ts) ｜ [src/agent/prompt/loadCommand.ts](../../src/agent/prompt/loadCommand.ts)

## 职责

`[[command:/<name>]]` 在用户正文中出现时，由 `injectCommands`（send 预检阶段）分类处理：

| token 类型 | 行为 |
|-----------|------|
| `[[command:/<skillName>]]`（name ∈ 已注册 skill 名） | AI 通过 system prompt `<skills>` 段自行加载；**后端不额外操作** |
| `[[command:/<builtinName>]]`（对应 `.chery/command/<builtinName>.md`） | 加载文件正文，作为**独立 user message** 入队到主 prompt 之前；LLM 按 FIFO 顺序消费「先正文指令、再用户实际消息」 |

设计上对比 `SKILL.md`：

- `SKILL.md`（用户技能）→ system prompt `<skills>` 段预注入元数据 + skill 感官按需加载正文；
- `.chery/command/<name>.md`（系统内置命令）→ 不预注入；触发时**追加独立 user message**（不入系统提示词缓存）。

> **关键约束**：builtin command 正文是**独立 user message**，不是 prompt 末尾附注。这保证 LLM 看到
> 「先把 compact 跑完，再处理用户后续问题」的清晰边界，避免「压缩指令 + 用户问题混淆在同一 prompt」。

## 三种触发路径

### 1. 用户手动 `[[command:/<name>]]`

发送窗口输入 `[[command:/compact]]` 或 pet 的 compact 按钮（在前端 `PetToolbar` 触发）直接发送含 token 的文本。

后端流程：
1. `handleChatSend` → `injectCommands(chatId, userPrompt)`
2. 扫描 userPrompt → 提取 builtin names → 加载 `.chery/command/<name>.md` 正文 → 入队 `extraUserMessages`
3. `agent.run(userPrompt, { extraUserMessages })` → `AgentSession.send` 按 FIFO 入队 extra → 主 input
4. LLM 看到「先正文指令、再 `[[command:/compact]]`」按序消费
5. `AgentSession.send` 检测到主 input 含 `[[command:/compact]]` → loop 完成后 `compactToLatestSummary()` 收尾

### 2. send 预检自动压缩

`handleChatSend`（[src/service/chat/send.ts](../../src/service/chat/send.ts)）进入 bind + activateChatRun
之后，调 `injectCommands(chatId, prompt)`：

- 若 `shouldAutoCompact` 返回 `"usage" | "overflow"` →
  1. 改造 prompt：头部注入 `[[command:/compact]]\n\n<原 prompt>`（原 prompt 保留）
  2. compact.md 正文 unshift 到 `extraUserMessages` 顶部（compact 优先级最高）
  3. 流首推一道 `auto_compacted` notification 给前端（toast：「已自动压缩」）
- 若 userPrompt 含其它 builtin tokens（如 `[[command:/review]]`）→ 同步加载其正文入队，与 compact 并存时 compact 优先

### 3. loop done 后复检

`streamAgentChunks`（[src/service/chat/streamMapper.ts](../../src/service/chat/streamMapper.ts)）
在 `done notification` 之前调 `maybeAutoCompactAfterDone(chatId)`；命中则同样推 `auto_compacted`
让前端亮 compact 按钮，**不改 prompt**（本轮已结束；下次 send 才真正触发）。

## 触发条件

`autoCompact.ts`：

```ts
// 任一命中即触发
shouldAutoCompact(chatId):
  return used + safety_margin > total ? "overflow"
       : thresholdReached(auto, used, total) ? "usage"
       : undefined

// auto 支持 tokens 或 percent 两种单位
thresholdReached(t, used, total):
  total <= 0                → false
  t.unit === "percent"      → used / total >= t.value
  else                      → used >= t.value

// compact 无开关；可用性只看 brain 上下文门槛。临时换模型按当次发送的 brain 判定
isCompactEnabled(chatId):
  brain.contextLimit >= config.global.command.min_context_limit
```

`warn` 阈值**不参与后端触发**，仅由后端投影给前端；前端据 `contextUsage >= warn` 做视觉提示
（ContextBar/compact 按钮提示态），不发通知。

| 字段 | 默认 | 含义 |
|------|------|------|
| `warn` | `{ percent, 0.6 }` | 前端视觉提示阈值（到达 → 提示用户可压缩）；`Threshold` 形态，不触发后端 |
| `auto` | `{ percent, 0.8 }` | 自动触发阈值，`thresholdReached(auto)` 命中即压缩；`Threshold` 形态 |
| `min_context_limit` | `32000` | brain.contextLimit 低于此值 → compact 功能整体关闭（「不可用」门槛，仅 tokens） |
| `safety_margin` | `1024` | `used + 1024 > total` 时强制触发（小 context 溢出防御；内部默认，不入 UI） |

`Threshold = { unit: "tokens" | "percent"; value: number }`，percent 存 0..1。前端填写**必须以 `%` 或 `k`
结尾**（如 `50%` / `64k`，不接受裸数字）；`min_context_limit` 仅 tokens 且必须以 `k` 结尾（如 `32k`，brain 容量门槛，与百分比语义无关）。

## 文件格式

`.chery/command/<name>.md`：

```markdown
---
name: compact                      # 可选，缺省 = 文件名 basename
description: 整理当前对话为后续继续工作的上下文摘要。   # 必填（缺失时为空串）；前端 tab 列表展示
---

整理当前对话的目标、关键事实、已作决策、当前进度、未解决问题和待办，
输出一份可直接供后续对话使用的简明上下文摘要。

不要调用工具，不要解释压缩过程，不要输出与该摘要无关的内容。
该回复会替换后续模型可见的旧对话上下文。
```

- frontmatter 用 [js-yaml](https://github.com/nodeca/js-yaml) 解析，正则同 `SKILL.md`。
- `name` 命名空间：`/^[a-zA-Z0-9_-]+$/`，service 层守卫拒绝 `../` 越权与扩展名注入。
- 缺 frontmatter 时仍可工作（视 name = 文件名；description = ""；content 全文）。

## 注入数据结构

`injectCommands(chatId, userPrompt)` 返回：

```ts
{
  userPrompt: string;           // 头部可能含 [[command:/compact]] token
  extraUserMessages: string[];  // 命令正文独立 user messages；顺序 = extra[0] → ... → 主 prompt
  triggered: boolean;           // 自动 compact 是否触发
  reason?: "usage" | "overflow";
}
```

**LLM 看到的消息序列**（以「autoCompact 触发 + userPrompt 含 `[[command:/review]] 请审查」为例）：

```
User   : <以下是 [[command:/compact]] 的完整指令正文（仅本轮生效）...>   ← compact 正文（autoCompact 注入）
User   : <以下是 [[command:/review]] 的完整指令正文（仅本轮生效）...>   ← review 正文（userPrompt 中提取）
User   : [[command:/compact]]\n\n[[command:/review]] 请审查              ← 主 input
Assistant: <按 compact 指令生成的摘要 contextCompaction=true>             ← 上一轮 context 被压缩
```

`AgentSession.send` 的 `extraUserMessages` 入队顺序保证 LLM 按 FIFO 消费；FIFO 队列受 `MAX_USER_INPUTS=16`
背压保护，但命令正文优先级最高（compact unshift 到顶部），不会被丢弃。

## 摘要提取（summary 块）

压缩回复按 [compact.md](../../.chery/command/compact.md) 约定为 `<analysis>…</analysis>` + `<summary>…</summary>` 两块。注入后续 LLM 上下文时仅取 `<summary>` 块正文（`extractSummaryBlock`，正则 `<summary>([\s\S]*?)</summary>` 大小写不敏感），丢弃 analysis 中间过程；模型未按格式输出（无标签）→ 用整个 content（容错）。

- **DB 存完整**：observer 落库原始 content（analysis+summary），前端 `chat.get` 可见完整过程。
- **仅上下文注入提取**：[compactToLatestSummary](../../src/core/middleware/messageJournal.ts)（热路径内存裁剪）+ [loadHistory](../../src/service/chat/runtime.ts)（冷路径重建）两处注入时提取，冷热对齐。
- **tokens 对齐**：`contextCompactionTokens`（被压缩掉的旧上下文量）减数改用提取后 summary，与实际注入量自洽。

## 协议

### 后端 RPC（settings「指令」tab 后端）

| 方法 | 入参 | 出参 |
|------|------|------|
| `command.list` | `{}` | `{ commands: CommandInfo[] }`（按 name 排序） |

`CommandInfo` = `{ name, description, content }`，content 为 frontmatter 去除后的正文（trim）。

> 指令**不可在前端增删改**：`.chery/command/*.md` 由文件系统维护，Tab 只读枚举 + 配置项编辑。
> 缺失 `compact.md` → compact 指令不可用（Tab 标记不可用；`injectCommands` 自动触发时 warn 跳过）。

错误走 `INTERNAL`（磁盘 IO 失败）。

### WS notification `auto_compacted`

```ts
{ reason: "usage" | "overflow"; usedBefore: number; total: number }
```

- reason=`usage` → 强制门命中；`overflow` → 估算溢出。
- 流首（pre-check 改造 prompt 同步）或 done 之前推送；前端 `ElMessage.info` toast。
- 不是终态信号——紧邻的 `done` notification 含最新 `contextUsage` 为权威。

### `chat.get` / `chat.contextUsage` 携带 `commandConfig`

```ts
{ warn: Threshold, auto: Threshold, minContextLimit }
```

由 `config.global.command` 投影而来（无开关字段）。前端 `PetToolbar.showCompact` 据此判断按钮可见性
（`contextTotal ≥ minContextLimit && usage ≥ warn`）；`usage ≥ auto` 时按钮高亮强提示。

## 文件清单

| 文件 | 职责 |
|------|------|
| [src/agent/prompt/loadCommand.ts](../../src/agent/prompt/loadCommand.ts) | `getSystemCommand(name)` 实时读 `.chery/command/<name>.md` |
| [src/agent/prompt/loadSkill.ts](../../src/agent/prompt/loadSkill.ts) | `getSkillMetas()` 提供 skill 名集合，injectCommands 跳过 skill 类 |
| [src/service/chat/autoCompact.ts](../../src/service/chat/autoCompact.ts) | `isCompactEnabled` / `shouldAutoCompact` / `injectCommands` / `maybeAutoCompactAfterDone` |
| [src/service/command/handler.ts](../../src/service/command/handler.ts) | `handleCommandList/Read/Save/Delete` + `registerCommandHandlers` |
| [src/service/chat/send.ts](../../src/service/chat/send.ts) | handleChatSend 中调 injectCommands；首推 `auto_compacted` notification |
| [src/service/chat/streamMapper.ts](../../src/service/chat/streamMapper.ts) | done 段前调 `maybeAutoCompactAfterDone`；推 `auto_compacted` |
| [src/service/chat/handler.ts](../../src/service/chat/handler.ts) | chat.get / chat.contextUsage response 携带 `commandConfig` |
| [src/core/middleware/index.ts](../../src/core/middleware/index.ts) | `AgentSession.send(input, options?)` 接受 `extraUserMessages` 选项 |
| [src/agent/builder.ts](../../src/agent/builder.ts) | `AgentBuilder.run(input, options?)` 转发 `extraUserMessages` |
| [web/src/features/agent/settings/tabs/CommandsTab.vue](../../web/src/features/agent/settings/tabs/CommandsTab.vue) | settings 第八项「指令」tab 视图 |
| [web/src/features/agent/commands.ts](../../web/src/features/agent/commands.ts) | token 序列化 / 历史消息拆分 |
| [web/src/features/agent/PetToolbar.vue](../../web/src/features/agent/PetToolbar.vue) | compact 按钮门槛（contextTotal ≥ minContextLimit） |

## 依赖与关联

| 依赖 | 用途 |
|------|------|
| [agent/prompt/loadCommand](../../src/agent/prompt/loadCommand.ts) | frontmatter 解析（`getSystemCommand`） |
| [agent/prompt/loadSkill](../../src/agent/prompt/loadSkill.ts) | `getSkillMetas` 区分 skill vs builtin |
| [utils/token](../../src/utils/token.ts) | `computeContextUsage` 提供 usage/used/total |
| [utils/config](../../src/utils/config.ts) | `config.global.command` 配置块 |
| [db/chat](../../src/db/chat.ts) | `getChatRuntimeSelection` 取 chat 绑定 brain |
| [core/middleware](../../src/core/middleware/index.ts) | `AgentSession.send` 接受 `extraUserMessages` 选项入队 |
| 第三方 `js-yaml` | 命令文件 frontmatter 解析 |

## 扩展点

### 新增内置命令

1. 在 `.chery/command/` 下新增 `<name>.md`（文件系统维护，**前端 Tab 不可增删改**）——按上述 frontmatter 格式书写正文。
2. （可选）在前端 `MessageCommand`（[web/src/features/agent/commands.ts](../../web/src/features/agent/commands.ts)）
   注册按钮入口；token `[[command:/<name>]]` 自身即触发，无需前端额外步骤。
3. 无需重启 — 文件系统 `.chery/command/` 实时读取。

### compact 可用性

compact **无开关**，可用性由 brain 上下文门槛决定：`brain.contextLimit >= min_context_limit` 时启用，
低于门槛（如 mock_test 8K）按钮不显、auto 不触发。临时换模型（ephemeral brain）发送时，按该次实际 brain 的
contextLimit 重新判定（`isCompactEnabled` 走 ephemeral-aware 解析器）；默认 PetToolbar 展示只关联默认 brain 上下文。

### 调整阈值

阈值在 settings「指令」Tab 编辑（走 `config.save`），亦可手改 `config.yaml`：

```yaml
global:
  command:
    warn:  { unit: percent, value: 0.6 }   # 60% 提示
    auto:  { unit: percent, value: 0.8 }   # 80% 自动压缩
    min_context_limit: 16000               # 16K brain 也启用（「不可用」门槛，tokens）
```

`validateRawConfig` 启动期 fail loud 校验 `Threshold` 形态与数值范围；`config.save` zod schema 同样校验。