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
├── skills/<name>/SKILL.md       # 技能定义
├── senses/<name>.ts             # 外部自定义感官
└── db/                          # 数据库目录（自动创建）
    ├── soul.db                  # chats 表（id, messages_month, created_at, updated_at, metadata）
    └── YYYY-MM.db               # messages 表（按 chat 创建月固定分片）
        └── messages            # 消息历史，content 空=pending，revoked=1=撤回

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
│   ├── bootstrap.ts             # 启动期注册 Provider + 重建 Sense registry
│   ├── builder.ts               # AgentBuilder Middleware 工厂/门面
│   ├── middleware/
│   │   ├── index.ts             # defaultHandlers、createLoopHandler
│   │   ├── checkpoint.ts        # checkpointMiddleware 状态归纳 + effect chunk
│   │   ├── checkpointState.ts   # CheckpointState 状态管理
│   │   ├── chat.ts              # chatMiddleware LLM 调用
│   │   ├── tool.ts              # senseMiddleware 感官执行（文件名待重构）
│   │   ├── retry.ts             # retryMiddleware 错误重试
│   │   └── loop.ts              # createLoopHandler 循环执行
│   ├── sense/                   # 内置感官
│   │   ├── index.ts             # reloadSenses：注册内置感官 + 加载编译产物
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
│   ├── brain/
│   │   └── list.ts              # brain.list handler
│   ├── runtime/
│   │   └── set.ts               # runtime.set handler
│   ├── sense/
│   │   └── list.ts              # sense.list handler
│   ├── chat/
│   │   ├── handler.ts           # chat.create/list/get/delete handlers
│   │   └── send.ts              # chat.send/resume 流式、observer 副作用、RPC 转换
│   ├── approval/
│   │   └── manager.ts           # ApprovalManager 极简版，只存储 approvalResolve 回调
│   ├── message/
│   │   ├── index.ts             # 消息处理入口
│   │   ├── router.ts            # RpcRouter 方法路由
│   │   └── types.ts             # Request/Response/Chunk/Notification 类型、Method 常量
│   └── websocket/
│       ├── index.ts             # WebSocketServer 封装
│       ├── connection.ts        # ConnectionManager 连接状态管理
│       └── transport.ts         # 二进制帧编解码
│
├── db/                          # 数据持久化
│   ├── index.ts                 # 多数据库实例管理（getSoulDb/getMonthlyDb）、表初始化
│   └── chat.ts                  # chats 表 CRUD（messages_month）、messages 表 CRUD（按月路由）
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
| Service | `src/service/` | 服务层：WebSocket、灵魂管理、审批恢复（极简 ApprovalManager） |
| DB | `src/db/` | 数据持久化：多数据库实例管理、soul/chat/messages 表（按月路由） |
| Utils | `src/utils/` | 共用工具函数 |
| 配置 | `.chery/` + `db/` | 运行时配置 + 数据库存储（soul.db + YYYY-MM.db） |

## WebSocket 协议补充说明

**基础协议（消息结构、传输格式）** → 见 [docs/websocket.md](../docs/websocket.md)

### 方法列表

| 方法 | 说明 | 流式 |
|------|------|------|
| `brain.list` | 列出所有 brain（senseGroups 为全局全量） | 否 |
| `sense.list` | 列出 sense_groups（senses 含 `:level` 后缀未解析） | 否 |
| `runtime.set` | 原子设置 chat 的 brain + senseGroups（每轮可换） | 否 |
| `chat.create` | 创建聊天（必带 brain + senseGroups） | 否 |
| `chat.list` | 列出所有聊天 | 否 |
| `chat.get` | 流式载入历史（末条未完成周期时返回 canResume） | 是 |
| `chat.delete` | 删除聊天 | 否 |
| `chat.send` | 发送消息（仅 chatId + prompt；末尾有 pending 自动撤回 + staged.reverse） | 是 |
| `chat.resume` | 续接（无 prompt，恢复执行 pending sense / 继续 loop） | 是 |
| `sense.approval` | 感官审批（accept/reject） | 否 |

### Notification 类型详解

| 类型 | 触发时机 | data |
|------|----------|------|
| `interrupt` | sense_end | `{approvalId, senseName, arguments, supervisionLevel, needsApproval}` |
| `accept` | sense 执行成功 | `{approvalId, senseName, result}` |
| `rejected` | sense 被拒 / 审批取消 | `{approvalId, senseName, reason}` |
| `consumed` | 用户输入已进入消息循环 | `{count}` |
| `loaded` | chat.get 历史载入完成 | `null` |
| `done` | chat.send/resume loop 结束 | `null` |
| `error` | 执行出错 | `{message}` |

