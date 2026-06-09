# cheryClaw 项目规范

## 项目概述

多 LLM Agent 框架，支持 Ollama、OpenAI 等提供商。核心特性：Sense 调用监管、流式响应、两阶段执行、Prompt 系统与 Skills 加载。

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
.chery/                          # 外置配置（不走打包，运行时读取）
├── config.yaml                  # LLM 客户端 + Sense 分组 + 全局配置
├── system.md                    # 系统 prompt 模板
├── data.db                      # SQLite 数据库（soul/chat/approval/checkpoint）
├── skills/<name>/SKILL.md       # 技能定义
└── senses/<name>.ts             # 外部自定义感官

src/
├── index.ts                     # 入口：WebSocket 服务 / compile-senses 子命令
│
├── core/                        # 框架抽象（不含具体实现）
│   ├── config.ts                # SupervisionLevel 枚举定义
│   ├── llm/
│   │   ├── adapter.ts           # LLMAdapter 接口、getLLMAdapter 注册表
│   │   └── index.ts             # 导出
│   ├── message/
│   │   ├── adapter.ts           # MessageAdapter 接口、SenseCallInfo 类型
│   │   └── index.ts             # LLMResponse 类型、导出
│   ├── middleware/
│   │   ├── compose.ts           # compose() 中间件组合器
│   │   ├── types.ts             # MiddlewareContext、SoulGroup、Chunk 类型
│   │   └── index.ts             # Middleware 类、chatMap、createChat/send
│   ├── prompt/
│   │   ├── index.ts             # buildFirstSystemPrompt 构建 system 消息
│   │   └── loadSkill.ts         # Skills 加载器（SKILL.md frontmatter 解析）
│   ├── sense/
│   │   ├── adapter.ts           # SenseAdapter 接口、SenseFunction、SenseCallData
│   │   ├── senseCreator.ts      # sense() 工厂函数（zod schema → SenseFunction）
│   │   ├── senseManager.ts      # SenseManager 执行感官、管理注册
│   │   ├── senseRegistry.ts     # SenseRegistry 注册表
│   │   ├── index.ts             # 导出
│   │   └── compiler/            # 外部感官编译器（.chery/senses/*.ts）
│   │       ├── core.ts          # 编译核心逻辑
│   │       ├── types.ts         # CompiledSense 类型
│   │       ├── utils.ts         # 工具函数
│   │       └── index.ts         # 编译入口
│   └── provider/
│       └── capabilities.ts      # Provider 能力定义（streaming/sense_calls）
│
├── agent/                       # 具体实现
│   ├── builder.ts               # AgentBuilder 链式配置、Provider 注册调用
│   ├── middleware/
│   │   ├── index.ts             # defaultHandlers、createLoopHandler
│   │   ├── checkpoint.ts        # checkpointMiddleware 消息持久化
│   │   ├── checkpointState.ts   # CheckpointState 状态管理
│   │   ├── chat.ts              # chatMiddleware LLM 调用
│   │   ├── tool.ts              # senseMiddleware 感官执行（文件名待重构）
│   │   ├── retry.ts             # retryMiddleware 错误重试
│   │   └── loop.ts              # createLoopHandler 循环执行
│   ├── sense/                   # 内置感官
│   │   ├── index.ts             # 注册内置感官
│   │   ├── bash.ts              # execute_command 感官
│   │   ├── read.ts              # read_file 感官
│   │   ├── write.ts             # write_file 感官
│   │   ├── skill.ts             # execute_skill 感官
│   │   └── compileToolsReporter.ts # compile-senses 命令报告
│   └── provider/
│       ├── openai.ts            # OpenAI Adapter 注册
│       └── ollama.ts            # Ollama Adapter 注册
│
├── service/                     # 服务层
│   ├── index.ts                 # WebSocket 服务启动
│   ├── soul/
│   │   └── lifecycle.ts         # soul.create/list/load/delete handlers
│   ├── chat/
│   │   ├── handler.ts           # chat.list/get/delete handlers
│   │   └ send.ts               # chat.send 流式处理、审批注册
│   ├── approval/
│   │   └ manager.ts             # ApprovalManager 审批管理、approvalResolve 存储
│   ├── message/
│   │   ├── index.ts             # 消息处理入口
│   │   ├── router.ts            # RpcRouter 方法路由
│   │   └ types.ts               # Request/Response/Chunk/Notification 类型、Method 常量
│   └ websocket/
│   │   ├── index.ts             # WebSocketServer 封装
│   │   ├── connection.ts        # ConnectionManager 连接状态管理
│   │   └ transport.ts           # 二进制帧编解码
│
├── db/                          # 数据持久化
│   ├── index.ts                 # SQLite 初始化、建表
│   ├── soul.ts                  # souls 表 CRUD
│   ├── chat.ts                  # chats 表 CRUD、messages 表 CRUD
│   ├── approval.ts              # approvals 表 CRUD
│   ├── checkpoint.ts            # checkpoints 表 CRUD
│
└── utils/                       # 工具函数
    ├── config.ts                # config.yaml 加载、$ENV 替换、BrainConfig 类型
    ├── hash.ts                  # Hash 生成
    ├── bashLogger.ts            # Bash 命令日志管理
    ├── generator.ts             # AsyncGenerator 工具
    ├── json.ts                  # JSON 工具
    ├── drain/                   # Drain 日志模板挖掘算法
    └ logger/
        ├── bashLogger.ts        # Bash 日志
        ├── fileLogger.ts        # 文件日志

