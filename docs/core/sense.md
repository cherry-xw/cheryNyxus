# Sense（感官定义、监管、注册与审批）

> 源码 [src/core/sense/](../../src/core/sense/) ｜ 上级 [core/README.md](./README.md) ｜ 相关 [middleware.md](./middleware.md)、[compiler.md](./compiler.md)、[db.md](../db.md)

## 职责

`core/sense/` 定义「感官」（= 工具 / function calling）的全部抽象：怎么声明一个感官（`sense()` 工厂）、感官注册表（`senseRegistry`）、provider 如何把感官转成自家格式并提取调用（`SenseAdapter`）、以及 confirm/manual 监管下的审批 Promise 管理（`approvalRegistry`）。

感官是 Agent 与外部世界交互的唯一通道：LLM 产出 `senseCalls` → `senseMiddleware` 按监管等级执行 → 结果回灌为新的 `sense` 角色消息，进入下一轮 LLM 调用。内置感官（bash/read/write/skill）在 [`agent/sense/`](../../src/agent/sense/) 实现，外部感官在 `.chery/senses/*.ts` 由 [compiler.md](./compiler.md) 编译。

## 文件清单

| 文件 | 职责 |
|------|------|
| [senseCreator.ts](../../src/core/sense/senseCreator.ts) | `sense()` 工厂、`Sense` / `SenseFunction` / `SenseExecutor` / `SenseResult` / `SenseSharedData` 类型 |
| [adapter.ts](../../src/core/sense/adapter.ts) | `SenseCallData`、`SenseAdapter` 接口、`senseAdapterRegistry` + 注册三件套 |
| [senseRegistry.ts](../../src/core/sense/senseRegistry.ts) | 全局感官实例注册表（name → `Sense`），`registerSenses` / `resetSenses` / `getSense` |
| [approvalRegistry.ts](../../src/core/sense/approvalRegistry.ts) | core 层审批 Promise 注册表（`createApproval` / `resolveApproval` / `rejectApproval`），confirm/manual 感官 await 用户审批 |
| [questionRegistry.ts](../../src/core/sense/questionRegistry.ts) | core 层问题 Promise 注册表（`createQuestion` / `resolveQuestion` / `rejectQuestion`），ask_user_question 感官 await 用户答案（auto 路径，不走 approval 流） |
| [index.ts](../../src/core/sense/index.ts) | barrel：聚合导出上述模块 |

> ⚠ CLAUDE.md 旧描述提到 `senseManager.ts`，**真实代码不存在**；其职责（按 name 取监管等级 + 执行）已被 `RuntimeConfig.senseTable: Map<string, SenseEntry>` 替代，在 builder 摊平时注入。

## 核心概念 / 导出

### sense() 工厂（定义一个感官）

> ⚠ 签名是**位置参数**，不是 CLAUDE.md 旧文档写的对象字面量 `{ name, description, parameters, ... }`。

```ts
export function sense<T extends z.ZodType>(
  name: string,
  description: string,
  schema: T,
  handler: (input: z.infer<T>, senseSharedData: SenseSharedData, ctx?: SenseRuntimeContext) => Promise<SenseResult>,
  supervisionLevel?: SupervisionLevel,   // 感官内置监管等级，未声明时外部 fallback
): Sense<T>;
```

返回的 `Sense<T>` 包含三部分：

```ts
export interface Sense<T extends z.ZodType> {
  definition: SenseFunction;            // 给 LLM 的工具声明（OpenAI function 格式）
  executor: SenseExecutor<T>;           // schema + execute，运行期 args 校验与执行
  supervisionLevel: SupervisionLevel | undefined;  // 感官声明等级（优先级链第 2 级）
}
```

`definition` 由 `schema.toJSONSchema()` 自动生成（zod → JSON Schema），无需手写参数描述：

```ts
export interface SenseFunction {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, { type?; items?; description?; enum? }>;
      required: string[];
      additionalProperties: boolean;   // 固定 false
    };
  };
}
```

执行结果：

```ts
export interface SenseResult { content: string; hash: string; }

export interface SenseRuntimeContext {
  chatId: string;
}
```

`hash` 用于**历史去重**（如 `read_file` 的 hash 含文件 mtime：新读取命中相同 hash = 文件未变 → 旧 sense 消息被替换为短说明，详见 [`agent/middleware/tool.ts`](../../src/agent/middleware/tool.ts) `doExecuteSense`）。

**hash 语义约束**：hash 仅用于"内容稳定可折叠"型 sense（如 read_file 类文件读取）。**派发标识型** sense（hash 命中 ≠ 重复派发任务，仅是同一子 chat 复用等）不应返回 hash，否则会被 `doExecuteSense` 错误触发 `replaceSense` 折叠，造成 prompt 参数丢失 + 链式替换。`tool.ts` 维护 `NON_DEDUPABLE_SENSES` 黑名单作为双保险（当前含 `spawn_role`）。

