# Sense（感官定义、监管、注册与审批）

> 源码 [apps/backend/src/core/sense/](../../../apps/backend/src/core/sense) ｜ 上级 [core/README.md](README.md) ｜ 相关 [middleware.md](middleware.md)、[compiler.md](compiler.md)、[db.md](../db/README.md)

## 职责

`core/sense/` 定义「感官」（= 工具 / function calling）的全部抽象：怎么声明一个感官（`sense()` 工厂）、感官注册表（`senseRegistry`）、provider 如何把感官转成自家格式并提取调用（`SenseAdapter`）、以及 smart/manual 监管下的审批 Promise 管理（`approvalRegistry`）。

感官是 Agent 与外部世界交互的唯一通道：LLM 产出 `senseCalls` → `senseMiddleware` 按监管等级执行 → 结果回灌为新的 `sense` 角色消息，进入下一轮 LLM 调用。内置感官（bash/read/write/skill）在 [`agent/sense/`](../../../apps/backend/src/agent/sense) 实现，外部感官在 `.chery/senses/*.ts` 由 [compiler.md](compiler.md) 编译。

## 文件清单

| 文件                                                               | 职责                                                                                                                    |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| [senseCreator.ts](../../../apps/backend/src/core/sense/senseCreator.ts)         | `sense()` 工厂、执行控制、Observation、checkpoint/recovery 与 `SenseResult` 公共类型                                  |
| [adapter.ts](../../../apps/backend/src/core/sense/adapter.ts)                   | `SenseCallData`、`SenseAdapter` 接口、`senseAdapterRegistry` + 注册三件套                                               |
| [senseRegistry.ts](../../../apps/backend/src/core/sense/senseRegistry.ts)       | 全局感官实例注册表（name → `Sense`），`registerSenses` / `resetSenses` / `getSense`                                     |
| [approvalRegistry.ts](../../../apps/backend/src/core/sense/approvalRegistry.ts) | core 层审批 Promise 注册表（`createApproval` / `resolveApproval` / `rejectApproval`），smart/manual 感官 await 用户审批 |
| [runtimeCache.ts](../../../apps/backend/src/core/sense/runtimeCache.ts)         | 进程内有界 TTL 缓存、脱敏规范 key、单次 observation 去重与 operation id                                                 |
| [recoveryStore.ts](../../../apps/backend/src/core/sense/recoveryStore.ts)       | 本地持久化的纯 observation replay；完整 checkpoint、TTL/容量限制和 recovery_required 边界                           |
| [index.ts](../../../apps/backend/src/core/sense/index.ts)                       | barrel：聚合导出上述模块                                                                                                |

> ⚠ CLAUDE.md 旧描述提到 `senseManager.ts`，**真实代码不存在**；其职责（按 name 取监管等级 + 执行）已被 `RuntimeConfig.senseTable: Map<string, SenseEntry>` 替代，在 builder 摊平时注入。

## 核心概念 / 导出

### sense() 工厂（定义一个感官）

> ⚠ 签名是**位置参数**，不是 CLAUDE.md 旧文档写的对象字面量 `{ name, description, parameters, ... }`。

```ts
export function sense<T extends z.ZodType>(
  name: string,
  description: string,
  schema: T,
  handler: (
    input: z.infer<T>,
    senseSharedData: SenseSharedData,
    ctx?: SenseRuntimeContext,
  ) => Promise<SenseResult>,
  supervisionLevel?: SupervisionLevel, // 感官内置监管等级，未声明时外部 fallback
  capabilities?: SenseCapabilities, // 工具能力声明（第 6 参）：accepts / produces / preprocess / batchSize
): Sense<T>
```

返回的 `Sense<T>` 包含四部分：

```ts
export interface Sense<T extends z.ZodType> {
  definition: SenseFunction // 给 LLM 的工具声明（OpenAI function 格式）
  executor: SenseExecutor<T> // schema + execute，运行期 args 校验与执行
  supervisionLevel: SupervisionLevel | undefined // 感官声明等级（优先级链第 2 级）
  capabilities?: SenseCapabilities // 工具能力声明（见下），供前置调度 / 发送门控 / 生成注入判断
}
```

### 工具能力声明（Sense 第 6 参 capabilities）

工具自己声明「接收什么、产出什么、是否前置执行、每批容量」，供发送门控、前置调度与生成注入判断，**不发给 LLM**（不进 `definition.function.parameters`）：

```ts
export interface SenseCapabilities {
  accepts?: string[] // 接收的媒体类型（image/video/audio）或文件后缀（doc/docx/pdf…）
  produces?: string[] // 产出的媒体类型（image/video/audio）或 text
  preprocess?: boolean // 是否前置执行（缺省 false = 普通后置工具）
  batchSize?: number // 每批最多处理几个媒体项（缺省 = 一次性全量；仅影响工具内部实现）
}
```