test/                            # 测试套件（vitest），结构镜像 src/
```

## 架构分层

| 层 | 路径 | 职责 |
|----|------|------|
| Core | `src/core/` | 框架抽象：类型、Adapter 注册表、Middleware 类、Sense 工厂 |
| Agent | `src/agent/` | 具体实现：Builder、中间件、内置感官、Provider |
| Service | `src/service/` | 服务层：WebSocket、灵魂管理、审批恢复 |
| DB | `src/db/` | 数据持久化：checkpoint、soul、chat、approval |
| Utils | `src/utils/` | 共用工具函数 |
| 配置 | `.chery/` | 运行时配置，不走打包。路径通过 `CHERY_DIR` 环境变量指定 |

## WebSocket 协议补充说明

**基础协议（消息结构、传输格式）** → 见 [README.md](../README.md) WebSocket 协议章节

### 方法列表

| 方法 | 说明 | 流式 |
|------|------|------|
| `soul.create` | 创建灵魂 | 否 |
| `soul.list` | 列出灵魂 | 否 |
| `soul.load` | 载入灵魂到内存 | 否 |
| `soul.delete` | 删除灵魂（需先删除 Chat） | 否 |
| `chat.list` | 列出聊天 | 否 |
| `chat.get` | 获取聊天详情（载入历史） | 是 |
| `chat.delete` | 删除聊天 | 否 |
| `chat.send` | 发送聊天消息 | 是 |
| `sense.approval` | 感官审批 | 否 |

### Notification 类型详解

| 类型 | 触发时机 | data |
|------|----------|------|
| `interrupt` | sense_end 且 supervision > auto | `{approvalId, senseName, arguments, supervisionLevel}` |
| `complete` | 感官执行完成 | `{approvalId, senseName, result}` |
| `consumed` | 用户输入已进入消息循环 | `{count}` |
| `loaded` | chat.get 历史载入完成 | `null` |
| `done` | chat.send 执行完成 | `null` |
| `error` | 执行出错 | `{message}` |

### Chunk 类型详解

| type | 说明 | data 字段 |
|------|------|-----------|
| `stream` | 流式增量 | thinking, content, senseCall |
| `staged` | 阶段完成 | type, role, thinking, content, senseName, arguments |

**role 字段说明：** 消息角色（`user`/`assistant`/`system`/`sense`），用于区分消息来源。chat.get 返回历史时携带。

### 审批流程详解

**confirm 模式流程：**

```text
1. chat.send 发送用户消息
2. LLM 返回 sense_call（如 execute_command）
3. senseMiddleware 检查 supervisionLevel = confirm
4. yield SenseTriggerChunk（含 approvalResolve 回调）
5. send.ts 调用 approvalManager.registerFromTrigger() 存储 approvalResolve
6. send.ts yield interrupt notification
7. 客户端收到 interrupt，发送 sense.approval
8. approvalManager.confirmApproval() 调用 approvalResolve(action, reason)
9. senseMiddleware Generator 继续，根据 action 执行或拒绝
10. yield sense_complete notification
```

**关键代码位置：**
- 审批等待：[agent/middleware/tool.ts](src/agent/middleware/tool.ts) `executeSenseCall()` 创建 approvalPromise
- 审批注册：[service/chat/send.ts](src/service/chat/send.ts) `registerFromTrigger()`
- 审批确认：[service/approval/manager.ts](src/service/approval/manager.ts) `confirmApproval()`

## 核心设计模式

### Middleware - 洋葱模型

[core/middleware/index.ts](src/core/middleware/index.ts) Middleware 类：

```ts
new Middleware(soulId, global, brainConfig, senseManager, adapters, handlers, loopHandler?, builtSenses?)
```

**执行顺序（由外到内）：** `checkpointMiddleware → chatMiddleware → senseMiddleware → retryMiddleware`

**Chunk 流向：**

```text
chatMiddleware yield StreamChunk
  ↓ checkpointMiddleware 收集 delta
  ↓ checkpointMiddleware yield StagedChunk（thinking_end/content_end）