### SenseSharedData（感官间共享数据）

```ts
export type SenseSharedData = Map<string, Map<string, unknown>>;
// 外层 namespace → 内层 identifier → data
```

随 `MiddlewareContext.soul.senseSharedData` 在同一 chat 的感官间传递。需要按 chatId 归属的感官（如 bash）从 executor 第三参 `SenseRuntimeContext.chatId` 读取；该 ctx 由 [`agent/middleware/tool.ts`](../../src/agent/middleware/tool.ts) 调 `senseEntry.execute(args, sharedData, { chatId })` 时注入。

### SenseAdapter（provider 格式适配）

```ts
export interface SenseAdapter<TMessage, TResponse> {
  buildSenses(senses: Sense<ZodType>[]): SenseFunction[];           // Sense → provider 工具声明
  senseCalls(response: TResponse): SenseCallData[];                  // 完整响应 → sense 调用列表
  extractSenseCallDeltas(chunk: unknown): SenseCallData[];           // 流式 chunk → sense 增量
}
```

`SenseCallData` 是统一的感官调用数据结构（流式 / 非流式共用）：

```ts
export interface SenseCallData {
  index?: number;      // 流式累积定位（OpenAI delta.sense_calls[].index）
  id: string;          // 唯一标识：LLM 的 tool_call.id 或 sense-${index}
  name?: string;       // 感官名（首 delta 出现，后续可能空）
  arguments: string;   // 参数 JSON（完整 or 增量片段）
}
```

注册：

```ts
registerSenseAdapter<TMessage, TResponse>(provider, adapter): void
getSenseAdapter(provider): SenseAdapter<unknown, unknown> | undefined
// senseAdapterRegistry 是导出的 Map（部分 provider 直接 .set）
```

### senseRegistry（全局感官实例注册表）

进程级单例 `Record<string, Sense<ZodType>>`，**所有 chat 共享**。chat 间感官隔离不在 registry 层做，而在 builder 解析 `senseGroup` 时按名称取子集 + 摊平监管等级。

```ts
registerSenses(senses: Sense<ZodType>[]): void   // 批量注册（按 definition.function.name 索引）
resetSenses(): void                              // 清空（reloadSenses 重建前调用，避免已删外部 sense 残留）
getSense(name: string): Sense<ZodType> | undefined
```

启动期由 [`agent/sense/index.ts`](../../src/agent/sense/index.ts) `reloadSenses()` 重建：`resetSenses()` → 注册内置 → 加载 [compiler](./compiler.md) 编译产物。

### approvalRegistry（core 层审批 Promise）

> **P1-11 解耦**：原设计把 `approvalResolve` 函数指针塞进 chunk，core 依赖 service 层 ApprovalManager 回调——分层违反。解耦后 core（senseMiddleware）在此创建 Promise 并 `await`；chunk 只产 `{approvalId, needsApproval}` 事实；service `ApprovalManager` 通过 `resolveApproval/rejectApproval` 触发对应 Promise。

```ts
export type ApprovalDecision = { action: "accept" | "reject"; reason?: string };

createApproval(id: string): Promise<ApprovalDecision>     // senseMiddleware 在 confirm/manual 时调
resolveApproval(id: string, action, reason?): void        // service ApprovalManager.confirm 调 → resolve
rejectApproval(id: string, error: Error): void           // service ApprovalManager.abort 调 → reject
```

`id` 用 LLM 返回的 `tool_call.id`（与 `SenseTriggerChunk.id` 一致）。

## Sense 监管等级

