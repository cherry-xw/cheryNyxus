# Core 模块总览

> 源码 [src/core/](../../src/core/) ｜ 上级 [docs](../) ｜ 相关 [protocol.md](../protocol.md)、[db.md](../db.md)

## 职责

`core/` 是 CheryNyxus 的**框架抽象层**：定义 Agent 运行所需的全部接口、类型与组合机制，但**不含任何具体实现**。所有 Provider（OpenAI/Ollama/Mock）、内置感官（bash/read/write/skill）、中间件行为（retry/checkpoint/chat/sense/loop）都在 [`agent/`](../../src/agent/) 中实现并通过 `core/` 暴露的注册表注入。

这一层是「AI 知识地图」的根：要改 Agent 行为（接新模型、加工具、改监管、调执行链），先读 core/ 理解契约，再去 agent/ 找对应实现。core/ 本身保持薄、零 I/O 假设（两个例外：`sense/compiler/` 读写文件系统编译外部感官，`mcp/` 连接外部 MCP server）。

## 文件清单（顶层）

| 文件 / 目录 | 职责 |
|------|------|
| [config.ts](../../src/core/config.ts) | `SupervisionLevel` 枚举（auto/smart/manual），core 唯一的运行时常量定义 |
| [llm/](../../src/core/llm/) | LLM Adapter 接口与注册表（`chat` / `chatStream` 契约）→ [llm.md](./llm.md) |
| [message/](../../src/core/message/) | Message Adapter 接口、`LLMResponse` 统一响应结构、`SenseCallInfo` → [message.md](./message.md) |
| [middleware/](../../src/core/middleware/) | 洋葱模型组合器 `compose()`、`AgentSession`、`MiddlewarePipeline`、`MessageJournal`、Context/Chunk 全部类型 → [middleware.md](./middleware.md) |
| [sense/](../../src/core/sense/) | Sense Adapter 接口、`sense()` 工厂、感官注册表、审批 Promise 注册表 → [sense.md](./sense.md) |
| [sense/compiler/](../../src/core/sense/compiler/) | 外部感官（`.chery/senses/*.ts`）编译器，core 两个带 I/O 的子模块之一 → [compiler.md](./compiler.md) |
| [mcp/](../../src/core/mcp/) | MCP server 接入：tools/resources/prompts → Sense，core 两个带 I/O 的子模块之二 → [mcp.md](./mcp.md) |

## 三大抽象 + 一个运行时常量

core/ 围绕三条解耦轴组织，对应三套 Adapter 注册表；再加 `SupervisionLevel` 这一刻画监管语义的枚举。

```text
┌────────────────────────── core/（抽象契约）──────────────────────────┐
│                                                                       │
│  LLMAdapter       注册表  chat()/chatStream()          → llm.md       │
│  MessageAdapter   注册表  响应→LLMResponse / 消息构建   → message.md   │
│  SenseAdapter     注册表  buildSenses/提取 senseCalls   → sense.md     │
│                                                                       │
│  AgentSession     Pipeline + Journal + 单 chat 上下文   → middleware.md│
│  sense() 工厂     zod schema → Sense 实例              → sense.md     │
│                                                                       │
│  SupervisionLevel 枚举  auto=0 / smart=1 / manual=2  → 本文件       │
└───────────────────────────────────────────────────────────────────────┘
                              ↓ 被 agent/ 注入实现
┌────────────────────────── agent/（具体实现）─────────────────────────┐
│  provider/{openai,ollama,mock}.ts  注册三套 Adapter                    │
│  sense/{bash,read,write,skill}.ts  用 sense() 定义内置感官             │
│  middleware/{checkpoint,sense,retry,chat,loop}.ts  实现各中间件       │
│  builder.ts  组装 AgentSession + 原子解析 RuntimeConfig               │
└───────────────────────────────────────────────────────────────────────┘
```

### SupervisionLevel 枚举

[config.ts](../../src/core/config.ts) 全文即此枚举，是 core 层唯一的运行时常量，驱动 sense 执行流的分支（见 [sense.md](./sense.md) 监管等级表）。

```ts
export enum SupervisionLevel {
  auto = 0,     // 自动执行，无需确认
  smart = 1,    // 智能监管：危险操作（黑名单命中/false/取参异常）需确认，其余（含未知 sense）自动执行（fail-open 默认放行）
  manual = 2,   // 禁止自动执行，仅手动触发
}
```

监管等级**优先级链**（高 → 低，最终值在 builder 层摊平时写入 `senseTable[name].supervisionLevel`）：

1. `sense_groups` 中感官配置覆盖（如 `"execute_command:auto"`）
2. 感官内置 `supervisionLevel` 字段（`sense()` 第 5 参数）
3. `global.supervision`（最低）

> 注册表（LLM/Message/Sense Adapter）均为**进程内全局 Map**，由 `agent/bootstrap.ts` 在启动期一次性填充。core/ 既不触发注册，也不持有运行时实例——`MiddlewareContext.runtime` 由 `AgentBuilder.configureRuntime` 原子注入。

## 子模块导航

| 想理解 / 修改 | 读这份 |
|------|------|
| 模型怎么调、怎么接新 Provider | [llm.md](./llm.md) |
| LLM 响应如何归一、SenseCallInfo 怎么提取 | [message.md](./message.md) |
| 洋葱模型怎么跑、Chunk 流如何流转、Chat 状态机 | [middleware.md](./middleware.md) |
| 感官定义、监管、审批、感官注册 | [sense.md](./sense.md) |
| 外部 `.chery/senses/*.ts` 如何编译成可执行感官 | [compiler.md](./compiler.md) |
| 外部 MCP server 的 tools/resources/prompts 如何接入为 Sense | [mcp.md](./mcp.md) |

## 依赖与关联

- **依赖**：`core/` 只依赖 `zod`（sense 工厂 schema）与 Node 内建（compiler 子模块用 `fs`/`path`）；类型上引用 [`utils/config.ts`](../../src/utils/config.ts) 的 `GlobalConfig` / `BrainConfig`（middleware/types.ts）。
- **被依赖**：`agent/` 全量依赖 core —— `agent/provider/*` 调注册表、`agent/middleware/*` 用 Context/Chunk 类型、`agent/sense/*` 用 `sense()` 与 registry、`agent/builder.ts` 组装 `Middleware`；`service/` 间接经 agent 消费，唯一直接引用是 `service/chat/observer.ts`、`service/chat/runtime.ts` 用 `LLMResponse`，`service/approval/manager.ts` 调 `resolveApproval/rejectApproval`。
- **横切参考**：[protocol.md](../protocol.md)（Chunk → wire 映射）、[interaction.md](../interaction.md)（send/resume 状态机）、[db.md](../db.md)（消息持久化与 `revoked` 语义）。

## 扩展点

core/ 本身不扩展，扩展发生在 agent/，但**契约写在这里**：

- 接新 Provider → 实现 [`LLMAdapter`](./llm.md) + [`MessageProviderAdapterConfig`](./message.md) + [`SenseAdapter`](./sense.md)，调三个 `register*`。
- 加内置感官 → 调 [`sense()`](./sense.md) 工厂，再 `registerSenses([...])`。
- 加外部感官 → 在 `.chery/senses/<name>.ts` 写源码，由 [compiler.md](./compiler.md) 编译。
- 接 MCP server → 在 [config.yaml](../../.chery/config.yaml) 配 `mcp_servers`，由 [mcp.md](./mcp.md) 注入为 Sense。
- 加中间件 → 实现 [`MiddlewareHandler`](./middleware.md)，在 agent 的 `defaultHandlers` 中按序插入。
