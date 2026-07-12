# MCP（Model Context Protocol 接入）

> 源码 [src/core/mcp/](../../src/core/mcp/) ｜ 上级 [core/README.md](./README.md) ｜ 相关 [sense.md](./sense.md)、[compiler.md](./compiler.md)

## 职责

`core/mcp/` 把外部 MCP server 的 tools/resources/prompts 映射为 **Sense** 注册进全局 [senseRegistry](./sense.md)，复用框架既有的监管等级（auto/confirm/manual）、审批、checkpoint、loop 机制。

分**两层**：

| 层 | 职责 | 入口 |
|----|------|------|
| **连接层**（global registry） | 哪些 server 连着、sense 在 registry；支持运行期 connect/disconnect/reload，不重启 | `core/mcp/loader` 状态机；`mcp.*` RPC（[service/mcp/handler](../../src/service/mcp/handler.ts)） |
| **挂载层**（per-chat schema） | chat 启用哪些**已连** server → 其全部 `mcp__<server>__*` 合并进该 chat schema，**不走 sense_groups** | [runtimeResolver](../../src/agent/runtimeResolver.ts) `RuntimeSelection.mcpServers` |

与 [compiler.md](./compiler.md)（编译本地 `.chery/senses/*.ts` 外部感官）并列——两者都往 senseRegistry 注入 Sense：compiler 注入本地源码产物，mcp 注入远程/子进程 server 的能力。mcp/ 是 core/ 第二个带 I/O 的子模块（网络 / 子进程）。

## 文件清单

| 文件 | 职责 |
|------|------|
| [types.ts](../../src/core/mcp/types.ts) | `McpClientHandle`、`McpSenseContext`、`McpServerInfo`、`McpServerError`、命名常量（`MCP_PREFIX="mcp__"`） |
| [client.ts](../../src/core/mcp/client.ts) | `connectMcpServer()`：按 transport（stdio / streamable-http）构造 transport，Client 握手 |
| [convert.ts](../../src/core/mcp/convert.ts) | `toolToSense` / `resourceToSense` / `promptToSense`：MCP 能力 → `Sense` |
| [loader.ts](../../src/core/mcp/loader.ts) | 连接层状态机：`Map<name,{handle,senseNames}>` + lastError；导出 `listMcpServers`/`getMcpServer`/`connectMcpServerByName`/`disconnectMcpServer`/`reloadOneServer`/`reloadMcpServers`/`getConnectedServerSenseNames`/`listConnectedServerNames`；`loadMcpSenses`/`closeMcpClients` 为启动/关闭 wrapper |
| [index.ts](../../src/core/mcp/index.ts) | barrel |

## 配置

config.yaml 顶层 `mcp_servers`（[.chery/config.yaml](../../.chery/config.yaml) 有注释示例）：

```yaml
mcp_servers:
  filesystem:
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    supervision: confirm
  remote:
    transport: streamable-http
    url: http://localhost:8081/mcp
    supervision: auto
```

- `transport`：`stdio`（本地子进程，需 `command`/`args`/`env`）或 `streamable-http`（远程 HTTP，需 `url`）。
- `supervision`：server 级默认监管等级，覆盖 `global.supervision`。MCP 绕过 sense_groups，**无 `:level` 后缀覆盖**（详见下「监管优先级链」）。
- 配置类型见 [`utils/config.ts`](../../src/utils/config.ts) `McpServerConfig`。

## 核心概念 / 导出

### 命名规则

每个 MCP 能力注册为 Sense 时加前缀防跨 server 冲突：

| MCP 能力 | Sense 名 |
|----------|----------|
| tool `<tool>` | `mcp__<server>__<tool>` |
| resources（整组合一） | `mcp__<server>__read_resource` |
| prompts（整组合一） | `mcp__<server>__get_prompt` |

> resources/prompts 各合并为单个 sense（参数 `uri` / `name`），description 注入连接时拉取的可用清单；tools 一对一。

### tool → Sense 转换（关键设计）

绕过 [`sense()`](./sense.md) 工厂——MCP tool 自带 JSON Schema（inputSchema），反向转 zod 易丢精度；直接构造 `Sense<ZodType>`：

