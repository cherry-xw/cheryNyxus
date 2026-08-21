# System Prompt 生成总览

> 提示词来源信息汇总入口。实现细节见 [Agent Prompt](./agent/prompt.md)；运行时消息链见 [Agent Middleware](./agent/middleware.md)；工具定义见 [Agent Sense](./agent/sense.md)。

## 文档定位

本文回答三个问题：

1. 一个 chat 的主 system message 从哪里来、按什么顺序组装。
2. 哪些信息会以额外 system/user message 或 `tools` 参数进入 LLM，而不属于主 system prompt 字符串。
3. 修改某类提示信息时，应改哪个文件、何时生效。

本文只维护跨模块总览和来源索引；Prompt、Memory、Command、Sense 等模块的解析、存储和扩展细节仍由各模块文档负责。

## 快速结论

主 system message 由 [src/agent/prompt/index.ts](../src/agent/prompt/index.ts) 的 `buildFirstSystemPrompt()` 构建，固定顺序为：

```text
<system-reminder>
{全局基础提示词}

{角色/预设 override；可选}
</system-reminder>

<environment>...</environment>
<workspace>...</workspace>                  # 可选
<memory layer="global">...</memory>        # 可选
<memory layer="workspace">...</memory>     # 可选

<skills>
  <skill name="...">名称、描述、触发条件</skill>
  ...
</skills>
```

最终 LLM 请求不只有这段文本：

```text
LLM request
├─ messages
│  ├─ 运行时媒体能力 system message                  # 有媒体标记时临时前置
│  ├─ 主 system message                              # 上述固定结构
│  ├─ 对话压缩摘要 system message                    # 有压缩边界时
│  ├─ 历史 user / assistant / tool messages
│  ├─ command 正文 user messages                     # 本轮触发时
│  └─ 当前 user message
└─ tools
   └─ 当前 runtime 的 Sense / MCP function schemas   # 独立 API 字段
```

因此需要区分：

- **主 system prompt**：`buildFirstSystemPrompt()` 产生的一条 system message。
- **额外 system message**：媒体能力提示、对话压缩摘要。
- **一次性 user 指令**：Command 正文。
- **工具定义**：Provider 请求的 `tools` 字段，不拼入 system prompt。

## 主 system message 的来源

| 顺序 | 组成 | 来源 | 读取时机 | 空值行为 |
|------|------|------|----------|----------|
| 1 | 全局基础提示词 | `.chery/prompt/system.md` | Prompt 模块加载时读取并缓存 | 文件不存在则空串 |
| 2 | 角色/预设 override | `config.roles.<type>.systemPrompt` 解析出的文件 | chat 初始化时实时读取 | 未配置则只用全局基础；文件缺失时 warn |
| 3 | Environment | Node `os` + `dayjs` | chat 初始化构建 prompt 时生成 | 始终存在 |
| 4 | Workspace + VCS | `config.presets.<name>.workspace` 快照 + VCS 检测 | chat 初始化时生成 | 无 workspace 则整段省略 |
| 5 | Global memory | `.chery/memory/main.md` | chat 初始化时读取 | 无活跃索引则整段省略 |
| 6 | Workspace memory | `.chery/workspace/<hash>/memory/main.md` | chat 初始化时读取 | 无 workspace 或无索引则整段省略 |
| 7 | Skills 元数据 | `.chery/skills/*/SKILL.md` + `.chery/plugins/*` | chat 初始化时实时扫描 | 无 skill 时保留空 `<skills>` 外壳 |

### 1. 全局基础提示词

固定路径：`.chery/prompt/system.md`。路径由 `config.global.prompts_dir + "/system.md"` 得到，不再从单独的 `system_prompt` 配置字段读取。

当前基础模板主要包含：

- 角色与目标。
- 用户表述和意图分析。
- Tool 使用约束。
- Skill 使用约束。
- `[[command:/name]]` 指令标记语义。
- 与用户沟通规则。
- 语气、格式和代码引用规则。

文件在 Prompt 模块加载时读取一次并缓存。运行中修改文件不会刷新已加载模块中的 `systemPrompt`；服务重启后重新读取。

模板文件位于运行目录 `.chery/`。需要修改项目默认模板时，按配置约定先同步 `.chery.template/prompt/system.md`，避免只改运行时目录。

