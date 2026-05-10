# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

cheryClaw 是一个多 LLM Agent 框架，支持 Ollama、OpenAI 等提供商。核心特性：Tool 调用监管、流式响应、两阶段执行、Prompt 系统与 Skills 加载。

## 常用命令

```bash
yarn dev          # 开发模式（nodemon + tsx 热重载）
yarn build        # esbuild 打包到 dist/
yarn start        # 运行编译产物
```

开发时无需编译验证，`yarn dev` 自动重载，人工验证即可。

## 目录结构

```text
src/
├── agent/        # Agent Builder 模式
├── llm/          # LLM Adapter 抽象层
├── message/      # 消息格式适配器
├── middleware/   # 洋葱模型中间件（核心）
├── prompt/       # Prompt 构建系统 + Skills 加载
├── provider/     # Provider 注册（openai/ollama）
├── skills/       # 技能定义目录
├── tool/         # 工具定义与适配器
└── config.ts     # YAML 配置加载 + 环境变量替换
```

## 架构设计模式

### Middleware 模式 - 洋葱模型（核心）

[middleware/index.ts](src/middleware/index.ts) 组合中间件链：

```text
请求 → Message → Tool → Chunk → Chat → LLM
响应 ← Message ← Tool ← Chunk ← Chat ← LLM
```

执行顺序：`compose([messageMiddleware, toolMiddleware, chunkMiddleware, chatMiddleware])`

每个中间件是 Generator，支持：

- 流式 yield `StreamChunk`
- 两阶段中断 yield `InterruptChunk`
- 阶段性结果 yield `StagedChunk`
- 完成 yield `DoneChunk`

### Builder 模式 - Agent 配置

[builder.ts](src/agent/builder.ts) 提供链式配置：

```ts
createAgent().use("longcat").build()
```

工具自动从 `config.yaml` 的 `tool_group` 配置加载。

**可选配置**：

- `setSessionId(id)`: 自定义会话 ID（默认 UUID）
- `setWorkDir(dir)`: 设置工具执行工作目录（默认 `process.cwd()`）

### Adapter 模式 - 三层适配

- **消息适配器** [message/adapter.ts](src/message/adapter.ts): 统一响应格式（role/content/thinking/toolCalls）
- **工具适配器** [tool/adapter.ts](src/tool/adapter.ts): 统一工具定义和调用格式
- **Provider 适配器** [llm/adapter.ts](src/llm/adapter.ts): 统一 chat/chatStream 接口

### 工厂模式 - Provider 注册

[builder.ts](src/agent/builder.ts) 内 `providerRegistry` 映射 provider 名称到注册函数，与 config.yaml `provider` 字段对应。

## 核心流程

### MiddlewareContext 数据结构

核心上下文对象包含八个分组（参见 [middleware/types.ts](src/middleware/types.ts)）：

| 分组 | 职责 |
| ---- | ---- |
| `session` | sessionId/threadId/loadedSkills |
| `global` | 全局配置（thinking/supervision/stream/timeout） |
| `config` | 当前客户端配置（model/provider/tool_group） |
| `adapters` | LLM/Message/Tool Adapter 实例 |
| `process` | history/累积状态/toolCallAccumulated Map |
| `tools` | ToolManager 实例 |

### 中间件职责分工

| 中间件 | 职责 |
| ------ | ---- |
| [message.ts](src/middleware/handler/message.ts) | 消息累积、历史构建、创建用户消息、tool 结果累积、触发重试 |
| [tool.ts](src/middleware/handler/tool.ts) | 工具执行循环、两阶段确认中断、监管等级判断 |
| [chunk.ts](src/middleware/handler/chunk.ts) | 流式响应累积、工具调用增量累积、非流式 toolCall 提取 |
| [chat.ts](src/middleware/handler/chat.ts) | 调用 LLM Adapter、发起 LLM 请求、流式/非流式切换 |

### 两阶段执行（Tool 监管）

`toolMiddleware` 根据 `SupervisionLevel` 决定执行策略：

- `auto` (0): 自动执行，无需确认
- `confirm` (1): yield `InterruptChunk`，等待 `confirmToolCall()`
- `manual` (2): 禁止自动执行，仅手动触发

配置路径：

- Tool 定义: `tool()` 函数的 `supervisionLevel` 参数

- 客户端配置: `config.yaml` → `tool_groups.*.auto_execute_level`

- 全局配置: `config.yaml` → `global.supervision`（默认监管等级）

**监管等级生效逻辑**：

1. 优先使用 Tool 定义中显式指定的 `supervisionLevel`

2. 若未指定，使用全局默认 `global.supervision`

3. 流式模式下不支持 `confirm/manual`，自动降级为 `auto`

