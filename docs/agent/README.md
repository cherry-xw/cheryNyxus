# Agent 层（具体实现）

> 源码 [src/agent/](../../src/agent/) ｜ 横切 [交互流程](../interaction.md) ｜ 协议 [protocol.md](../protocol.md)

## 职责

agent 层是 core 抽象层的**具体实现**：装配 AgentSession 实例、注册内置 Provider Adapter、定义并加载内置/外部 Sense、构建 system prompt、解析 runtime（brain + senseGroup + mcpServers），以及把 chat.send/resume 等高层调用翻译为 Middleware 洋葱链的执行。

agent 层**不**直接处理 WebSocket / DB / 审批副作用——这些由 [service 层](../service/README.md) 的 observer 消费 agent 输出的 effect chunk 完成。agent 仅通过 chunk 类型（`message_created`/`message_updated`/`sense_pending`）声明副作用意图。

核心数据流（service 视角）：

```text
chat.send → AgentBuilder.run(input)
          → Middleware 洋葱链（checkpoint→sense→retry→chat，外到内）
          → loopHandler 循环 runChain 直到无 senseCalls
          → chunks 流回 service observer（DB 持久化 + 审批注册）
```

## 子模块导航

| 文档 | 对应源码 | 内容 |
|------|----------|------|
| [./middleware.md](./middleware.md) | [middleware/](../../src/agent/middleware/) | 5 个中间件 + loopHandler + 洋葱执行顺序 + Chunk 流向 + 审批流程（agent 侧） |
| [./prompt.md](./prompt.md) | [prompt/](../../src/agent/prompt/) | system prompt 构建 + SKILL.md frontmatter 解析 |
| [./provider.md](./provider.md) | [provider/](../../src/agent/provider/) | openai/ollama/mock 三 Provider 的 LLM/Message/Sense Adapter 注册 |
| [./sense.md](./sense.md) | [sense/](../../src/agent/sense/) | 内置感官（execute_command/read_file/write_file/skill）+ bash 进程注册表 + reloadSenses + 编译产物加载 |

## 文件清单

### 入口三件套

| 文件 | 职责 |
|------|------|
| [bootstrap.ts](../../src/agent/bootstrap.ts) | `bootstrapAgentRuntime()`：启动期一次性注册 Provider + 重建 Sense registry |
| [builder.ts](../../src/agent/builder.ts) | `AgentBuilder`：AgentSession 工厂 + RuntimeConfig 装配 + 门面方法转发 |
| [runtimeResolver.ts](../../src/agent/runtimeResolver.ts) | `RuntimeResolver`：原子解析 brain（→adapters）+ senseGroup（→builtSenses + senseTable） |

### 子目录

| 路径 | 说明 |
|------|------|
| [middleware/](../../src/agent/middleware/) | 5 个中间件 + loopHandler，详见 [./middleware.md](./middleware.md) |
| [prompt/](../../src/agent/prompt/) | system prompt 与 skill 加载，详见 [./prompt.md](./prompt.md) |
| [provider/](../../src/agent/provider/) | Provider adapter 注册，详见 [./provider.md](./provider.md) |
| [sense/](../../src/agent/sense/) | 内置感官与重载逻辑，详见 [./sense.md](./sense.md) |

## 核心概念

### 入口三件套的分工

```text
bootstrap.ts    ── 启动期一次性：registerBuiltinProviders() + reloadSenses() + loadMcpSenses()
                                    （进程级 registry，全局共享）
runtimeResolver ── 每轮可换：brain + senseGroup + mcpServers → RuntimeConfig
                                    （原子解析，校验严格）
builder.ts      ── 每 chat 一个：build() + configureRuntime() + init()
                                    （门面方法转发 AgentSession）
```

**职责解耦的关键：** Provider 与 Sense 都是进程级 registry，**不由 Builder 懒加载或校验**——bootstrap 在服务启动前显式完成注册，Builder 只消费 registry（[bootstrap.ts](../../src/agent/bootstrap.ts) 注释）。

### bootstrapAgentRuntime

```ts
// bootstrap.ts
export async function bootstrapAgentRuntime(): Promise<void> {
  registerBuiltinProviders();   // 注册 openai/ollama/mock 三 Provider
  await reloadSenses();         // resetSenses + 内置感官 + 编译产物
  await loadMcpSenses();         // 连接 config 声明的 MCP server 并注册其 senses
}
```

幂等性由各 registry 自身保证（`registerBuiltinProviders` 有 `builtinProvidersRegistered` 守卫；`reloadSenses` 先 `resetSenses`）。MCP senses 在内置/编译感官之后加载，不纳入 `reloadSenses()`，避免 `compile-senses` 子命令连接外部 MCP server。`compile-senses` 子命令结束后会在当前进程再次调用 `reloadSenses()`，供后续热重载入口复用。

### RuntimeSelection 与 RuntimeResolver