| 字段         | 生效点                                                                                               |
| ------------ | ---------------------------------------------------------------------------------------------------- |
| `accepts`    | 前置调度（`preprocess=true` 时按媒体类型/后缀匹配）、发送门控（该类型可上传）                        |
| `produces`   | 生成注入判断（感官组配置即注入，替代大脑 `generate.*` 双门）、`sense.tools` 透传                     |
| `preprocess` | 非多模态模型下，`[[media:]]` 引用在发请求前交给该工具执行，结果替换进消息（不持久化、失败跳过+提示） |
| `batchSize`  | 仅影响工具内部实现（分批调用外部接口）；调度层永远全量传入，工具内部自行分批/合并/管理并发           |

`SenseEntry`（`core/middleware/types.ts`）透传 `capabilities`，供 chat middleware 前置调度查找工具。外部自定义 sense 的能力声明经 `sense()` 第 6 参透传，编译链路无需改动。

`definition` 由 `schema.toJSONSchema()` 自动生成（zod → JSON Schema），无需手写参数描述：

> ⚠ **schema 陷阱**：`z.discriminatedUnion('action', [...])` 转 JSON Schema 时顶层 `required`/`properties` 为 `undefined`（仅 `oneOf` 分支内部有），`required ?? []` 兜底后模型端 tool 定义 `required: []`——必填参数不再被强制，LLM 会漏传（历史事故见 [prompt-guide.md](../agent/prompt-guide.md) 规范 #3）。**必填参数用普通 `z.object` + `z.enum`，且断言 `toJSONSchema().required` 非空**。

```ts
export interface SenseFunction {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, { type?; items?; description?; enum? }>
      required: string[]
      additionalProperties: boolean // 固定 false
    }
  }
}
```

执行结果：

```ts
export interface SenseResult {
  content: string;
  hash?: string;
  observation?: ObservationEnvelope;
  status?: SenseResultStatus;
  errorCode?: SenseErrorCode;
}

export interface SenseRuntimeContext {
  chatId: string;
  signal?: AbortSignal;
  deadlineAt?: number;
  budget?: { timeoutMs?: number; maxOutputChars?: number; maxBytes?: number; maxConcurrent?: number };
  operationId?: string;
}
```

`ObservationEnvelope` 是可选的结构化观察结果，旧 `content/hash` 消费者仍可工作。`normalizeObservation()` 当前只校验 kind、正文类型及 100000 字符上限、来源对象和 URL 协议/凭据；不是完整字段校验，也没有来源数组总大小限制。`untrusted` 缺省为 true，但显式 false 会保留。元数据不能当作模型指令；这些标记不构成抵御提示注入的安全隔离。

## 公共运行时契约（冻结）

`SenseResult` 保留旧的 `content/hash` 字段；新增字段全部可选。`status` 的终态值为 `ok`、`timeout`、`cancelled`、`budget_exceeded`、`provider_error`、`invalid_result` 或 `recovery_required`。失败结果可带结构化 `error`，调用方不得把非 `ok` 结果当作成功内容。

`SenseExecutionBudget` 的 `timeoutMs`、`maxOutputChars`、`maxBytes` 和 `maxConcurrent` 均由 `normalizeSenseExecutionBudget()` 向下限制，模型参数不能提高上限。`maxBytes` 计算 UTF-8 结果正文；下载字节由 Provider 自己限制并写入可选的 `ObservationEnvelope.bytesRead`。

生命周期只允许 `start` 和 `finish` 两类事件。事件仅带 `operationId`、调用标识、时间和终态，不携带输入、密钥或结果正文；观察者异常不能影响执行。通用契约不允许 detached：取消或超时只是结束等待，迟到 handler 仍占用并发名额直到结束，迟到结果不得回灌。

跨重启恢复使用 `SenseCheckpoint`（`version: 1`、`operationId`、`senseCallId`、`status`、`detached: false`）。缺失、版本不支持、字段不完整、状态不是 `completed/rejected` 或没有完成时间，都由 `getSenseRecoveryState()` 返回 `required: true`；恢复只能由上层明确重新执行或拒绝，不能猜测副作用已经完成。

`executeSenseWithControl` 在工具中间件执行路径限制等待时间、并发执行数、正文字符数和 UTF-8 字节数，返回 `ok`、`timeout`、`cancelled`、`budget_exceeded`、`provider_error`、`invalid_result` 或 `recovery_required`。超过字符或字节预算时返回 `budget_exceeded`，并尽可能保留截断标记；预算小于标记本身时只返回预算内正文。非 ok 结果不会被当作成功回灌。