### 2. 角色/预设 override

Override 是对全局基础提示词的**补充**，不是替换：

```text
system-reminder body = globalBase + "\n\n" + userSystem
```

来源链：

```text
config.roles.<type>.systemPrompt
  → 主 agent：resolvePresetSelection() 读取 preset.leader 对应角色
  → 子 agent：spawn 时读取目标 role
  → chat metadata.systemPromptFile 快照
  → ensureChat() 读取 metadata
  → AgentBuilder.init(..., systemPromptFile)
  → buildFirstSystemPrompt() 实时读取 systemPromptFile 内容并与全局 base 合并
```

`systemPrompt` 配置值相对 `.chery/`，可放在任意子目录，例如 `prompt/<group>/leader.md`。主 agent 与不同类型子 agent 可以使用不同 systemPromptFile。

### 3. Environment

始终注入：

```text
<environment>
操作系统: {os.type()} {os.release()}
当前日期: {YYYY-MM-DD}
当前时间: {ISO timestamp}
</environment>
```

值在 chat 初始化、构建主 system message 时生成，不会每轮刷新。长时间存活的 chat 中，该时间代表初始化时间，不代表每次请求时间。

### 4. Workspace 与 VCS

Preset 配置了 `workspace` 时注入：

```text
<workspace>
当前工作区: {workspace}
本会话用于开发该项目，文件操作与命令以此目录为基准。
{VCS 信息；检测成功时}
</workspace>
```

Workspace 从 preset 写入 chat metadata，子 chat 继承主 chat workspace。VCS 信息由 [src/utils/vcs.ts](../src/utils/vcs.ts) 检测并格式化。

该段同时是角色文件范围检查与 `execute_command` OS 沙箱的工作区根。命令的 `workdir` 必须位于其中；没有有效工作区时命令执行会 fail closed。

### 5. Memory

Memory 分两层：

- `global`：所有 chat 共享的用户习惯、事实和准则。
- `workspace`：按 workspace 路径 hash 隔离的项目记忆。

只有对应 `main.md` 存在且有内容时才注入 `<memory>` 段。Prompt 构建时只读取活跃索引内容，不把全部记忆详情文件直接展开进 system prompt。

Memory 在 chat 初始化时注入一次，不随本轮 `memory_manage` 写入自动刷新。主 agent 的 runtime 会额外获得 `memory_manage` Sense；子 agent 默认不注入该工具，但仍可能看到初始化时已有的 memory 文本。

存储、淘汰和 scope 规则见 [Memory](./memory/README.md)。

### 6. Skills

`<skills>` 只包含发现信息：

```text
<skill name="{effectiveName}">
{description}
触发条件: {trigger}        # SKILL.md 配置 trigger 时才出现
</skill>
```

不会预注入完整 SKILL.md 正文。模型判断需要使用某项技能后，通过 `skill` Sense 调用 `getSkillRealtime(name)`，再把完整正文作为工具结果加入对话。

发现来源：

- 独立 Skill：`.chery/skills/<name>/SKILL.md`。
- 插件 Skill：`.chery/plugins/<plugin>/skills/<skill>/SKILL.md` 等受支持布局。
- 插件对外名称：`<plugin>__<skill>`。

角色可通过 `skills` 和 `plugins` 生成 `SkillFilter`，只裁剪 system prompt 中的 `<skills>` 元数据。该过滤不限制 `getSkillRealtime()` 的运行时查找能力；未列出的 Skill 只是不会被主动告知模型。

完整扫描、frontmatter 和 token 规则见 [Agent Prompt](./agent/prompt.md)。

## 不属于主 system prompt 的提示信息

### Tool / Sense schemas

Sense 描述不拼进 `buildFirstSystemPrompt()`。`RuntimeResolver` 根据当前 `brain + senseGroup + mcpServers` 构建：

- `builtSenses`：传给 LLM Provider 的 function schemas。
- `senseTable`：服务端执行器和监管等级映射。

主 agent 额外注入 `memory_manage`；子 agent 排除。MCP server 暴露的 Sense 也合并到 `builtSenses`，但仍通过 `tools` 字段发送。

OpenAI 兼容请求形态：