- `definition`：用 MCP 的 inputSchema 补全为 `SenseFunction.parameters`（`additionalProperties:false`）。
- `executor.schema`：占位 `z.record(z.string(), z.unknown())`——运行期 [`doExecuteSense`](../../src/agent/middleware/tool.ts) 用 `safeJsonParse` 得 args 直传 execute，**不 parse schema**；参数校验由 MCP server 侧负责。
- `executor.execute`：调 `client.callTool({name, arguments})`，提取返回 content 中的 text；非 text（图片/二进制）降级为占位说明。
- `hash`：恒空字符串——MCP 调用无"内容未变"语义，不参与历史去重（与 write_file 一致）。
- `supervisionLevel`：server 级默认值。

### 挂载模型（mcpServers，绕过 sense_groups）

MCP tool 名只能经 server API 发现，逼用户手写进 `sense_groups` 认知负担过重。故 MCP **不走 sense_groups**，改为按 **server 粒度**在 runtime 层开关：

- `RuntimeSelection` 增 `mcpServers: string[]`（enabled server 名，与 `senseGroup` 同层级、同原子性）。
- 经 `chat.create` / `runtime.set` 原子携带（brain + senseGroup + mcpServers），不新增 RPC 方法。前端按 server 渲染开关（`brain.list` 返回 `mcpServers` = 当前已连 server 名）。
- [runtimeResolver](../../src/agent/runtimeResolver.ts) `resolveSense`：sense_groups 解析后追加遍历 `selection.mcpServers` → `getConnectedServerSenseNames(name)` → 每个 `getSense` → 合并进 resolved Map（去重冲突 MCP 覆盖）。
- enabled server 的**全部** `mcp__<server>__*` sense 进 builtSenses + senseTable；持久化随 `metadata.runtime` 自动写入，重启 `ensureChat` 恢复；旧 chat 无此字段视为 `[]`。
- **唯一挂载路径** = `mcpServers` 开关；不再把 `mcp__` 写进 sense_groups。

> **边界**：连接 ≠ 对 chat 可见。`mcp.connect` 只入 registry；chat 须经 `mcpServers` 启用其 tools 才进 schema。enable 未连 server → resolve 抛 `MCP server "X" not connected`（fail loud）。

### 监管优先级链

MCP sense 绕过 sense_groups，**无 `:level` 后缀覆盖**。最终监管等级：

1. `mcp_servers.<name>.supervision`（转换时写入 `Sense.supervisionLevel`）
2. `global.supervision`（兜底）

> runtimeResolver 合并 MCP sense 时：`original.supervisionLevel ?? config.global.supervision`。

## 关键流程

```text
─── 启动期（agent/bootstrap.ts bootstrapAgentRuntime） ──────────
  ├─ registerBuiltinProviders()
  ├─ reloadSenses()          reset + 内置 + 外部编译产物
  └─ loadMcpSenses()         遍历 config.mcp_servers
       └─ 每个 server → connectMcpServerByName(name):
            ├─ connectMcpServer()      buildTransport + Client.connect(握手)
            ├─ getServerCapabilities()
            ├─ caps.tools?     listTools → 每个 toolToSense
            ├─ caps.resources? listResources → resourceToSense(合一)
            └─ caps.prompts?   listPrompts → promptToSense(合一)
            → registerSenses + connectedServers.set(name,{handle,senseNames})
       (单个失败 warn + lastError 记录,不阻断启动)

─── 挂载层（chat.create / runtime.set → resolveSense） ─────────
RuntimeSelection { brain, senseGroup, mcpServers }
  └─ resolveSense: sense_groups 解析后追加
       for serverName in mcpServers:
         getConnectedServerSenseNames(name)   ← 未连 throw NOT_FOUND(fail loud)
         → 每个 getSense → shallow copy + server 级 supervision → 合并进 resolved Map
     → builtSenses + senseTable 含 enabled MCP tools
  （持久化 metadata.runtime；重启 ensureChat 自动恢复）

─── 运行期（零特例,复用 sense 链） ─────────────────────────────
LLM 产出 senseCalls 含 mcp__<server>__<tool>
  → senseMiddleware buildSenseTrigger(senseTable 已含 MCP sense)
  → doExecuteSense → senseEntry.execute(args)
     → client.callTool(tool.name, args) → extractText → { content, hash:"" }
  → 结果回灌为 sense 消息,loop 进入下一轮

─── 连接层管理（mcp.* RPC,运行期热重载） ───────────────────────
mcp.list    → listMcpServers()                config 所有 server + 状态
mcp.get     → getMcpServer(name)              单个详情
mcp.connect → connectMcpServerByName(name)    已连幂等;建连+register
mcp.disconnect → disconnectMcpServer(name)    未连幂等;unregister+close
mcp.reload  → reloadOneServer(name) | reloadMcpServers()
  原子交换(单 server):
    1. buildSensesForServer(新连接, async)   ← 失败保留旧态
    2. registerSenses(新) + unregisterSenses(旧差集)   同 tick 无 await
    3. oldHandle.close()                     注册表已指向新
  全量 reload: reloadMcpServersConfig() 重读 yaml → 断开已移除 server → 逐个原子重载

─── 关闭期（src/index.ts SIGINT/SIGTERM 钩子） ──────────────────
closeMcpClients() → 各 disconnectMcpServer (unregister + handle.close)
```