`doExecuteSense` 将执行器的 `status/errorCode` 与 `content/hash/observation` 一并传入 `sense_accept` 或 `sense_reject`；非 ok 结果走结构化 reject，旧 content/hash 消费者仍可读取正文。

#### 并发限制与取消后的后台运行（detached）

- 同一进程中所有经过 `executeSenseWithControl` 的调用共用计数，不按会话或工具名称分开；固定最多 8 个尚未结束的 handler。服务端 `budget.maxConcurrent` 可以进一步收紧当前调用的准入条件，不能提高硬上限；小数向下取整，非有限值使用默认上限。模型参数不参与此判断。
- 满额立即返回 `budget_exceeded`，不排队、不调用 handler。实际 handler 完成或失败后释放名额；取消/超时只结束等待，若 handler 尚未结束，继续占用名额直到其完成或失败。忽略取消且永不结束的 handler 会一直占用名额，这是防止无限启动后台工作的保守选择。
- 默认没有允许 detached（调用结束后继续工作的）操作。超时表示放弃等待，且 AbortSignal 已传给 handler；支持取消的 handler 必须继续传给 provider，并在异步步骤后、写消息或记忆前检查取消。预先取消或已过期的调用不会启动 handler。
- JavaScript Promise 不能强制终止忽略 signal 的代码；迟到结果会被丢弃，不再作为该调用的 Agent 结果回填，迟到的 `yieldTurn` 也不生效。任何明确允许的后台操作都必须另行文档化，且不得在取消后写 Agent 消息或记忆。既有后台命令行为见 [Agent Sense](../agent/sense.md)，不是通用 detached 授权。直接在 handler 内调用数据库的任意代码不受 Promise 隔离，不能把本执行器当作强制安全沙箱。
- 验证入口：[senseCreator.test.ts](../../../apps/backend/test/core/sense/senseCreator.test.ts) 的 `execution control`，覆盖硬上限、拒绝、完成/失败/取消清理与迟到结果丢弃。

`hash` 用于**历史去重**（如 `read_file` 的 hash 含文件 mtime：新读取命中相同 hash = 文件未变 → 旧 sense 消息被替换为短说明，详见 [`agent/middleware/tool.ts`](../../../apps/backend/src/agent/middleware/tool.ts) `doExecuteSense`）。

动态观察结果不得默认使用这个历史 hash。需要短期复用时使用
[`runtimeCache.ts`](../../../apps/backend/src/core/sense/runtimeCache.ts) 的 `BoundedRuntimeCache`：
缓存只在进程内存在，必须同时设置 TTL、条目数和字节上限；`canonicalCacheKey` 会排序查询参数并移除
token、cookie、authorization 等敏感字段。`get()` 明确返回 `miss`、`hit` 或 `stale`，不会把缓存内容写入历史消息或长期记忆。
`createObservationDedupe()` 只在一次 observation 内去重 URL 和结果，跨 observation 不复用。

生产消费者为 [`WebSearchRuntime.search`](../../../apps/backend/src/agent/sense/web/runtime.ts)，经 `web_search` Sense 调用。每个 runtime 实例缓存清洗后的搜索观察（默认 60 秒、128 条、1 MiB），不保存原始网页。key 包含已选 Provider、规范化输入及实际结果/字符上限，只输出摘要，不记录查询原文。不同实例不共享缓存；当前仅用于无登录状态的公开搜索，不可直接用于带用户身份的 Provider。敏感字段名按 `api_key` / `api-key` / `apiKey`、`key`、`token` 等完整名称（开头或 `-`/`_` 分隔）过滤，并非任意秘密识别；如 `keyword`、`hotkey` 等普通字段仍保留其值用于区分缓存。

#### 搜索缓存与恢复

- 成功观察清洗、去重完成且信号未取消后才写入；命中保持原 observedAt，返回独立副本，不产生历史 hash。部分结果以原 truncated 标记整体保存，恢复不补抓被省略的内容。
- 取消、超时、Provider 失败均不写缓存，不自动重试；忽略取消的 Provider 即使迟到完成也不能写入缓存。已有其他成功条目不受影响，过期条目不作为失败备用结果。
- `search` 的服务端第三参数 `replay` 只读取有效缓存；缺失或过期返回 `recovery_unavailable`，绝不调用 Provider。该参数不进入模型 schema。进程重启/新建 runtime 后缓存为空，重放同样返回此错误；只有新的普通搜索调用才重新请求。
- 本机制只重放公开搜索观察，不接受任意工具执行回调，不恢复或重跑写文件、命令等副作用操作；不替代会话已有的显式 resume/审批流程，也不声称这些流程具有跨进程恰好执行一次保证。
- 验证入口：[`webSearchCache.test.ts`](../../../apps/backend/test/agent/sense/webSearchCache.test.ts)（真实 Sense 调用、命中/过期/驱逐、失败和取消迟到、重放/新实例/部分观察）。