### Chunk 类型详解

| type | 说明 | data 字段 |
|------|------|-----------|
| `stream` | 流式增量 | thinking, content, senseCall |
| `staged` | 阶段完成 | type, role, thinking, content, senseName, arguments, messageIds |

`staged.type` 取值：`thinking_end` / `content_end` / `sense_end` / `reverse`。`reverse`（携 messageIds）由 chat.send 自动撤回末尾 pending sense 时发送。`role`（user/assistant/system/sense）仅 chat.get 历史携带。

### 审批流程详解

**审批极简方案（无 approvals 表）：** 审批状态通过 messages.content 判断（空 = pending），ApprovalManager 只存 approvalResolve 回调。

**confirm 模式流程：**

```text
1. chat.send 发送用户消息
2. LLM 返回 sense_call
3. senseMiddleware 检查 supervisionLevel = confirm
4. checkpoint 创建 pending sense 内存消息（message_created effect）
5. yield SenseTriggerChunk（含 approvalResolve）→ service observer 注册 approvalManager + 发 interrupt notification
6. 客户端 sense.approval → approvalManager.confirm → approvalResolve(action, reason)
7. fillApprovalResult 更新 messages.content（执行结果/拒绝原因）
8. senseMiddleware 继续：accept 执行感官 / reject 跳过 → accept/rejected notification
```

**末尾未完成处理（send 自动撤回 / resume 续接）：**

服务重启后 chat.get 流式回显历史，末条为 loop 未自然结束（pending sense，或 done sense 无后续 assistant）时 response 携带 `canResume:true`。前端两选：

- **发新消息** `chat.send(chatId, prompt)`（仅 chat.get 恢复场景触发）：撤回整个当前周期 AI 响应（think + content + tool/senseCalls + pending sense），回退到上一周期结束（标记 `revoked`，buildMessages 过滤），发 `staged.reverse` chunk（messageIds）通知客户端回滚，加 prompt 重跑
  - 正常运行中 loop 自动续接不会留 pending；运行中 send 仅入队等下个周期消费，不撤回
- **点续接按钮** `chat.resume(chatId)`（无 prompt）：恢复执行 / 继续 loop，整体同默认 send 流一致，仅首轮跳过 chat 层（不调 LLM）
  - 末尾有 pending sense → senseMiddleware 不调 next，重发 sense_end → interrupt，按监管等级执行（auto 直接 / confirm 等审批）；工具不在当前 senseTable → 跳过监管静默写「无此工具」
  - 末尾全 done → 直接进 loop 调 LLM

> Phase 0（send 自动恢复执行 pending sense）已移除，续接必须由显式 `chat.resume` 按钮触发。详见 [docs/interaction.md](../docs/interaction.md) chat.resume。

**关键代码位置：**

- 审批等待：[agent/middleware/tool.ts](src/agent/middleware/tool.ts) `buildSenseTrigger` 创建 approvalPromise
- 审批注册/确认：[service/chat/send.ts](src/service/chat/send.ts) `approvalManager.register()` / `confirm()` + `fillApprovalResult()`
- 状态判断：messages 表 `content` 空 = pending；`revoked=1` = 撤回

## 核心设计模式

### Middleware - 洋葱模型

[core/middleware/index.ts](src/core/middleware/index.ts) Middleware 类：

```ts
new Middleware(global, handlers, loopHandler?)
```

**执行顺序（由外到内）：** `checkpointMiddleware → senseMiddleware → retryMiddleware → chatMiddleware`

**Chunk 流向：**

```text
chatMiddleware yield StreamChunk
  ↓ checkpointMiddleware 收集 delta
  ↓ checkpointMiddleware yield StagedChunk（thinking_end/content_end）
senseMiddleware yield SenseTriggerChunk
  ↓ checkpointMiddleware yield StagedChunk（sense_end）
  ↓ checkpointMiddleware yield message/sense effect chunk
  ↓ service observer 处理 DB 持久化和 approval 注册
senseMiddleware 执行感官
  ↓ senseMiddleware yield SenseAcceptChunk/SenseRejectChunk
retryMiddleware 捕获错误 yield ErrorChunk
loopMiddleware 循环直到无 senseCalls
  ↓ yield DoneChunk
```

### MiddlewareContext

参见 [core/middleware/types.ts](src/core/middleware/types.ts)：

