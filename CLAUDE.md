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
├── core/                    # 核心架构层（框架抽象）
│   ├── config.ts            # SupervisionLevel 监管等级枚举
│   ├── llm/                 # LLM Adapter 注册与获取
│   │   ├── adapter.ts       # LLM Adapter 注册表
│   │   └── index.ts         # 导出
│   ├── message/             # Message Adapter 抽象
│   │   ├── adapter.ts       # LLMResponse 类型 + MessageAdapter 类
│   │   └── index.ts         # 导出
│   ├── middleware/          # 中间件核心（洋葱模型）
│   │   ├── compose.ts       # 中间件组合器
│   │   ├── types.ts         # MiddlewareContext/Chunk 类型定义
│   │   ├── utils.ts         # HistoryProxy 创建
│   │   └── index.ts         # Middleware 类（接收 handlers 参数）
│   ├── prompt/              # Prompt 构建系统
│   │   ├── index.ts         # buildFirstSystemPrompt()
│   │   ├── loadSkill.ts     # Skills 加载与解析
│   │   └── system.md        # 系统 prompt 模板
│   └── tool/                # Tool 核心抽象
│       ├── toolCreator.ts   # tool() 工厂函数
│       ├── toolManager.ts   # ToolManager 类
│       ├── adapter.ts       # ToolAdapter 注册表
│       └── index.ts         # 导出
│
├── agent/                   # Agent 层（具体实现）
│   ├── builder.ts           # AgentBuilder 类
│   ├── index.ts             # 入口文件
│   ├── middleware/          # 中间件实现
│   │   ├── index.ts         # 导出 handlers + Middleware
│   │   ├── message.ts       # 消息累积中间件
│   │   ├── tool.ts          # 工具执行中间件
│   │   ├── chunk.ts         # 流式响应处理中间件
│   │   └── chat.ts          # LLM 调用中间件
│   ├── tool/                # 工具实现
│   │   ├── index.ts         # 工具注册表 + 导出
│   │   ├── bash.ts          # execute_command 工具
│   │   ├── read.ts          # read_file 工具
│   │   ├── write.ts         # write_file 工具
│   │   └── skill.ts         # Skill 激活工具
│   ├── provider/            # Provider 注册
│   │   ├── openai.ts        # OpenAI Adapter 注册
│   │   └── ollama.ts        # Ollama Adapter 注册
│   └── skills/              # 技能定义目录
│       └── <name>/SKILL.md  # 技能定义文件
│
├── utils/                   # 工具函数（core 和 agent 共用）
│   ├── env.ts               # 环境信息管理
│   └── hash.ts              # Hash 生成
│
├── config.ts                # YAML 配置加载 + 环境变量替换
│
└── test/                    # 临时测试脚本
```

## 架构分层

### Core 层（框架抽象）

**Core 层** (`src/core/`): 框架抽象，不含具体实现
- 类型定义（LLMResponse、MiddlewareContext、ToolCallData）
- Adapter 注册表（静态 Map + register/get 函数）
- Middleware 类（接收 handlers 参数，不硬编码引用）
- Tool 工厂函数（tool()、ToolManager）

### Agent 层（具体实现）

**Agent 层** (`src/agent/`): 具体实现，可直接使用
- AgentBuilder（链式配置）
- 中间件实现（message/tool/chunk/chat）
- 工具实现（bash/read/write/skill）
- Provider Adapter 实现（OpenAI/Ollama）
- 技能定义（skills 目录）

### 共用层

**共用层** (`src/utils/`、`src/config.ts`): Core 和 Agent 都需要访问
- 环境信息管理（env.ts）
- Hash 生成（hash.ts）
- YAML 配置加载（config.ts）

## 架构设计模式

### Middleware 模式 - 洋葱模型（核心）

[core/middleware/index.ts](src/core/middleware/index.ts) Middleware 类接收 handlers 参数：

```ts
new Middleware(
  sessionId,
  global,
  config,
  toolManager,
  adapters,
  handlers,  // 由 Agent 层提供
);
```

执行顺序：`compose([messageMiddleware, toolMiddleware, chunkMiddleware, chatMiddleware])`

每个中间件是 Generator，支持：
- 流式 yield `StreamChunk`
- 两阶段中断 yield `InterruptChunk`
- 阶段性结果 yield `StagedChunk`
- 完成 yield `DoneChunk`

### Builder 模式 - Agent 配置

[agent/builder.ts](src/agent/builder.ts) 提供链式配置：

```ts
createAgent().use("longcat").build()
```

工具自动从 `config.yaml` 的 `tool_group` 配置加载。

**可选配置**：
- `setSessionId(id)`: 自定义会话 ID（默认 UUID）
- `setWorkDir(dir)`: 设置工具执行工作目录（默认 `process.cwd()`）

### Adapter 模式 - 三层适配

- **消息适配器** [core/message/adapter.ts](src/core/message/adapter.ts): 统一响应格式（role/content/thinking/toolCalls）
- **工具适配器** [core/tool/adapter.ts](src/core/tool/adapter.ts): 统一工具定义和调用格式
- **LLM 适配器** [core/llm/adapter.ts](src/core/llm/adapter.ts): 统一 chat/chatStream 接口

### 工厂模式 - Provider 注册

[agent/builder.ts](src/agent/builder.ts) 内 `providerRegistry` 映射 provider 名称到注册函数，与 config.yaml `provider` 字段对应。

## 核心流程

### MiddlewareContext 数据结构

核心上下文对象包含六个分组（参见 [core/middleware/types.ts](src/core/middleware/types.ts)）：

| 分组 | 职责 |
| ---- | ---- |
| `session` | sessionId/threadId/hashCheck |
| `global` | 全局配置（thinking/supervision/stream/timeout/maxLoopCount） |
| `config` | 当前客户端配置（model/provider/tool_group） |
| `adapters` | LLM/Message/Tool Adapter 实例 |
| `process` | history/累积状态/toolCallAccumulated Map/pendingInputs |
| `tools` | ToolManager 实例 |

### 中间件职责分工

| 中间件 | 职责 |
| ------ | ---- |
| [agent/middleware/message.ts](src/agent/middleware/message.ts) | 消息累积、历史构建、创建用户消息、tool 结果累积 |
| [agent/middleware/tool.ts](src/agent/middleware/tool.ts) | 工具执行循环、两阶段确认中断、监管等级判断 |
| [agent/middleware/chunk.ts](src/agent/middleware/chunk.ts) | 流式响应累积、工具调用增量累积、非流式 toolCall 提取 |
| [agent/middleware/chat.ts](src/agent/middleware/chat.ts) | 调用 LLM Adapter、发起 LLM 请求、流式/非流式切换 |

### 两阶段执行（Tool 监管）

`toolMiddleware` 根据 `SupervisionLevel` 决定执行策略：

- `auto` (0): 自动执行，无需确认
- `confirm` (1): yield `InterruptChunk`，等待确认
- `manual` (2): 禁止自动执行，仅手动触发

配置路径：
- Tool 定义: `tool()` 函数的 `supervisionLevel` 参数
- 客户端配置: `config.yaml` → `tool_groups.*.auto_execute_level`
- 全局配置: `config.yaml` → `global.supervision`（默认监管等级）

### Loop 执行机制

[core/middleware/index.ts](src/core/middleware/index.ts) 的 `send()` 方法实现循环执行：

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

### Thread 管理

每个 Middleware 实例维护 `thread` Map：
- `createThread()`: 创建新 threadId，初始化 context
- 创建时自动注入系统 prompt（`buildPrompt()` 结果）
- 每个 threadId 独立队列状态（防止并发冲突）

## Prompt 系统

[core/prompt/index.ts](src/core/prompt/index.ts) 构建完整 prompt，包含：

- **系统 prompt**: [core/prompt/system.md](src/core/prompt/system.md)
- **Skills 加载**: 自动扫描 `src/agent/skills/*/SKILL.md`，解析 frontmatter
- **环境信息**: 工作目录、操作系统、当前日期时间

输出格式：

```xml
<system-reminder>系统 prompt</system-reminder>
<environment>环境信息</environment>
<skills>技能列表</skills>
```

### Skills 定义格式

在 `src/agent/skills/<name>/SKILL.md` 中定义：

```markdown
---
name: skill_name
description: 技能描述
---

# skill_name
详细说明...
```

frontmatter 由 [core/prompt/loadSkill.ts](src/core/prompt/loadSkill.ts) 解析，注入到 prompt 中。

## 配置系统

- `config.yaml`: LLM 客户端配置 + Tool 分组配置
- `$ENV_VAR_NAME` 语法引用环境变量（由 [config.ts](src/config.ts) 替换）
- `.env`: 存储 API 密钥等敏感信息
- 环境变量缺失时仅警告，不阻断启动

### Tool Group 配置

`tool_group` 支持单个或多个工具组：

```yaml
# 单组
tool_group: safe_tools

# 多组（工具去重：后加载覆盖前加载）
tool_group: [safe_tools, dangerous_tools]
```

## TypeScript 配置

- ESM 模块（`"type": "module"`）
- 严格模式: `noUncheckedIndexedAccess`
- bundler 模块解析（配合 esbuild/tsx）
- 路径别名: `@/*` 映射到 `src/*`

## 添加新 LLM Provider

1. 创建 `src/agent/provider/newprovider.ts`
2. 定义 Message Adapter 配置（role/content/thinking/buildMessages）
3. 定义 Tool Adapter 配置（buildTools/extractToolCalls/assembleToolCallChunks）
4. 定义 LLM Adapter（chat/chatStream）
5. 创建注册函数并导出
6. 在 [agent/builder.ts](src/agent/builder.ts) 的 `providerRegistry` 中注册
7. 在 `config.yaml` 添加客户端配置，`provider` 字段设为 `"newprovider"`

## 添加新 Tool

使用 [core/tool/toolCreator.ts](src/core/tool/toolCreator.ts) 的 `tool()` 函数：

```ts
export default tool(
  "my_tool",                    // 名称
  "描述工具功能",                 // 描述
  z.object({ path: z.string() }), // Zod schema
  async ({ path }) => "...",     // 执行函数
  SupervisionLevel.confirm       // 监管等级（可选）
);
```

在 `src/agent/tool/` 目录创建文件，工具会自动被 [agent/tool/index.ts](src/agent/tool/index.ts) 加载。

## 添加新 Skill

1. 创建 `src/agent/skills/<skill_name>/` 目录
2. 添加 `SKILL.md` 文件，包含 frontmatter（name/description）
3. prompt 系统自动加载并注入

## 添加新中间件

1. 在 `src/agent/middleware/` 目录创建新的中间件文件
2. 实现 `MiddlewareHandler` 类型签名
3. 在 [agent/middleware/index.ts](src/agent/middleware/index.ts) 的 `defaultHandlers` 数组中添加

## 测试文件

`test/` 目录包含临时测试脚本，非正式测试套件。

# currentDate
Today's date is 2026/05/11.