> 行为定义在 [`SupervisionLevel`](./README.md#supervisionlevel-枚举) 枚举（[`core/config.ts`](../../src/core/config.ts)）；最终值由 [`RuntimeResolver`](../../src/agent/runtimeResolver.ts) 按下面的优先级链摊平时写入 `senseTable[name].supervisionLevel`。

| 等级 | 值 | 行为 |
|------|----|------|
| `auto` | 0 | 自动执行，推送 accept notification |
| `confirm` | 1 | 推送 interrupt notification，等待审批（senseMiddleware `await createApproval(id)`） |
| `manual` | 2 | 推送 interrupt notification，禁止自动执行，仅手动触发 |

**优先级链**（高 → 低，最终值在 builder 层 [`RuntimeResolver`](../../src/agent/runtimeResolver.ts) 摊平时写入 `senseTable[name].supervisionLevel`）：

```text
1. sense_groups 中感官配置覆盖（如 "execute_command:auto"，最高优先级）
2. 感官内置 supervisionLevel 字段（sense() 第 5 参数）
3. global.supervision（最低优先级）
```

> 运行期 `senseMiddleware` 不再回退到 `global.supervision`——优先级链已在摊平时算完。`buildSenseTrigger`（agent/middleware/tool.ts）取 `senseTable.get(name)?.supervisionLevel ?? SupervisionLevel.confirm` 兜底。

## 关键流程 / 数据流

```text
─── 启动期：注册感官 ────────────────────────────────────────────
agent/sense/index.ts reloadSenses()
  ├─ resetSenses()
  ├─ registerSenses([bash, read, write, skill])      内置感官用 sense() 定义
  └─ loadCustomSenses()                              读 compiler 产物 dist/senses/*.js
       └─ new Function("z","sense","SupervisionLevel","registerSenses", code)
            注入运行时上下文执行 → registerSenses([...])

─── 配置期：builder 摊平 senseTable ─────────────────────────────
AgentBuilder.configureRuntime({brain, senseGroup})
  └─ RuntimeResolver 按 senseGroup 从 senseRegistry 取子集
     ├─ 计算每个感官最终 supervisionLevel（优先级链）
     ├─ senseAdapter.buildSenses(subset) → builtSenses: SenseFunction[]
     └─ 摊平 senseTable: Map<name, {supervisionLevel, execute}>
        → 注入 Middleware.configureRuntime

─── 运行期：感官执行 ────────────────────────────────────────────
chatMiddleware yield StreamChunk（含 senseDelta）
  └─ senseMiddleware 收集 senseDelta、检测完整 call
     ├─ buildSenseTrigger → yield SenseTriggerChunk(sense_end)
     │   ├─ checkpoint 收集 → yield MessageCreatedChunk(assistant) + SensePendingChunk
     │   └─ service observer 落库 assistant + 注册 ApprovalManager
     └─ executeCollectedCalls:
        ├─ auto：直接 senseTable.get(name).execute(args, sharedData, {chatId})
        └─ confirm/manual：createApproval(id) → await → resolveApproval 触发 → 执行 or 跳过
           → yield SenseAcceptChunk / SenseRejectChunk
              ├─ checkpoint → yield MessageCreatedChunk(sense 结果消息)
              └─ loop 进入下一轮：把 sense 结果作为新消息喂给 LLM
```

## 依赖与关联

- **依赖**：
  - `zod`（sense 工厂的 schema 类型）。
  - [`SupervisionLevel`](./README.md#supervisionlevel-枚举)（`core/config`）。
  - [compiler/utils.ts](./compiler.md) `buildBaseSenseFunction`（被 provider 用于构造 SenseFunction，不在 sense 本模块）。
- **被依赖**：
  - [`agent/sense/{bash,read,write,skill}.ts`](../../src/agent/sense/) —— 用 `sense()` 定义内置感官。
  - [`agent/sense/index.ts`](../../src/agent/sense/index.ts) —— `registerSenses` / `resetSenses`，`loadCustomSenses` 加载 compiler 产物。
  - [`agent/middleware/tool.ts`](../../src/agent/middleware/tool.ts) —— `createApproval` 在 confirm/manual 时建审批 Promise；用 `senseTable` 执行感官。
  - [`agent/middleware/chat.ts`](../../src/agent/middleware/chat.ts) —— 用 `SenseFunction` / `SenseCallData` 类型。
  - [`agent/provider/{openai,ollama,mock}.ts`](../../src/agent/provider/) —— `registerSenseAdapter`、`buildBaseSenseFunction`。
  - [`agent/runtimeResolver.ts`](../../src/agent/runtimeResolver.ts) —— `getSense` / `getSenseAdapter`，摊平 senseTable。
  - [`service/approval/manager.ts`](../../src/service/approval/manager.ts) —— `resolveApproval` / `rejectApproval` 触发 await。
  - [`service/message/types.ts`](../../src/service/message/types.ts)、[`service/chat/streamMapper.ts`](../../src/service/chat/streamMapper.ts) —— 用 `SenseCallData` / `SenseFunction` 类型。
- **横切参考**：[middleware.md](./middleware.md)（senseMiddleware 在洋葱链的位置、Chunk 流）、[db.md](../db.md)（pending sense = content 空、审批状态语义）、[interaction.md](../interaction.md)（审批 interrupt/accept/rejected notification）。

## 扩展点

### 加内置感官

```ts
// src/agent/sense/<name>.ts
import { z } from "zod";
import { sense } from "@/core/sense";
import { SupervisionLevel } from "@/core/config";

export default sense(
  "my_sense",
  "My custom sense",
  z.object({ path: z.string() }),
  async (args, sharedData) => ({ content: `Result: ${args.path}`, hash: "..." }),
  SupervisionLevel.confirm,   // 可选，感官内置监管等级
);
```

然后在 [`agent/sense/index.ts`](../../src/agent/sense/index.ts) `registerBuiltinSenses()` 加入注册列表。

### 加外部感官

见 [compiler.md](./compiler.md)：在 `.chery/senses/<name>.ts` 写源码（运行时由 `new Function` 注入 `z` / `sense` / `SupervisionLevel` / `registerSenses`），编译后由 `loadCustomSenses` 自动注册。