> **MCP 不纳入 reloadSenses**：`compile-senses` 子命令走独立路径（不调 bootstrap），不触发 MCP 连接。若未来热重载 sense 调 `resetSenses`，MCP sense 会随 registry 清空丢失——届时需单独处理。注意两条路径的差异：
> - **MCP-API 路径**（`mcp.disconnect`/`reload`）：用 `unregisterSenses` 外科式删除/差集，仅动该 server 的 `mcp__*`，不影响内置/编译 sense。
> - **reloadSenses 路径**（若实现）：`resetSenses` 全清，MCP sense 丢失风险不变（与现有「热重载触发机制另行实现」一致）。

## 依赖与关联

- **依赖**：
  - `@modelcontextprotocol/sdk`（官方 SDK：`Client` / `StdioClientTransport` / `StreamableHTTPClientTransport`）。
  - [`core/sense`](../../src/core/sense/) `registerSenses` / `unregisterSenses` / `getSense`、`Sense`/`SenseResult`/`SenseFunction` 类型。
  - [`utils/config.ts`](../../src/utils/config.ts) `config.mcp_servers`、`McpServerConfig`、`reloadMcpServersConfig`。
  - [`utils/logger`](../utils/README.md)。
- **被依赖**：
  - [`agent/bootstrap.ts`](../../src/agent/bootstrap.ts) —— `loadMcpSenses()`（启动期）。
  - [`agent/runtimeResolver.ts`](../../src/agent/runtimeResolver.ts) —— `getConnectedServerSenseNames` / `listConnectedServerNames`（挂载层合并进 schema）。
  - [`service/mcp/handler.ts`](../../src/service/mcp/handler.ts) —— `mcp.*` RPC（连接层管理）。
  - [`service/brain/list.ts`](../../src/service/brain/list.ts) / [`chat/handler.ts`](../../src/service/chat/handler.ts) / [`runtime/set.ts`](../../src/runtime/set.ts) —— `mcpServers` 透传。
  - [`src/index.ts`](../../src/index.ts) —— `closeMcpClients()`（SIGINT/SIGTERM 钩子）。
- **横切参考**：[sense.md](./sense.md)（senseRegistry / 监管等级 / `doExecuteSense` 执行路径）、[compiler.md](./compiler.md)（另一个 sense 注入源）、[agent/middleware.md](../agent/middleware.md)（sense 中间件复用）、[protocol.md](../protocol.md)「MCP 管理 API」。

## 扩展点

### 加一个 MCP server

1. 在 `.chery/config.yaml` 顶层 `mcp_servers` 加一项（name → transport + 参数 + 可选 supervision）。
2. 接入 registry（二选一）：
   - 重启服务 → `bootstrapAgentRuntime` → `loadMcpSenses` 自动连接；
   - 或运行期 `mcp.reload`（全量重读 config 拾取新 server，不重启）。
3. 挂载到 chat：`chat.create` / `runtime.set` 的 `mcpServers` 加该 server 名 → 其全部 `mcp__<server>__*` 自动进 schema（**无须写进 sense_groups**）。

### 加 transport 类型

在 [client.ts](../../src/core/mcp/client.ts) `buildTransport()` 加分支 + `McpServerConfig.transport` 联合类型扩成员。

### schema 双轨（冲突说明）

内置 / 外部 sense 用 zod→JSONSchema（[`sense()`](./sense.md) 工厂）；MCP sense 反向（JSONSchema 已有，占位 zod）。两者并存，不混合。`buildSenseTable` / `doExecuteSense` 运行期不依赖 schema 字段校验，故安全。