### 跨进程恢复存储

[`DurableSenseStore`](../../../apps/backend/src/core/sense/recoveryStore.ts) 是与 `WebSearchRuntime` 进程内缓存分离的持久化边界。它只接受 `replayPolicy: 'observation'` 且 checkpoint 已完成或明确拒绝的记录；使用临时文件加 rename 写入，受 TTL、条目数和 UTF-8 字节上限约束。新进程可读取完整记录并返回独立结果副本。

读取缺失、过期、损坏或不完整 checkpoint 时统一返回 `recovery_required`；side-effecting operation 永不静默重跑，也不会通过该存储恢复。该类目前提供基础持久化 fixture 和 replay/recovery 语义，生产消费者仍需在具体 Sense 入口显式选择它，不会自动替换现有 `WebSearchRuntime` 缓存。

验证入口：[`recoveryStore.test.ts`](../../../apps/backend/test/core/sense/recoveryStore.test.ts)（本地文件重启模拟、重复恢复、TTL/容量、损坏和副作用拒绝）。

运行事件由 [`usageRecorder.ts`](../../../apps/backend/src/service/chat/usageRecorder.ts) 记录 start/finish：终态按执行器 `status/errorCode` 写入，超时、取消、预算耗尽和 Provider 错误不会伪装成 completed；`budget_exceeded` 会将 `truncated` 记录为 true。关闭运行时仍记录 interrupted/cancelled。

**hash 语义约束**：hash 仅用于"内容稳定可折叠"型 sense（如 read_file 类文件读取）。**派发标识型** sense（hash 命中 ≠ 重复派发任务，仅是同一子 chat 复用等）不应返回 hash，否则会被 `doExecuteSense` 错误触发 `replaceSense` 折叠，造成 prompt 参数丢失 + 链式替换。`tool.ts` 维护 `NON_DEDUPABLE_SENSES` 黑名单作为双保险（当前含 `spawn_role`）。

**运行时 schema 校验**：`doExecuteSense`（[agent/middleware/tool.ts](../../../apps/backend/src/agent/middleware/tool.ts)）执行前对 `senseEntry.executor.schema` 做 `safeParse`——校验失败返回结构化错误（列出缺失/非法字段），**不再把原始参数直接丢给 handler**。两个收益：① 空参数调用在进入监管审批**之前**被拦截（避免"空调用进 smart 审批 → 超时被拒"的恶性循环）；② handler 可少写参数兜底逻辑（fail-loud fallback 保留为双保险）。

### SenseSharedData（感官间共享数据）

```ts
export type SenseSharedData = Map<string, Map<string, unknown>>
// 外层 namespace → 内层 identifier → data
```

随 `MiddlewareContext.soul.senseSharedData` 在同一 chat 的感官间传递。需要按 chatId 归属的感官（如 bash）从 executor 第三参 `SenseRuntimeContext.chatId` 读取；该 ctx 由 [`agent/middleware/tool.ts`](../../../apps/backend/src/agent/middleware/tool.ts) 调 `senseEntry.execute(args, sharedData, { chatId })` 时注入。

### SenseAdapter（provider 格式适配）

```ts
export interface SenseAdapter<TMessage, TResponse> {
  buildSenses(senses: Sense<ZodType>[]): SenseFunction[] // Sense → provider 工具声明
  senseCalls(response: TResponse): SenseCallData[] // 完整响应 → sense 调用列表
  extractSenseCallDeltas(chunk: unknown): SenseCallData[] // 流式 chunk → sense 增量
}
```

`SenseCallData` 是统一的感官调用数据结构（流式 / 非流式共用）：

```ts
export interface SenseCallData {
  index?: number // 流式累积定位（OpenAI delta.sense_calls[].index）
  id: string // 唯一标识：LLM 的 tool_call.id 或 sense-${index}
  name?: string // 感官名（首 delta 出现，后续可能空）
  arguments: string // 参数 JSON（完整 or 增量片段）
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

启动期由 [`agent/sense/index.ts`](../../../apps/backend/src/agent/sense/index.ts) `reloadSenses()` 重建：`resetSenses()` → 注册内置 → 加载 [compiler](compiler.md) 编译产物。

### approvalRegistry（core 层审批 Promise）

> **P1-11 解耦**：原设计把 `approvalResolve` 函数指针塞进 chunk，core 依赖 service 层 ApprovalManager 回调——分层违反。解耦后 core（senseMiddleware）在此创建 Promise 并 `await`；chunk 只产 `{approvalId, needsApproval}` 事实；service `ApprovalManager` 通过 `resolveApproval/rejectApproval` 触发对应 Promise。

```ts
export type ApprovalDecision = { action: "accept" | "reject"; reason?: string };

