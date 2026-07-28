# Sense（感官定义、监管、注册与审批）

> 源码 [src/core/sense/](../../src/core/sense/) ｜ 上级 [core/README.md](./README.md) ｜ 相关 [middleware.md](./middleware.md)、[compiler.md](./compiler.md)、[db.md](../db.md)

## 职责

`core/sense/` 定义「感官」（= 工具 / function calling）的全部抽象：怎么声明一个感官（`sense()` 工厂）、感官注册表（`senseRegistry`）、provider 如何把感官转成自家格式并提取调用（`SenseAdapter`）、以及 smart/manual 监管下的审批 Promise 管理（`approvalRegistry`）。

感官是 Agent 与外部世界交互的唯一通道：LLM 产出 `senseCalls` → `senseMiddleware` 按监管等级执行 → 结果回灌为新的 `sense` 角色消息，进入下一轮 LLM 调用。内置感官（bash/read/write/skill）在 [`agent/sense/`](../../src/agent/sense/) 实现，外部感官在 `.chery/senses/*.ts` 由 [compiler.md](./compiler.md) 编译。

## 文件清单

| 文件 | 职责 |
|------|------|
| [senseCreator.ts](../../src/core/sense/senseCreator.ts) | `sense()` 工厂、`Sense` / `SenseFunction` / `SenseExecutor` / `SenseResult` / `SenseSharedData` 类型 |
| [adapter.ts](../../src/core/sense/adapter.ts) | `SenseCallData`、`SenseAdapter` 接口、`senseAdapterRegistry` + 注册三件套 |
| [senseRegistry.ts](../../src/core/sense/senseRegistry.ts) | 全局感官实例注册表（name → `Sense`），`registerSenses` / `resetSenses` / `getSense` |
| [approvalRegistry.ts](../../src/core/sense/approvalRegistry.ts) | core 层审批 Promise 注册表（`createApproval` / `resolveApproval` / `rejectApproval`），smart/manual 感官 await 用户审批 |
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

createApproval(id: string): Promise<ApprovalDecision>     // senseMiddleware 在 smart/manual 时调
resolveApproval(id: string, action, reason?): void        // service ApprovalManager.confirm 调 → resolve
rejectApproval(id: string, error: Error): void           // service ApprovalManager.abort 调 → reject
```

`id` 用 LLM 返回的 `tool_call.id`（与 `SenseTriggerChunk.id` 一致）。

## Sense 监管等级

> 行为定义在 [`SupervisionLevel`](./README.md#supervisionlevel-枚举) 枚举（[`core/config.ts`](../../src/core/config.ts)）；最终值由 [`RuntimeResolver`](../../src/agent/runtimeResolver.ts) 按下面的优先级链摊平时写入 `senseTable[name].supervisionLevel`。

| 等级 | 值 | 行为 |
|------|----|------|
| `auto` | 0 | 自动执行，推送 accept notification |
| `smart` | 1 | 按规则表判定：危险操作（黑名单命中 / `false` 硬开关 / 取参异常）需确认；其余（含未知 sense）自动执行（fail-open 默认放行） |
| `manual` | 2 | 推送 interrupt notification，禁止自动执行，仅手动触发 |

> **smart 档判定**：[`buildSenseTrigger`](../../src/agent/middleware/tool.ts) 对 smart 档调 [`src/core/sense/sensitivity.ts`](../../src/core/sense/sensitivity.ts) 的 `isSafeSenseCall(ruleSet, name, args)` 计算有效执行等级——`safe`（未命中 `dangerPatterns` 且非 `false`）→ 降为 `auto` 直接执行；`unsafe`（命中危险 / `false` 硬开关 / 取参异常）→ 保持 `smart` 推 interrupt 建审批。**黑名单 fail-open**：未知 sense（表中未登记）默认 `safe` 放行；破坏性 sense 必须显式标 `false` 兜底。`isSafeSenseCall` 是确定性纯函数（查表，无 LLM），保证中断/恢复前后判定一致。`ruleSet` 来自 `ctx.runtime.sensitivityRules`，由 [`ruleLoader`](../../src/core/sense/ruleLoader.ts) 在 resolve 期从 `.chery/rule/` 深合并编译冻结（见下「smart 规则表」）。

**优先级链**（高 → 低，最终值在 builder 层 [`RuntimeResolver`](../../src/agent/runtimeResolver.ts) 摊平时写入 `senseTable[name].supervisionLevel`）：

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

**深合并语义**（[`ruleLoader.loadMergedRuleSet`](../../src/core/sense/ruleLoader.ts)，per sense）：
- 覆盖文件未提及的 sense → 用基准条目。
- 覆盖文件给某 sense `false` → 结果 `false`（硬开关：整体需确认）。
- 覆盖文件给某 sense 对象 + 基准也是对象（缺省 / `inherit: true`）→ `extract` 以覆盖为准、`dangerPatterns` 基准+覆盖**追加去重**。
- 覆盖文件给某 sense 对象 + `inherit: false` → **replace**：纯用覆盖，丢弃基准同名条目（`extract` + `dangerPatterns` 全取覆盖）。基准即「好用的默认」基底；某工具想完全自定义而非叠加时，用此字段整体替换。
- 覆盖文件给某 sense 对象 + 基准无/false → 纯用覆盖对象。`inherit` 仅对覆盖文件条目生效（基准无意义）。

**YAML 格式**：

```yaml
generate_image: false              # 硬开关：整体需确认（破坏性 sense 兜底）
execute_command:
  extract: command                 # 从 args.command 取待匹配串（支持点号路径如 input.path）
  dangerPatterns:                  # 命中 = 需确认；未命中 = 自动执行
    - 'rm -rf'                     # 子串匹配
    - '/^\w+\s+--version$/'        # 正则：约定 /pattern/flags 形式
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

## 依赖与关联

- **依赖**：
  - `zod`（sense 工厂的 schema 类型）。
  - [`SupervisionLevel`](./README.md#supervisionlevel-枚举)（`core/config`）。
  - [compiler/utils.ts](./compiler.md) `buildBaseSenseFunction`（被 provider 用于构造 SenseFunction，不在 sense 本模块）。
- **被依赖**：
  - [`agent/sense/{bash,read,write,skill}.ts`](../../src/agent/sense/) —— 用 `sense()` 定义内置感官。
  - [`agent/sense/index.ts`](../../src/agent/sense/index.ts) —— `registerSenses` / `resetSenses`，`loadCustomSenses` 加载 compiler 产物。
  - [`agent/middleware/tool.ts`](../../src/agent/middleware/tool.ts) —— `createApproval` 在 smart/manual 时建审批 Promise；用 `senseTable` 执行感官。
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
  SupervisionLevel.smart,    // 可选，感官内置监管等级
);
```

然后在 [`agent/sense/index.ts`](../../src/agent/sense/index.ts)：

1. `registerBuiltinSenses()` 数组加入；
2. `BUILTIN_SENSE_TOOLS` 追加元信息（`name` 与模块 `definition.function.name` 一致，前端感官下拉用）。

**管家专用感官**（如 `install_skill`）：只在管家角色的 senseGroup 列出，其他角色 senseTable 不含 → 不可调用（senseGroup 隔离，无需 per-role 白名单字段）。详见 [agent/skill-install.md](../agent/skill-install.md)。

### 加外部感官

见 [compiler.md](./compiler.md)：在 `.chery/senses/<name>.ts` 写源码（运行时由 `new Function` 注入 `z` / `sense` / `SupervisionLevel` / `registerSenses`），编译后由 `loadCustomSenses` 自动注册。