senseMiddleware yield SenseTriggerChunk
  ↓ checkpointMiddleware yield StagedChunk（sense_end）
senseMiddleware 执行感官
  ↓ senseMiddleware yield SenseCompleteChunk
retryMiddleware 捕获错误 yield ErrorChunk
loopMiddleware 循环直到无 senseCalls
  ↓ yield DoneChunk
```

### MiddlewareContext

参见 [core/middleware/types.ts](src/core/middleware/types.ts)：

| 分组 | 字段 | 说明 |
|------|------|------|
| `soul` | soulId, chatId | 身份标识 |
| `soul` | hashCheck | 感官调用去重（callId → resultHash） |
| `soul` | senseSharedData | 感官间共享数据 |
| `soul` | userInputs | 用户输入队列 |
| `soul` | builtSenses | 预构建感官函数 |
| `soul` | messages | 对话历史 |
| `global` | thinking, supervision, stream, maxLoopCount | 全局配置 |
| `brain` | model, provider, url, key | Brain 配置 |
| `adapters` | llmAdapter, messageAdapter, senseAdapter | Adapter 实例 |
| `senseManager` | SenseManager | 感官管理器 |

### Builder - Agent 配置

[agent/builder.ts](src/agent/builder.ts)：

```ts
const agent = await new AgentBuilder()
  .use("longcat")       // 选择 Brain 配置
  .setSoulId(soulId)    // 设置灵魂 ID
  .build();

agent.createChat(chatId);  // 创建聊天
agent.send(chatId, input); // 发送消息
```

`build()` 阶段：
1. 获取 Provider Adapter（LLM/Message/Sense）
2. 调用 `senseAdapter.buildSenses()` 预构建感官
3. 创建 Middleware 实例

### Adapter - 三层适配

| Adapter | 文件 | 职责 |
|---------|------|------|
| LLM | [core/llm/adapter.ts](src/core/llm/adapter.ts) | `chat()` / `chatStream()` 接口 |
| Message | [core/message/adapter.ts](src/core/message/adapter.ts) | 响应格式转换、SenseCallInfo 提取 |
| Sense | [core/sense/adapter.ts](src/core/sense/adapter.ts) | `buildSenses()` 构建感官函数、调用格式转换 |

### Loop 执行

[agent/middleware/loop.ts](src/agent/middleware/loop.ts) `createLoopHandler`：

```ts
while (true) {
  const chunks = await runChain();
  // 收集 chunks
  if (lastMessage.role === "assistant" && !lastMessage.senseCalls) {
    break; // 无感官调用，结束
  }
}
yield DoneChunk;
```

### Chat 管理

[core/middleware/index.ts](src/core/middleware/index.ts) `Middleware` 类：

- `chatMap`：Map<string, MiddlewareContext> 聊天上下文映射
- `createChat(chatId)`：初始化 context，注入 system 消息
- `send(chatId, input)`：注入 userInputs，执行 chain
- 支持 generator 复用（同一 chatId 多次 send）

## 中间件职责

| 中间件 | 文件 | 输入 | 输出 |
|--------|------|------|------|
| checkpoint | [checkpoint.ts](src/agent/middleware/checkpoint.ts) | StreamChunk | StagedChunk（合并 delta） |
| chat | [chat.ts](src/agent/middleware/chat.ts) | userInputs | StreamChunk（LLM 响应） |
| sense | [tool.ts](src/agent/middleware/tool.ts) | SenseTriggerChunk | SenseCompleteChunk |
| retry | [retry.ts](src/agent/middleware/retry.ts) | ErrorChunk | 重试或继续 |

### checkpointMiddleware

1. 收集 `thinkingDelta` → yield `staged(thinking_end)`
2. 收集 `contentDelta` → yield `staged(content_end)`
3. 收集 `senseDelta` → 构建 `SenseTriggerChunk`
4. 追加消息到 `ctx.soul.messages`
5. 持久化到 `checkpoints` 表

### senseMiddleware

1. 检查 `supervisionLevel`
2. `auto`：直接执行感官
3. `confirm/manual`：yield `SenseTriggerChunk`，等待 `approvalResolve` 回调
4. 执行感官：`senseManager.execute(name, args)`
5. yield `SenseCompleteChunk`

## 配置系统补充说明

**基础配置文件说明** → 见 [README.md](../README.md) 配置文件章节

### config.yaml 结构

```yaml
llm:
  brain:
    <name>:                   # Brain 配置名称
      provider: ollama        # Provider 类型
      model: gemma3:1b        # 模型名称
      url: $OLLAMA_HOST       # 服务地址（$ENV 替换）
      key: $API_KEY           # API 密钥
      thinking: true          # 是否启用 thinking
      sense_group: [safe]     # 感官分组（单组或多组）