createApproval(id: string): Promise<ApprovalDecision>     // senseMiddleware 在 smart/manual 时调
resolveApproval(id: string, action, reason?): void        // service ApprovalManager.confirm 调 → resolve
rejectApproval(id: string, error: Error): void           // service ApprovalManager.abort 调 → reject
```

`id` 用 LLM 返回的 `tool_call.id`（与 `SenseTriggerChunk.id` 一致）。

## Sense 监管等级

> 行为定义在 [`SupervisionLevel`](README.md#supervisionlevel-枚举) 枚举（[`core/config.ts`](../../../apps/backend/src/core/config.ts)）；最终值由 [`RuntimeResolver`](../../../apps/backend/src/agent/runtimeResolver.ts) 按下面的优先级链摊平时写入 `senseTable[name].supervisionLevel`。

| 等级     | 值  | 行为                                                                                                                       |
| -------- | --- | -------------------------------------------------------------------------------------------------------------------------- |
| `auto`   | 0   | 自动执行，推送 accept notification                                                                                         |
| `smart`  | 1   | 按规则表判定：危险操作（黑名单命中 / `false` 硬开关 / 取参异常）需确认；其余（含未知 sense）自动执行（fail-open 默认放行） |
| `manual` | 2   | 推送 interrupt notification，禁止自动执行，仅手动触发                                                                      |

> **smart 档判定**：[`buildSenseTrigger`](../../../apps/backend/src/agent/middleware/tool.ts) 对 smart 档调 [`apps/backend/src/core/sense/sensitivity.ts`](../../../apps/backend/src/core/sense/sensitivity.ts) 的 `isSafeSenseCall(ruleSet, name, args)` 计算有效执行等级——`safe`（未命中 `dangerPatterns` 且非 `false`）→ 降为 `auto` 直接执行；`unsafe`（命中危险 / `false` 硬开关 / 取参异常）→ 保持 `smart` 推 interrupt 建审批。**黑名单 fail-open**：未知 sense（表中未登记）默认 `safe` 放行；破坏性 sense 必须显式标 `false` 兜底。`isSafeSenseCall` 是确定性纯函数（查表，无 LLM），保证中断/恢复前后判定一致。`ruleSet` 来自 `ctx.runtime.sensitivityRules`，由 [`ruleLoader`](../../../apps/backend/src/core/sense/ruleLoader.ts) 在 resolve 期从 `.chery/rule/` 深合并编译冻结（见下「smart 规则表」）。

**优先级链**（高 → 低，最终值在 builder 层 [`RuntimeResolver`](../../../apps/backend/src/agent/runtimeResolver.ts) 摊平时写入 `senseTable[name].supervisionLevel`）：

```text
1. sense_groups 中感官配置覆盖（如 "execute_command:auto"，最高优先级）
2. 感官内置 supervisionLevel 字段（sense() 第 5 参数）
3. global.supervision（最低优先级）
```

> 运行期 `senseMiddleware` 不再回退到 `global.supervision`——优先级链已在摊平时算完。`buildSenseTrigger`（agent/middleware/tool.ts）取 `senseTable.get(name)?.supervisionLevel ?? SupervisionLevel.smart` 兜底。

### smart 规则表（`.chery/rule/`）

smart 档的「危险/放行」判定规则**外置**到 `.chery/rule/` 目录的 yaml 文件（不再硬编码）——用户可编辑、不同预设可差异化。仅在 `configuredLevel === smart` 时生效；`auto`/`manual` 不经此表。

**黑名单 fail-open 语义**：默认放行（降 `auto` 自动执行），仅以下三种归 `unsafe`（保持 `smart` 推审批）：

1. 命中 `dangerPatterns`（子串或正则）；
2. 条目为 `false`（硬开关，破坏性 sense 无条件需确认）；
3. 有条目但 `extract` 取参异常（空串/抛错，fail-loud 保守）。

> ⚠ **fail-open 代价**：未知 sense（表中未登记且未内置 `auto`）默认放行、无监管。新增破坏性 sense **必须**在此显式标 `false`，否则自动执行。危险操作不可穷举，`dangerPatterns` 漏配即静默放行——高敏场景配 `manual` 档。

**文件组织**：

- `base.yaml`（基准，固定名）：默认合并基底，所有 smart 调用先以此打底。前端下拉**不可选**基准（`rules.list` 排除它）。
- `<name>.yaml`（覆盖文件）：预设经 `presets.<name>.rule` 引用一个，与基准**深合并**。

**AI 生成（cheryNyxus 豁免）**：前端预设 Tab 该字段显示名「审批规则」（原「规则文件」）。cheryNyxus（senseTable 含 `install_skill`，双重隔离信号）可对 `.chery/rule/` 读写——pathGuard 放行该目录的 `read_file`/`write_file`（`checkCheryGuard` 的 `allowRuleDir`），用于对话生成/修改审批规则文件；`.chery/` 其余路径仍拦。cheryNyxus 提示词（`.chery/prompt/cheryNyxus/cheryNyxus.md`）含规则编写规范，铁律：只允许**加严**（新增危险模式/改为需确认），禁止**放宽**（删除危险模式/改为放行）——防 AI 自授权绕过审批。

**config_manage 感官**：`config_manage` 是结构化感官（action=get/patch/rollback；旧 save 明确拒绝），参数不携带路径 → `extractSensePaths` 返回 `[]`，天然不触发 `.chery/` 路径守卫，可直接读写 `.chery/config.yaml`（配置管理核心角色 cheryNyxus 独占）。`patch` 与 `rollback` 必须携带 get 返回的 `baseRevision`；服务端基于磁盘快照构造候选，完整校验通过后交给统一协调器按操作、运行、资源、节点树或重启边界应用。仅 leader 组含此感官 → 其他角色调不到。详见 [agent/config-manage.md](../agent/config-manage.md)。

**配置读取放行（`filesystemRead` override）**：配置管理核心角色（senseTable 含 `config_manage`/`install_skill`，能力驱动）经 [tool.ts doExecuteSense](../../../apps/backend/src/agent/middleware/tool.ts) 接线，`authorizeToolCall` 传 `filesystemRead: 'any'`——read_file/search_codebase 的读取范围整体放行（绕过 filesystem workspace 校验，即使策略 deny）；该 override **不进 assessmentHash**（两处授权同源计算 → hash 恒等，不误触「策略已变化」拒绝）；`write_file`/`execute_command` 不受影响。结合 pathGuard 的 `allowConfigRead`（读 `.chery/` 全树放行），配置读取仅剩 envGuard 对 `.env` 敏感 key 值的后置遮蔽一道防线。

**角色验收安全覆盖层**：临时角色验收运行会把 `AcceptanceExecutionPolicy` 与普通角色策略求交。覆盖层强制工具白名单、临时工作区路径和最高命令沙箱等级，并拒绝高风险命令分类。覆盖层只允许收紧；普通角色策略中的 `deny`、系统路径守卫和执行时二次授权均继续生效。覆盖层参与 `assessmentHash`，初次判定和执行前复核必须传入同一份冻结策略。对覆盖层判定安全但普通监管仍为 `ask` 的调用，验收运行时可进程内预批准，不创建用户审批。

**深合并语义**（[`ruleLoader.loadMergedRuleSet`](../../../apps/backend/src/core/sense/ruleLoader.ts)，per sense）：

- 覆盖文件未提及的 sense → 用基准条目。
- 覆盖文件给某 sense `false` → 结果 `false`（硬开关：整体需确认）。
- 覆盖文件给某 sense 对象 + 基准也是对象（缺省 / `inherit: true`）→ `extract` 以覆盖为准、`dangerPatterns` 基准+覆盖**追加去重**。
- 覆盖文件给某 sense 对象 + `inherit: false` → **replace**：纯用覆盖，丢弃基准同名条目（`extract` + `dangerPatterns` 全取覆盖）。基准即「好用的默认」基底；某工具想完全自定义而非叠加时，用此字段整体替换。
- 覆盖文件给某 sense 对象 + 基准无/false → 纯用覆盖对象。`inherit` 仅对覆盖文件条目生效（基准无意义）。

**YAML 格式**：

```yaml
write_file: false # 硬开关：整体需确认（破坏性 sense 兜底）
execute_command:
  extract: command # 从 args.command 取待匹配串（支持点号路径如 input.path）
  dangerPatterns: # 命中 = 需确认；未命中 = 自动执行
    - 'rm -rf' # 子串匹配
    - '/^\w+\s+--version$/' # 正则：约定 /pattern/flags 形式
