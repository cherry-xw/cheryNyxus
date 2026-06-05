# cheryClaw 项目规范

## 项目概述

多 LLM Agent 框架，支持 Ollama、OpenAI 等提供商。核心特性：Tool 调用监管、流式响应、两阶段执行、Prompt 系统与 Skills 加载。

## 常用命令

```bash
yarn dev          # 开发模式（vite build --ssr --watch + nodemon）
yarn build        # Vite 8 SSR 打包到 dist/
yarn start        # 运行编译产物
yarn test         # 运行测试（vitest）
yarn test:watch   # 测试监听模式
```

> 当前测试套件存在预存问题，后续统一修复。开发阶段仅关注 TSC 类型检查通过。

## 目录结构

```text
.chery/                      # 外置配置（不走打包，运行时读取）
├── config.yaml              # LLM 客户端 + Tool 分组 + 全局配置
├── system.md                # 系统 prompt 模板
├── skills/<name>/SKILL.md   # 技能定义
└── tools/<name>.ts          # 外部自定义工具

src/
├── index.ts                 # 入口：WebSocket 服务 / compile-tools 子命令
├── core/                    # 框架抽象（不含具体实现）
│   ├── config.ts            # SupervisionLevel 枚举
│   ├── llm/                 # LLM Adapter 注册表
│   ├── message/             # Message Adapter 抽象
│   ├── middleware/          # 中间件核心（洋葱模型）
│   │   ├── compose.ts       # 中间件组合器
│   │   ├── types.ts         # 类型定义
│   │   └── index.ts         # Middleware 类
│   ├── prompt/              # Prompt 构建 + Skills 加载
│   └── tool/                # Tool 核心（工厂、注册表、编译器、ToolManager）
├── agent/                   # 具体实现
│   ├── builder.ts           # AgentBuilder 链式配置
│   ├── middleware/           # 中间件实现（checkpoint/chat/tool/retry/loop）
│   ├── tool/                # 内置工具（bash/read/write/skill）
│   └── provider/            # Provider 注册（OpenAI/Ollama）
├── service/                 # 服务层（WebSocket、会话管理、中断恢复）
│   ├── agent/               # Agent 生命周期、执行、中断、恢复
│   ├── message/             # 消息路由
│   └── websocket/           # WebSocket 连接管理
├── db/                      # 数据持久化（checkpoint、session、interrupt、thread）
└── utils/                   # 工具函数
    ├── config.ts            # YAML 配置加载 + 环境变量替换
    ├── hash.ts              # Hash 生成
    ├── drain/               # Drain 日志模板挖掘算法
    └── logger/              # 日志管理

test/                        # 测试套件（vitest），结构镜像 src/
```

## 架构分层

| 层 | 路径 | 职责 |
|----|------|------|
| Core | `src/core/` | 框架抽象：类型、Adapter 注册表、Middleware 类、Tool 工厂 |
| Agent | `src/agent/` | 具体实现：Builder、中间件、工具、Provider |
| Service | `src/service/` | 服务层：WebSocket、会话、中断恢复 |
| DB | `src/db/` | 数据持久化：checkpoint、session |
| Utils | `src/utils/` | 共用工具函数 |
| 配置 | `.chery/` | 运行时配置，不走打包。路径通过 `CHERY_DIR` 环境变量指定 |

## 核心设计模式

### Middleware - 洋葱模型

[core/middleware/index.ts](src/core/middleware/index.ts) Middleware 类接收 handlers 参数：

```ts
new Middleware(sessionId, global, aiServerConfig, toolManager, adapters, handlers, loopHandler?, builtTools?)
```

Handler 执行顺序（由外到内）：`checkpointMiddleware → chatMiddleware → toolMiddleware → retryMiddleware`

每个中间件是 Generator，通过 yield 传递 chunk 类型：`StreamChunk | ToolTriggerChunk | ToolCompleteChunk | StagedChunk | ErrorChunk | DoneChunk`

### MiddlewareContext

参见 [core/middleware/types.ts](src/core/middleware/types.ts)：

