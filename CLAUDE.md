# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

cheryClaw 是一个多 LLM Agent 框架，支持 Ollama、OpenAI 等提供商。核心特性：Tool 调用监管、流式响应、两阶段执行。

## 常用命令

```bash
yarn dev          # 开发模式（nodemon + tsx 热重载）
yarn build        # esbuild 打包到 dist/
yarn start        # 运行编译产物
```

开发时无需编译验证，`yarn dev` 自动重载，人工验证即可。

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
- 完成 yield `DoneChunk`

### Builder 模式 - Agent 配置

[builder.ts](src/agent/builder.ts) 提供链式配置：

```ts
createAgent().use("longcat").bindTools(readTool).build()
```

### Adapter 模式 - 三层适配

- **消息适配器** [message/adapter.ts](src/message/adapter.ts): 统一响应格式（role/content/thinking/toolCalls）
- **工具适配器** [tool/adapter.ts](src/tool/adapter.ts): 统一工具定义和调用格式
- **Provider 适配器** [llm/adapter.ts](src/llm/adapter.ts): 统一 chat/chatStream 接口

### 工厂模式 - Provider 注册

[builder.ts](src/agent/builder.ts) 内 `providerRegistry` 映射 provider 名称到注册函数，与 config.yaml `provider` 字段对应。

## 核心流程

### 中间件职责分工

| 中间件 | 职责 |
| ------ | ---- |
| [message.ts](src/middleware/message.ts) | 消息累积、历史构建、创建用户消息 |
| [tool.ts](src/middleware/tool.ts) | 工具执行循环、两阶段确认中断、监管等级判断 |
| [chunk.ts](src/middleware/chunk.ts) | 流式响应累积、工具调用增量累积 |
| [chat.ts](src/middleware/chat.ts) | 调用 LLM Adapter、发起 LLM 请求 |

### 两阶段执行（Tool 监管）

`toolMiddleware` 根据 `SupervisionLevel` 决定执行策略：

- `auto` (0): 自动执行，无需确认
- `confirm` (1): yield `InterruptChunk`，等待 `confirmToolCall()`
- `manual` (2): 禁止自动执行，仅手动触发

配置路径：

- Tool 定义: `tool()` 函数的 `supervisionLevel` 参数
- 客户端配置: `config.yaml` → `tool_groups.*.auto_execute_level`

### 消息累积

[MessageAdapter](src/message/adapter.ts) 类的 `accumulate()` 方法：

- 内存存储：`messageStore` 数组（sessionId 级别）
- 同 threadId 消息更新而非追加，支持多轮对话

### 流式响应（Tool Call 累积）

`chunkMiddleware` 处理流式响应：

- 累积 `thinkingDelta`/`delta` 到 `ctx.thinkingAccumulated`/`ctx.accumulated`
- 累积工具调用增量到 `ctx.toolCallAccumulated` Map
- 流式模式下工具调用自动执行（不支持两阶段确认）

## 配置系统

- `config.yaml`: LLM 客户端配置 + Tool 分组配置
- `$ENV_VAR_NAME` 语法引用环境变量（由 [config.ts](src/config.ts) 替换）
- `.env`: 存储 API 密钥等敏感信息

## TypeScript 配置

- ESM 模块（`"type": "module"`）
- 严格模式: `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`
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

## 测试文件

`test/` 目录包含临时测试脚本，非正式测试套件。