# 未登记的 sense（如 ask_user_question/update_todo）→ fail-open 默认放行
```

**数据流**：`resolvePresetSelection` 取 `preset.rule` → 快照 `metadata.rule`（镜像 workspace，子 agent 继承父）→ `resolve` 期 `loadMergedRuleSet(ruleName)` 深合并编译 → 冻结入 `RuntimeConfig.sensitivityRules` → `buildSenseTrigger` 从 `ctx.runtime.sensitivityRules` 读传 `isSafeSenseCall`。

**进程内冻结**：`ensureChat` 对已有 chat 不 re-configure → `sensitivityRules` 随 chat 生命周期冻结 → resume 续接复用同一 ruleSet，结论与首跑一致（即使磁盘文件中途被改；跨进程重启才 re-read）。故只快照 rule **名**入 metadata，不快照编译后 ruleSet（含 RegExp 不可序列化）。

**fail-open 降级**：基准/覆盖文件缺失或解析失败 → 回退空 ruleSet。空 ruleSet 在黑名单下 = **全部放行**（无任何 sense 登记 → 全归未知 → fail-open）；若需保守，靠破坏性 sense 内置 `manual`/`smart`+`false` 或 global 档位兜底，不阻塞启动。软依赖，不在 `validateRawConfig` 校验文件存在性。

**`session.runtime.set` 一致性**：切 brain 会重建 `RuntimeConfig`，4 处 `configureRuntime` 触点均透传 `getChatRule(chatId)`，避免 preset 自定义规则静默退化为基准。

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
        └─ smart/manual：createApproval(id) → await → resolveApproval 触发 → 执行 or 跳过
           → yield SenseAcceptChunk / SenseRejectChunk
              ├─ checkpoint → yield MessageCreatedChunk(sense 结果消息)
              └─ loop 进入下一轮：把 sense 结果作为新消息喂给 LLM
```