| 分组 | 字段 | 说明 |
|------|------|------|
| `soul` | chatId | 聊天标识（单 chat 绑定） |
| `soul` | senseSharedData | 感官间共享数据 |
| `soul` | userInputs | 用户输入队列（send 注入，checkpoint 消费） |
| `soul` | messages | 对话历史 |
| `global` | thinking, supervision, stream, maxLoopCount | 全局配置 |
| `runtime` | brain | Brain 配置（model/provider/url/key） |
| `runtime` | adapters | llmAdapter / messageAdapter / senseAdapter |
| `runtime` | builtSenses | 预构建 API 感官参数（给 LLM） |
| `runtime` | senseTable | name → 监管等级 + 执行器 |

### Builder - Agent 配置

[agent/builder.ts](src/agent/builder.ts)：

```ts
const agent = new AgentBuilder()
  .build()
  .configureRuntime({
    brain: "longcat",
    senseGroups: ["safe"],
  })
  .init(chatId);

agent.run(input); // 发送消息
```

`build()` 阶段：
1. 创建 Middleware 实例
2. 注入 global、handlers、loopHandler 等跨轮不变项

Provider 和 Sense registry 不由 Builder 懒加载；服务启动前由 `bootstrapAgentRuntime()` 全局完成：
1. `registerBuiltinProviders()` 注册内置 Provider Adapter
2. `reloadSenses()` 清空并重建 Sense registry（内置感官 + 编译产物）
3. `compile-senses` 子命令结束后会在当前进程调用 `reloadSenses()`，供后续热重载入口复用

`configureRuntime()` 阶段：
1. 通过 RuntimeResolver 原子解析 brain + senseGroups
2. 获取 Provider Adapter（LLM/Message/Sense）
3. 调用 `senseAdapter.buildSenses()` 预构建感官
4. 摊平 senseTable（监管等级 + 执行器）并注入 Middleware

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

[core/middleware/index.ts](src/core/middleware/index.ts) `Middleware` 类（单 chat 绑定，跨轮不重建）：

- `init(chatId, messages)`：绑定 chatId，注入历史/system 消息
- `configureRuntime(runtime)`：原子注入 brain/adapters/senseTable（每轮可换）
- `send(input)`：空闲时入队 userInputs 并启动 loop；运行中只入队，下一轮 loop 消费
- runtime 缓存（chatRuntimes：Map<chatId, {builder, selection}>）在 [service/chat/send.ts](src/service/chat/send.ts)，非 Middleware 内

## 中间件职责

| 中间件 | 文件 | 输入 | 输出 |
|--------|------|------|------|
| checkpoint | [checkpoint.ts](src/agent/middleware/checkpoint.ts) | StreamChunk / SenseTriggerChunk / SenseResultChunk | StagedChunk + message/sense effect chunk |
| sense | [tool.ts](src/agent/middleware/tool.ts) | SenseTriggerChunk（含 approvalResolve） | SenseAccept/SenseRejectChunk |
| retry | [retry.ts](src/agent/middleware/retry.ts) | ErrorChunk | 重试或继续 |
| chat | [chat.ts](src/agent/middleware/chat.ts) | userInputs | StreamChunk（LLM 响应） |

### checkpointMiddleware

1. 收集 `thinkingDelta` → yield `staged(thinking_end)`
2. 收集 `contentDelta` → yield `staged(content_end)`
3. 收集 `senseDelta` → 构建 `SenseTriggerChunk`
4. 追加消息到 `ctx.soul.messages`
5. yield `message_created` / `message_updated` / `sense_pending` effect，由 service observer 统一处理 DB/approval 副作用

### senseMiddleware

1. Phase 1：从 stream chunks 收集 senseDelta，检测完整 sense call，yield `SenseTriggerChunk`
2. Phase 2：auto 直接执行；confirm/manual 批量 await approvalPromise 后逐一执行
3. 执行：`senseTable.get(name).execute(args, senseSharedData)`
4. yield `SenseAcceptChunk` / `SenseRejectChunk`

> Phase 0（recovery 自动恢复 pending sense）已废弃，改由 chat.resume 撤回处理。

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

global:
  thinking: true              # 全局 thinking
  supervision: manual         # 全局监管等级
  stream: true                # 流式响应
  sense_execute_timeout: 10000  # 感官执行超时（ms）
  bash_log_retention_hours: 24  # Bash 日志保留时间

sense_groups:
  <name>:                     # 感官分组名称
    senses:
      - execute_command       # 不覆盖监管等级
      - read_file:confirm     # 覆盖监管等级为 confirm
```

### Sense 监管等级优先级

**优先级链：** 感官配置覆盖 > 感官内置声明 > global.supervision

```text
1. sense_groups 中感官配置覆盖（如 "execute_command:auto"，最高优先级）
2. 感官内置 supervisionLevel 字段
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
4. 在 [agent/provider/index.ts](src/agent/provider/index.ts) 的 `registerBuiltinProviders()` 中调用注册函数
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