global:
  thinking: true              # 全局 thinking
  supervision: manual         # 全局监管等级
  stream: true                # 流式响应
  sense_execute_timeout: 10000  # 感官执行超时（ms）
  bash_log_retention_hours: 24  # Bash 日志保留时间

sense_groups:
  <name>:                     # 感官分组名称
    - execute_command         # 感官列表
    - read_file
```

### Sense 监管等级优先级

**优先级链：** 感官定义 > sense_group > global.supervision

```text
1. 感官定义中 supervision 字段（最高优先级）
2. sense_group 中该感官的配置
3. global.supervision（最低优先级）
```

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `CHERY_DIR` | 配置目录路径 | `.chery` |
| `WS_PORT` | WebSocket 端口 | `8080` |
| `CHERY_TRANSPORT` | 传输格式 `binary`/`json` | `binary` |

## TypeScript 配置

- ESM（`"type": "module"`），严格模式（`noUncheckedIndexedAccess`）
- bundler 模块解析（Vite 8），路径别名 `@/*` → `src/*`，`@test/*` → `test/*`
- verbatimModuleSyntax：`interface`/`type` 用 `import type`；`class`/`enum`/函数用 `import`

## 扩展指南

### 添加 Provider

1. 创建 `src/agent/provider/<name>.ts`
2. 定义 MessageAdapter/SenseAdapter/LLMAdapter 配置
3. 导出 `register<Name>Adapter()` 函数
4. 在 [builder.ts](src/agent/builder.ts) 调用注册函数
5. 在 `config.yaml` 添加 brain 配置，`provider` 字段对应

### 添加内置 Sense

1. 使用 [senseCreator.ts](src/core/sense/senseCreator.ts) 的 `sense()` 函数
2. 在 `src/agent/sense/<name>.ts` 创建文件
3. 在 [index.ts](src/agent/sense/index.ts) 导入注册

```ts
import { sense } from "@/core/sense/senseCreator";
import { z } from "zod";

export const mySense = sense({
  name: "my_sense",
  description: "My custom sense",
  parameters: z.object({ path: z.string() }),
  supervision: SupervisionLevel.confirm,
  execute: async (args) => {
    return `Result: ${args.path}`;
  },
});
```

### 添加外部 Sense

1. 在 `.chery/senses/<name>.ts` 创建文件
2. 系统自动注入 `zod`/`sense`/`SupervisionLevel` 导入
3. 在 `config.yaml` sense_groups 中引用

### 添加 Skill

1. 在 `.chery/skills/<name>/` 创建目录
2. 创建 `SKILL.md`（含 frontmatter）

```markdown
---
name: my-skill
description: My custom skill
trigger: "用户请求XXX时触发"
---

## 技能说明
...
```

### 添加中间件

1. 在 `src/agent/middleware/` 创建文件
2. 实现 `MiddlewareHandler` 类型
3. 在 [index.ts](src/agent/middleware/index.ts) `defaultHandlers` 中添加