## 内置感官：web_search（外部只读观察）

接口、Provider 注册、配置和失败语义统一见 [网络搜索](../agent/web-search.md)。搜索内容作为不可信的 sense 结果回填，不提供稳定 hash，不自动写长期记忆。执行上下文的可选 `signal` 由工具中间件从当前 pipeline 透传；支持取消的工具须将其传给外部请求，不改变其他工具的执行契约。

与 Claude Code、Codex、dsh、OpenCode、Pi Agent 的能力差距矩阵由 [Agent Sense 能力对比](../agent/sense.md#sense-与其他-agent-工具的能力对比) 统一维护；本页只维护 Sense 公共契约，不复制对比表。

## 内置感官：history_recall（长会话历史回忆，只读）

长会话 compact 后，LLM 内存上下文只剩最新摘要——`history_recall`（[agent/sense/historyRecall.ts](../../../apps/backend/src/agent/sense/historyRecall.ts)）提供被压缩历史的只读回忆能力。代际切分数据源为 [`service/chat/generations.ts`](../service/chat.md) 的 `computeGenerations(rootChatId)`（推导计算，无新表）。轻量代际索引另注入 system prompt `<history_generations>` 段（见 [agent/prompt.md](../agent/prompt.md)），多数回忆免工具即止步。

**参数**（JSON，action 二选一）：

| 参数               | 类型                                                  | 说明                                                                         |
| ------------------ | ----------------------------------------------------- | ---------------------------------------------------------------------------- |
| `action`           | `'list_generations' \| 'search'`                      | 列代际目录 / 按关键词检索                                                    |
| `query`            | string（search 必填）                                 | 大小写不敏感子串匹配消息 content                                             |
| `scope`            | `'archived' \| 'current' \| 'all'`（默认 `archived`） | 已定稿代际、当前未压缩代或全部历史                                           |
| `generation`       | number（可选）                                        | 限定查询的代序号（`list_generations` 的 index；不能与 `scope=current` 同用） |
| `role`             | string（可选）                                        | 限定消息角色（user/assistant/role 等）                                       |
| `limit`            | number（可选，默认 10）                               | 命中条数上限                                                                 |
| `after` / `before` | epoch 毫秒（可选）                                    | createdAt 时间范围；分别为严格大于 / 小于等于                                |
| `max_output_chars` | number（可选）                                        | 本次输出上限，但不会超过 `global.history_recall.max_output_chars`            |

**行为**：

- `list_generations` → 每代一行：`第N代 [手动|自动] <时间> <节点数>节点 <摘要前200字>` + 当前代提示。
- `search` → 数据源为 **root chat + 全部后代 chat** 的持久化消息（`collectDescendantsChatIds`，按 `createdAt` 排序）；默认范围「全部已定稿代」（即最近一次 compact 边界之前的消息），也可用 `scope=current` 检索当前代，或 `scope=all` 检索两者；命中返回 `消息角色 + 前后各 ~150 字符上下文 + 所在代 index`。
- **硬字符上限**：结果总文本超过 `global.history_recall.max_output_chars`（默认 4000，见 [config 文档](../../../apps/backend/.chery.template/docs/config.md)）时截断，尾部注明「已截断，请缩小 query / 指定 generation」。
- 代归属按 `createdAt` 与各代边界时间窗（`(上一代边界时间, 本代边界时间]`）判定——root 与后代 chat 的消息共用时间坐标（orderKey 仅 root 图内有意义）。
- 错误显式返回（query 为空 / generation 不存在 / 未命中 → 友好中文说明，不抛崩）。

**监管**：只读感官，内置 `SupervisionLevel.auto`（同 read_file / search_codebase 惯例），smart 档位不经规则表直接放行；`.chery/rule/base.yaml` 无需登记条目（fail-open 未登记 = 放行，且内置 auto 根本不进表）。

**接入**：sense_groups 显式列出才可用（模板 `leader` 组已含）；`BUILTIN_SENSE_TOOLS` 已登记元信息。

## 依赖与关联

- **依赖**：
  - `zod`（sense 工厂的 schema 类型）。
  - [`SupervisionLevel`](README.md#supervisionlevel-枚举)（`core/config`）。
  - [compiler/utils.ts](compiler.md) `buildBaseSenseFunction`（被 provider 用于构造 SenseFunction，不在 sense 本模块）。
- **被依赖**：
  - [`agent/sense/{bash,read,write,skill}.ts`](../../../apps/backend/src/agent/sense) —— 用 `sense()` 定义内置感官。
  - [`agent/sense/index.ts`](../../../apps/backend/src/agent/sense/index.ts) —— `registerSenses` / `resetSenses`，`loadCustomSenses` 加载 compiler 产物。
  - [`agent/middleware/tool.ts`](../../../apps/backend/src/agent/middleware/tool.ts) —— `createApproval` 在 smart/manual 时建审批 Promise；用 `senseTable` 执行感官。
  - [`agent/middleware/chat.ts`](../../../apps/backend/src/agent/middleware/chat.ts) —— 用 `SenseFunction` / `SenseCallData` 类型。
  - [`agent/provider/{openai,ollama,mock}.ts`](../../../apps/backend/src/agent/provider) —— `registerSenseAdapter`、`buildBaseSenseFunction`。
  - [`agent/runtimeResolver.ts`](../../../apps/backend/src/agent/runtimeResolver.ts) —— `getSense` / `getSenseAdapter`，摊平 senseTable。
  - [`service/approval/manager.ts`](../../../apps/backend/src/service/approval/manager.ts) —— `resolveApproval` / `rejectApproval` 触发 await。
  - [`service/message/types.ts`](../../../apps/backend/src/service/message/types.ts)、[`service/chat/streamMapper.ts`](../../../apps/backend/src/service/chat/streamMapper.ts) —— 用 `SenseCallData` / `SenseFunction` 类型。
- **横切参考**：[middleware.md](middleware.md)（senseMiddleware 在洋葱链的位置、Chunk 流）、[db.md](../db/README.md)（pending sense = content 空、审批状态语义）、[interaction.md](../../shared/protocol/interactions.md)（审批 interrupt/accept/rejected notification）。

## 扩展点

### 加内置感官

```ts
// apps/backend/src/agent/sense/<name>.ts
import { z } from 'zod'
import { sense } from '@/core/sense'
import { SupervisionLevel } from '@/core/config'

export default sense(
  'my_sense',
  'My custom sense',
  z.object({ path: z.string() }),
  async (args, sharedData) => ({ content: `Result: ${args.path}`, hash: '...' }),
  SupervisionLevel.smart, // 可选，感官内置监管等级
)
```

然后在 [`agent/sense/index.ts`](../../../apps/backend/src/agent/sense/index.ts)：

1. `registerBuiltinSenses()` 数组加入；
2. `BUILTIN_SENSE_TOOLS` 追加元信息（`name` 与模块 `definition.function.name` 一致，前端感官下拉用；`doc` 填写【作用】【能力】【边界】【注意】完整说明，供 `sense.tools.docs` 统一返回、前端 hover 展示）。

**角色专用感官**（如 `install_skill` / `config_manage`）：只在对应角色的 senseGroup 列出，其他角色 senseTable 不含 → 不可调用（senseGroup 隔离，无需 per-role 白名单字段）。详见 [agent/skill-install.md](../agent/skill-install.md) 与 [agent/config-manage.md](../agent/config-manage.md)。

### 加外部感官

见 [compiler.md](compiler.md)：在 `.chery/senses/<name>.ts` 写源码（运行时由 `new Function` 注入 `z` / `sense` / `SupervisionLevel` / `registerSenses`），编译后由 `loadCustomSenses` 自动注册。