```ts
// runtimeResolver.ts
export interface RuntimeSelection {
  brain: string;            // brain 名称（→ config.llm.brain[name]）
  senseGroup: string;       // 感官组名；无 Tool Call brain 时为空字符串
  mcpServers: string[];     // 启用的 MCP server 名数组（已连接 server 的全部 MCP sense 合并进 schema）
}

export class RuntimeResolver {
  resolve(selection: RuntimeSelection): RuntimeConfig { /* ... */ }
}
```

`RuntimeConfig` 字段（来自 [core/middleware/types](../../src/core/middleware/types.ts)）：

| 字段 | 来源 | 用途 |
|------|------|------|
| `brain` | `config.llm.brain[name]` | model/url/key/thinking/provider |
| `adapters` | `getLLMAdapter/getMessageAdapter/getSenseAdapter(provider)` | LLM/Message/Sense 三件套 |
| `builtSenses` | `senseAdapter.buildSenses(senses)` | 给 LLM 的 function 列表 |
| `senseTable` | `Map<name, SenseEntry>` | name → 监管等级 + 执行器 |

`mcpServers` 绕过 `sense_groups`：enabled server 的全部 `mcp__<server>__*` sense 会合并进 `builtSenses/senseTable`，监管等级来自 MCP server 默认值。启用未连接 server 会 fail loud。

**能力约束：** `brain.capabilities.toolCall !== false` 时必须选择非空 `senseGroup`；`toolCall:false` 时 `senseGroup` 必须为空且 `mcpServers` 必须为空，resolver 返回空 `builtSenses/senseTable`。`generate_image/video/audio` 仅在 brain 的 `capabilities.generate.<kind>` 为真时进入 schema。完整能力与媒体链见 [../model-capabilities.md](../model-capabilities.md)。

**监管等级优先级链**（[runtimeResolver.ts resolveSense](../../src/agent/runtimeResolver.ts)）：

```text
感官组 ":level" 后缀覆盖（如 "execute_command:auto"）
    ↓ 落空
前组已解析（多组叠加时，后组覆盖前组同名 sense 的等级——实为浅覆盖同名 sense 整体）
    ↓ 落空
感官内置 supervisionLevel 字段（如 write_file 声明 manual）
    ↓ 落空
global.supervision
```

> ⚠ 代码用 `resolved.set(name, s)` 按 sense **函数名**去重，后组会**整体替换**前组的 Sense 实例（不只覆盖等级）。`shallow copy` 隔离写入：监管等级写入不得污染全局 `senseRegistry`（多 chat 共享）。

### AgentBuilder 三阶段

```ts
// builder.ts
const agent = new AgentBuilder()
  .build()                                  // ① 创建空 AgentSession（注入 global/handlers/loopHandler）
  .configureRuntime({ brain, senseGroup, mcpServers }) // ② 原子解析 runtime 并注入
  .init(chatId, history);                   // ③ 绑定 chatId + 注入历史（无则首条 system prompt）

agent.run(input);       // send
agent.resume();         // chat.resume（无 prompt）
agent.revokeTrailingCycle();  // 撤回末尾整个当前周期 AI 响应
```

**三阶段为何分离：**

- `build()` 只注入**跨轮不变项**（global config + handlers + loopHandler），不感知具体 brain/sense。
- `configureRuntime()` **原子**注入 brain + adapters + builtSenses + senseTable——避免 Provider 与工具定义处于半配置状态（[builder.ts configureRuntime 注释](../../src/agent/builder.ts)）。
- `init()` 仅一次（AgentSession 用 `inited` 守卫），绑 chatId 并注入历史/首条 system prompt。runtime 缓存（`chatRuntimes: Map<chatId, {builder, selection}>`）在 [service/chat/runtime.ts](../../src/service/chat/runtime.ts)，**不在** AgentSession 内。

`run()` 直接透传 `AgentSession.send(input)`，`resume()` 在 `hasPendingTrailingSense()` 时置 `resumePending=true` 后 `run("")`（详见 [./middleware.md](./middleware.md) 的 sense 中间件 resume 分支）。

## 关键流程

### chat 全生命周期（agent 视角）

```text
service 收到 chat.create
  → 从 chatRuntimes 取/建 builder
  → builder.build().configureRuntime(selection).init(chatId, history)
service 收到 chat.send(chatId, prompt)
  → builder.run(prompt)  ──→ AgentSession.send
                              │
                              ▼
                         loopHandler 循环 runChain
                              │
                              ▼
                         洋葱链：checkpoint → sense → retry → chat
                              │
                              ▼
                         chunks（含 effect）流回 service observer
```

### 启动序列

```text
src/index.ts（服务入口）
  → await bootstrapAgentRuntime()
       ├─ registerBuiltinProviders()  （openai/ollama/mock）
       ├─ await reloadSenses()
              ├─ resetSenses()
              ├─ registerBuiltinSenses() （bash/read/write/skill/search_codebase）
              └─ await loadCustomSenses() （编译产物 senses/*.js）
       └─ await loadMcpSenses() （连接 MCP server 并注册 mcp__<server>__* senses）
```