```ts
client.chat.completions.create({
  model,
  messages,
  tools: builtSenses,
})
```

详见 [Agent Sense](./agent/sense.md)、[Core Sense](./core/sense.md) 和 [Provider](./agent/provider.md)。

### Command 正文

`.chery/command/<name>.md` 不预注入 system prompt。用户或自动压缩触发 `[[command:/<name>]]` 时，send 预检路径实时读取正文，并作为独立 user message 排在当前 user message 之前：

```text
command instruction user message
→ current user message
```

Skill token 与 Command token 的处理不同：

- Skill token：后端不加载正文；模型根据 `<skills>` 元数据调用 `skill` Sense。
- Builtin Command token：后端读取 `.chery/command/<name>.md`，作为一次性 user message 入队。

完整触发与压缩流程见 [Command](./agent/command.md)。

### 媒体能力提示

本轮最后一条 user message 含 `[[media:<filename>]]` 时，Chat Middleware 根据当前 brain 的输入能力临时构建：

```text
<self-capabilities>
当前大脑、image/video/audio 输入能力、不可处理附件和可委派角色
</self-capabilities>
```

该提示作为额外 system message **前置到本轮消息数组**，不写入 `ctx.soul.messages`，不持久化到 DB。普通文本对话不生成该段。

媒体二进制附件或网关理解文本也在 Chat Middleware 临时构建，详见 [Model Capabilities](./model-capabilities.md)。

### 对话压缩摘要

基础 system message不持久化。服务重启或重新创建 chat runtime 时，`ensureChat()` 从 DB 加载历史：

- 无压缩边界：加载全部有效历史。
- 有压缩边界：把最后一条压缩摘要转换为额外 system message，只加载该摘要之后的消息。

`AgentBuilder.init()` 始终在历史前重新插入当前主 system message，因此压缩恢复后的顺序为：

```text
主 system message
→ 压缩摘要 system message
→ 压缩点后的历史消息
```

如果本轮还有媒体能力提示，它会临时排在上述消息之前。

## 端到端生成链路

```text
chat.create / spawn_role
  → 解析 preset 或 role
       ├─ runtime selection：brain + senseGroup + mcpServers
       ├─ systemPromptFile
       ├─ workspace
       └─ skillFilter
  → 上述值快照到 chat metadata

ensureChat(chatId)
  ├─ RuntimeResolver.resolve()
  │    ├─ brain + Provider adapters
  │    ├─ Sense group
  │    ├─ MCP senses
  │    └─ main agent memory_manage
  ├─ loadHistory()
  │    └─ 必要时恢复压缩摘要 system message
  └─ AgentBuilder.init()
       └─ buildFirstSystemPrompt(systemPromptFile, workspace, skillFilter)
            ├─ global base
            ├─ 角色 systemPromptFile 补充
            ├─ environment
            ├─ workspace + VCS
            ├─ global/workspace memory
            └─ skills metadata

chat.send
  ├─ injectCommands() → command user messages
  ├─ AgentSession.send() → 当前 user message 入队
  └─ chatMiddleware
       ├─ enrichMediaInputs() → 临时 self-capabilities system message / attachments
       ├─ messageAdapter.buildMessages()
       └─ llmAdapter.chat/chatStream(messages, builtSenses, options)
```

关键实现：

- 主 Prompt 组装：[src/agent/prompt/index.ts](../src/agent/prompt/index.ts)。
- 首条 system message 创建：[src/agent/builder.ts](../src/agent/builder.ts)。
- Preset/Role 解析：[src/agent/runtimeResolver.ts](../src/agent/runtimeResolver.ts)。
- metadata、历史和压缩摘要恢复：[src/service/chat/runtime.ts](../src/service/chat/runtime.ts)。
- 媒体能力临时注入：[src/agent/middleware/chat.ts](../src/agent/middleware/chat.ts)。
- Command 注入：[src/service/chat/autoCompact.ts](../src/service/chat/autoCompact.ts)。
- Provider 最终请求：[src/agent/provider/](../src/agent/provider/)。

## 生命周期与更新时机