| 分组 | 职责 |
|------|------|
| `session` | sessionId/threadId/hashCheck/toolSharedData/userInputs/builtTools/messages |
| `global` | 全局配置（thinking/supervision/stream/maxLoopCount） |
| `aiServer` | 客户端配置（model/provider/url/key） |
| `adapters` | LLM/Message/Tool Adapter 实例 |
| `toolManager` | ToolManager 实例 |

### Builder - Agent 配置

[agent/builder.ts](src/agent/builder.ts)：`createAgent().use("longcat").build()`

`build()` 阶段预构建 tools（`toolAdapter.buildTools()`），存入 `ctx.session.builtTools`，避免每次迭代重复构建。

### Adapter - 三层适配

- **Message** [core/message/adapter.ts](src/core/message/adapter.ts)：统一响应格式
- **Tool** [core/tool/adapter.ts](src/core/tool/adapter.ts)：统一工具定义和调用格式
- **LLM** [core/llm/adapter.ts](src/core/llm/adapter.ts)：统一 chat/chatStream 接口

### Loop 执行

[agent/middleware/loop.ts](src/agent/middleware/loop.ts) `createLoopHandler` 循环执行中间件链，直到最后消息为 assistant 且无 toolCalls。

### Thread 管理

Middleware 维护 `threadMap`（Map<string, MiddlewareContext>）：
- `createThread(threadId)`：初始化 context（含 system 消息）
- `send(threadId, input)`：注入 userInputs，执行 chain，支持活跃 generator 复用

## 中间件职责

| 中间件 | 职责 |
|--------|------|
| [checkpoint.ts](src/agent/middleware/checkpoint.ts) | 收集 toolDelta 合并生成 tool_trigger、追加 messages、持久化 |
| [chat.ts](src/agent/middleware/chat.ts) | LLM 调用、流式/非流式、yield StreamChunk |
| [tool.ts](src/agent/middleware/tool.ts) | 收集 tool_trigger、执行工具、yield tool_complete |
| [retry.ts](src/agent/middleware/retry.ts) | 自动重试、错误恢复、yield ErrorChunk |

## Tool 监管

`toolMiddleware` 根据 `SupervisionLevel` 决定执行策略：
- `auto` (0)：自动执行
- `confirm` (1)：yield InterruptChunk，等待确认
- `manual` (2)：禁止自动执行

配置层级：Tool 定义 → `config.yaml` tool_groups → `global.supervision`

## 配置系统

`.chery/config.yaml`（运行时读取，不走打包），`$ENV_VAR_NAME` 引用环境变量（[utils/config.ts](src/utils/config.ts) 替换）。

```yaml
global:
  thinking: true
  supervision: manual      # auto/confirm/manual
  stream: true
  tool_execute_timeout: 10000
  bash_log_retention_hours: 24
```

Tool Group 支持单组或多组（多组工具去重：后加载覆盖前加载）：

```yaml
tool_group: [safe_tools, dangerous_tools]
```

## TypeScript 配置

- ESM（`"type": "module"`），严格模式（`noUncheckedIndexedAccess`）
- bundler 模块解析（Vite 8），路径别名 `@/*` → `src/*`，`@test/*` → `test/*`
- verbatimModuleSyntax：`interface`/`type` 用 `import type`；`class`/`enum`/函数用 `import`

## 扩展指南

### 添加 Provider

1. 创建 `src/agent/provider/<name>.ts`，定义 Message/Tool/LLM Adapter 配置
2. 导出注册函数，在 [builder.ts](src/agent/builder.ts) 中调用
3. 在 `config.yaml` 添加客户端配置，`provider` 字段对应

### 添加内置 Tool

使用 [toolCreator.ts](src/core/tool/toolCreator.ts) 的 `tool()` 函数，在 `src/agent/tool/` 创建文件，在 [index.ts](src/agent/tool/index.ts) 导入注册。

### 添加外部 Tool

在 `.chery/tools/` 创建 `.ts` 文件（编译系统自动注入 zod/tool/SupervisionLevel 导入），在 `config.yaml` tool_groups 中引用。

### 添加 Skill

在 `.chery/skills/<name>/` 创建 `SKILL.md`（含 frontmatter），prompt 系统自动加载。

### 添加中间件

在 `src/agent/middleware/` 创建文件，实现 `MiddlewareHandler` 类型，在 [index.ts](src/agent/middleware/index.ts) 的 `defaultHandlers` 中添加。