## 依赖与关联 ⭐

### 依赖（agent → 其他层）

| 依赖项 | 路径 | 用途 |
|--------|------|------|
| core/middleware | [core/middleware/](../../src/core/middleware/) | `AgentSession` 门面、`MiddlewarePipeline`、`MessageJournal`、`MiddlewareContext`/`RuntimeConfig`/各 Chunk 类型、`compose` |
| core/sense | [core/sense/](../../src/core/sense/) | `sense()` 工厂、`Sense`/`SenseResult`/`SenseSharedData`、`registerSenses/resetSenses/getSense`、`createApproval`（审批 Promise） |
| core/llm/adapter | [core/llm/adapter.ts](../../src/core/llm/adapter.ts) | `LLMAdapter` 接口、`getLLMAdapter` 注册表、`LLMOptions` |
| core/message/adapter | [core/message/adapter.ts](../../src/core/message/adapter.ts) | `MessageProviderAdapterConfig`、`registerMessageAdapter`、`LLMResponse`、`ReplaceInfo` |
| core/sense/adapter | [core/sense/adapter.ts](../../src/core/sense/adapter.ts) | `SenseAdapter` 接口、`registerSenseAdapter`、`SenseCallData`、`SenseFunction` |
| core/config | [core/config.ts](../../src/core/config.ts) | `SupervisionLevel` 枚举（auto=0/confirm=1/manual=2） |
| utils/config | [utils/config.ts](../../src/utils/config.ts) | `config.global`、`config.llm.brain`、`config.sense_groups`、`BrainConfig`/`MockScriptResponse` 类型 |
| utils/hash | [utils/hash.ts](../../src/utils/hash.ts) | `hashGenerator`（read_file/write_file/skill 的去重 hash） |
| utils/drain | [utils/drain/](../../src/utils/drain/) | `compressLog`（read_file 大日志文件去重） |
| utils/rateLimiter | [utils/rateLimiter.ts](../../src/utils/rateLimiter.ts) | `getRateLimiter`（OpenAI Provider 的 RPM 滑动窗口节流） |
| utils/logger | [utils/logger/](../../src/utils/logger/) | `logger.info/warn/error/tools.*`（含 `BashLogInfo`、bash 日志工具） |
| 第三方 | openai、ollama、zod、js-yaml、dayjs | 各 Provider SDK + schema/frontmatter/时间 |

### 被依赖（谁调用 agent）

| 调用方 | 调用点 |
|--------|--------|
| [service/chat/send.ts](../../src/service/chat/send.ts) | `AgentBuilder`、`parseRuntimeSelection`、`RuntimeResolver`、observer 消费 agent 输出的 effect chunk |
| [service/chat/handler.ts](../../src/service/chat/handler.ts) | `parseRuntimeSelection`（chat.create/runtime.set 校验） |
| [src/index.ts](../../src/index.ts) | `bootstrapAgentRuntime()`、`compile-senses` 子命令（用 `reportSenseCompileResult`） |

### 横切参考

| 文档 | 何时参考 |
|------|----------|
| [../service/chat.md](../service/chat.md) | 审批流程的 service 侧（`ApprovalManager`、`fillApprovalResult`）、observer 如何消费 effect chunk |
| [../interaction.md](../interaction.md) | chat.send/resume 的完整 C↔S 交互序列、撤回/续接规则 |
| [../mock.md](../mock.md) | mock Provider 的脚本回放机制与测试场景对照 |
| [../protocol.md](../protocol.md) | chunk 类型到 wire 帧的映射 |

## 扩展点

### 添加 Provider

详见 [./provider.md](./provider.md)「扩展点」。要点：在 `provider/` 新增 `<name>.ts`，导出 `register<Name>Adapter()`，在 [provider/index.ts](../../src/agent/provider/index.ts) 的 `registerBuiltinProviders()` 中调用。

### 添加内置 Sense

详见 [./sense.md](./sense.md)「扩展点」。要点：在 `sense/` 新增 `<name>.ts` 用 `sense()` 工厂创建，在 [sense/index.ts](../../src/agent/sense/index.ts) 的 `registerBuiltinSenses()` 中 `registerSenses([...])`。

### 添加外部（编译产物）Sense

在 `.chery/senses/<name>.ts` 创建文件，系统启动时由 `loadCustomSenses` 用 `new Function()` 执行（注入 `z`/`sense`/`SupervisionLevel`/`registerSenses`）。编译机制见 [core/sense/compiler](../../src/core/sense/compiler/)。

### 添加中间件

详见 [./middleware.md](./middleware.md)「扩展点」。要点：在 `middleware/` 新增文件实现 `MiddlewareHandler`，在 [middleware/index.ts](../../src/agent/middleware/index.ts) 的 `defaultHandlers` 数组按顺序插入（位置决定洋葱层级）。