| 内容 | 更新时机 | 存量内存 chat 是否立即生效 |
|------|----------|---------------------------|
| 全局 `system.md` | 进程启动/模块加载 | 否；需重启重建 |
| 角色 override | chat runtime 初始化 | 否；需重建 chat runtime |
| Environment | chat runtime 初始化 | 否 |
| Workspace/VCS | chat runtime 初始化 | 否 |
| Memory 文本 | chat runtime 初始化 | 否；本轮写入不回填首条 system |
| Skills 元数据 | chat runtime 初始化时扫描 | 否；新 chat/runtime 重建后生效 |
| Sense/MCP schemas | runtime 配置或 stale 重建 | 可在下一次 send 前重建 |
| Command 正文 | 每次触发时实时读取 | 是 |
| 媒体能力提示 | 每次含媒体标记的 LLM 调用 | 是，仅当轮 |

基础 system message不写入 DB；它属于 runtime 内存状态。重启后 `AgentBuilder.init()` 使用当前文件和 metadata 重新生成，因此存量 chat 会在重启恢复时拾取新的基础提示词、override、Memory 和 Skills 元数据。

## 上下文计量

`buildSystemPromptSegments()` 与 `buildFirstSystemPrompt()` 共用 `buildPromptPieces()`，避免生成逻辑与 token 展示使用两套来源。计量时拆成：

1. 系统提示词：全局 base + Environment + Workspace。
2. 用户系统提示词：角色 override。
3. Memory。
4. Skills。
5. Tool definitions。
6. 用户对话。

分段是计量视图，不代表 Provider 最终一定收到六条独立消息。实际主 system message 仍按本文开头的固定结构合并为一条。

## 排查某个 chat 的实际输入

按以下顺序检查，避免只看 `.chery/prompt/system.md`：

1. 查 chat metadata 中的 `systemPromptFile`、`workspace`、`skillFilter` 和 `runtime`。
2. 查全局 `.chery/prompt/system.md`。
3. 查 systemPromptFile 对应文件。
4. 查 global/workspace memory 的 `main.md` 是否存在且有内容。
5. 用相同 `skillFilter` 查看当前可发现 Skill。
6. 查 runtime 的 sense group、MCP servers 和是否为主 agent，确认 `tools`。
7. 查历史是否存在 `context_compaction` 边界。
8. 查本轮 user message 是否含 Command 或 Media 标记。

仅检查首条 system message不能还原完整 LLM 输入；还需同时检查额外 system/user messages 和 `tools`。

## 修改入口

| 目标 | 修改入口 |
|------|----------|
| 修改所有 Agent 的基础行为 | `.chery.template/prompt/system.md`，并同步运行目录 `.chery/prompt/system.md` |
| 修改某角色行为 | 对应 role 的 prompt 文件 + `roles.<type>.systemPrompt` |
| 修改主 Agent 选用角色 | `presets.<name>.leader` |
| 修改项目上下文 | `presets.<name>.workspace` |
| 修改长期记忆 | `memory_manage` 或 Memory 文件 |
| 修改 Skill 发现提示 | `SKILL.md` frontmatter 的 name/description/trigger |
| 修改 Skill 完整执行规范 | `SKILL.md` 正文 |
| 修改一次性内置指令 | `.chery.template/command/<name>.md`，并同步运行目录 |
| 修改工具名称、描述、参数 | 对应 Sense 定义 |
| 修改主 Prompt XML 结构或顺序 | [src/agent/prompt/index.ts](../src/agent/prompt/index.ts) |
| 修改媒体能力临时提示 | [src/agent/middleware/chat.ts](../src/agent/middleware/chat.ts) |

## 相关文档

- [Agent Prompt](./agent/prompt.md)：Prompt 模块、Skill 扫描、过滤和 token 计量细节。
- [Command](./agent/command.md)：Builtin Command 注入与自动压缩。
- [Memory](./memory/README.md)：双层 Memory 存储和管理。
- [Agent Sense](./agent/sense.md)：内置 Sense 和工具 schema。
- [Core Sense](./core/sense.md)：Sense 工厂与监管等级。
- [Agent Middleware](./agent/middleware.md)：消息进入 Provider 前的执行链。
- [Provider](./agent/provider.md)：Provider 消息转换和最终 API 请求。
- [Model Capabilities](./model-capabilities.md)：媒体能力与附件处理。
- [Service Chat](./service/chat.md)：chat 生命周期、observer 和持久化边界。