### RetryState 机制（已废弃）

**注意**: 当前架构已改用 Loop 执行机制，不再使用 RetryState。

### Loop 执行机制（当前实现）

[middleware/index.ts](src/middleware/index.ts) 的 `send()` 方法实现循环执行：

```text
while (条件满足) {
  执行中间件链 → 检查结果 → 决定是否继续
}
```

**继续条件**：

- `toolCallAccumulated.size > 0`: 有待执行 tool_calls

- 最后消息是 `tool`: 刚执行完工具

- 最后消息是 `assistant` 且有 `toolCalls`: 工具已执行完毕

**停止条件**：

- 最后消息是 `assistant` 且无 `toolCalls`

- 最后消息是 `user` 或 `system`

**队列机制**: 同 threadId 并发请求排队处理，防止状态冲突。

### Thread 管理

每个 Middleware 实例维护 `thread` Map：

- `createThread()`: 创建新 threadId，初始化 context

- 创建时自动注入系统 prompt（`buildPrompt()` 结果）

- 每个 threadId 独立队列状态（防止并发冲突）

### 消息累积

[MessageAdapter](src/message/adapter.ts) 类的 `accumulate()` 方法：

- 内存存储：`messageStore` 数组（sessionId 级别）

- 同 threadId 消息更新而非追加，支持多轮对话

### 流式响应（Tool Call 累积）

`chunkMiddleware` 处理流式响应：

- 累积 `thinkingDelta`/`delta` 到 `ctx.thinkingAccumulated`/`ctx.accumulated`

- 累积工具调用增量到 `ctx.toolCallAccumulated` Map

- 流式模式下工具调用自动执行（不支持两阶段确认）

## Prompt 系统

[prompt/index.ts](src/prompt/index.ts) 构建完整 prompt，包含：

- **系统 prompt**: [prompt/system.md](src/prompt/system.md)

- **Skills 加载**: 自动扫描 `src/skills/*/SKILL.md`，解析 frontmatter

输出格式：

```xml
<system>系统 prompt</system>
<skills>技能列表</skills>
<user>用户输入</user>
```

### Skills 定义格式

在 `src/skills/<name>/SKILL.md` 中定义：

```markdown
---
name: skill_name
description: 技能描述
---

# skill_name
详细说明...
```

frontmatter 由 `prompt/index.ts` 解析，注入到 prompt 中。

## 配置系统

- `config.yaml`: LLM 客户端配置 + Tool 分组配置

- `$ENV_VAR_NAME` 语法引用环境变量（由 [config.ts](src/config.ts) 替换）

- `.env`: 存储 API 密钥等敏感信息

- 环境变量缺失时仅警告，不阻断启动（参见 [config.ts:79-80](src/config.ts#L79-L80)）

### Tool Group 配置

`tool_group` 支持**单个或多个工具组**：

```yaml
# 单组
tool_group: safe_tools

# 多组（工具去重：后加载覆盖前加载）
tool_group: [safe_tools, dangerous_tools]
```

重复工具名会触发警告并覆盖（参见 [builder.ts:116-126](src/agent/builder.ts#L116-L126)）。

## TypeScript 配置

- ESM 模块（`"type": "module"`）

- 严格模式: `noUncheckedIndexedAccess`

- bundler 模块解析（配合 esbuild/tsx）

- 路径别名: `@/*` 映射到 `src/*`

## 添加新 LLM Provider

1. 创建 `src/llm/newprovider.ts`，继承 `BaseLLMClient`

2. 实现 `_buildMessages`/`chat`/`chatStream` 抽象方法

3. 注册消息适配器: `registerAdapter("newprovider", { role, content, ... })`

4. 注册工具适配器: 在 [tool/adapter.ts](src/tool/adapter.ts) 调用 `registerToolAdapter("newprovider", { ... })`

5. 在 [llm/index.ts](src/llm/index.ts) 导出工厂函数

6. 在 `config.yaml` 添加客户端配置，`provider` 字段设为 `"newprovider"`

## 添加新 Tool

使用 [toolCreator.ts](src/tool/base/toolCreator.ts) 的 `tool()` 函数：

```ts
export const myTool = tool(
  "my_tool",                    // 名称
  "描述工具功能",                 // 描述
  z.object({ path: z.string() }), // Zod schema
  async ({ path }) => "...",     // 执行函数
  SupervisionLevel.confirm       // 监管等级（可选）
);
```

## 添加新 Skill

1. 创建 `src/skills/<skill_name>/` 目录

2. 添加 `SKILL.md` 文件，包含 frontmatter（name/description）

3. prompt 系统自动加载并注入

## 测试文件

`test/` 目录包含临时测试脚本，非正式测试套件。
