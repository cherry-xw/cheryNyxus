# .chery/senses/ — 自定义感官

> 此目录下的 `.ts` 文件由后端启动时**自动加载**（无需手动 import），详见 [docs/core/compiler.md](../../docs/core/compiler.md)。
> 详细 API 文档：[docs/core/sense.md](../../docs/core/sense.md)（sense 工厂 / 监管 / 审批）。

## 是什么

**Sense（感官）** 是 LLM 可以调用的工具（类 OpenAI function calling）。
LLM 在推理过程中产出 `senseCalls` → 后端按监管等级执行 → 结果回灌为新的对话消息，进入下一轮 LLM 调用。

- **内置感官**（bash/read/write/skill）在源码 [`src/agent/sense/`](../../src/agent/sense/) 实现，随后端发布。
- **外部感官**（你在这里写的）在 `.chery/senses/*.ts` 由编译器运行时编译，无需重启后端（修改保存后下次启动生效）。

## 快速开始

最小可运行模板见同目录 [`echo_text.ts`](./echo_text.ts)：

```ts
const MySchema = z.object({
  text: z.string().describe("要回显的文本"),
});

export default sense(
  "echo_text",
  "回显输入文本，用于测试自定义 sense 功能",
  MySchema,
  async (input) => {
    return { content: `Echo: ${input.text}`, hash: "" };
  },
  SupervisionLevel.confirm,   // 可选：监管等级
);
```

**注意**：`z`、`sense`、`SupervisionLevel` 三个符号由编译器**自动注入**，不要手动 `import`。
否则会与注入的标识符冲突导致编译失败。

## `sense()` 工厂签名

```ts
export function sense<T extends z.ZodType>(
  name: string,                                     // 1. 感官名（全局唯一，LLM 调用的标识）
  description: string,                              // 2. 描述（给 LLM 看，越具体越好）
  schema: T,                                         // 3. zod schema（自动转 JSON Schema 给 LLM）
  handler: (input: z.infer<T>, sharedData, ctx) => Promise<SenseResult>,
  supervisionLevel?: SupervisionLevel,              // 5. 可选：监管等级（不写则走 global）
): Sense<T>;
```

### 返回值 `SenseResult`

```ts
{ content: string; hash: string }
```

| 字段 | 用途 |
|------|------|
| `content` | 感官返回的内容文本，回灌给 LLM |
| `hash` | **内容稳定可折叠型 sense 才填**（如 read_file 的 hash 含文件 mtime），用于历史去重。**派发标识型 sense（spawn_role、execute_command）必须留空字符串**，否则会被错误折叠。详见 [docs/core/sense.md#hash-语义约束](../../docs/core/sense.md#hash-语义约束) |

### 第三个参数 `sharedData`

```ts
type SenseSharedData = Map<string, Map<string, unknown>>;
// 外层 namespace → 内层 identifier → data
```

在同一 chat 的不同感官间共享数据（如 `bash` 的 cwd、`read_file` 的最近文件）。
按 chatId 归属的感官从 `ctx.chatId` 取，按 namespace 隔离。

### 第四个参数 `ctx`

```ts
interface SenseRuntimeContext { chatId: string }
```

由后端自动注入。

## 监管等级 `SupervisionLevel`

| 等级 | 值 | 行为 | 何时用 |
|------|----|------|--------|
| `auto` | 0 | 自动执行，推送 accept notification | 只读 / 幂等操作 |
| `confirm` | 1 | 推送 interrupt notification，等待用户审批 | 写入 / 副作用操作 |
| `manual` | 2 | 推送 interrupt notification，**禁止自动执行**，仅手动触发 | 危险操作（rm、kill 等） |

**优先级链**（高 → 低，最终值在 builder 摊平时确定）：

```text
1. .chery/config.yaml 中 sense_groups 配置覆盖（如 "my_sense:auto"）
2. sense() 工厂第 5 参数（感官内置声明）
3. .chery/config.yaml 中 global.supervision
```

例：在 `config.yaml` 强制覆盖某感官为 `auto`：

```yaml
sense_groups:
  readonly:
    - "echo_text:auto"        # 强制 auto，覆盖感官内置的 confirm
    - "read_file"
```

## `@test` 自测注解

可选。在文件顶部用 `/* @test [...] */` 声明自测用例，编译器会自动执行：

```ts
/* @test [
  { "input": { "text": "hello" }, "output": { "content": "Echo: hello", "hash": "" } },
  { "input": { "text": "" }, "output": { "content": "Echo: ", "hash": "" } }
] */
```

- `input` 传入 schema 参数
- `output` 与 `SenseResult` 逐字段比对
- **自测失败的感官不会被注册**——保证破损 sense 不会污染运行时

## 调试与诊断

### 编译测试

```bash
pnpm compile:senses
```

会编译所有外部 sense 文件并跑自测，打印每个 sense 的注册结果。**自测失败会显示具体哪个 case 错位**。

### 运行时验证

启动后端后看启动日志，类似：

```
[setup] loaded 5 env var(s) from C:\...\win-unpacked\.env
[setup] runtime root: C:\...\win-unpacked
[setup] .chery path: C:\...\win-unpacked\.chery
[setup] .env path: C:\...\win-unpacked\.env
[backend] custom senses registered: echo_text
```

或者在设置面板「打开配置目录」按钮 → 进入 `.chery/senses/` 实时修改，**保存后重启后端生效**。

## 常见陷阱

| 现象 | 原因 | 修法 |
|------|------|------|
| 编译报错 `z is not defined` | 手动 `import { z } from "zod"` 与注入的冲突 | **删掉 import**——`z` 自动注入 |
| LLM 看不到我的 sense | 文件名和 `name` 不一致 / 编译失败 | 看 `pnpm compile:senses` 输出 |
| LLM 调到 sense 但内容被"折叠" | `hash` 填了非空字符串但语义不符 | 只读型（read_file 等）填 `hash`，派发型留 `""` |
| 用户每次都被问要不要执行 | `SupervisionLevel.confirm` | 改成 `.auto` 或在 `sense_groups` 强制覆盖 |
| 修改 .ts 不生效 | 后端没重启 | 重启后端，外部 sense 仅启动时加载 |

## 完整示例集合

仓库开发用的 `pnpm compile:senses` 测试集（在仓库 `.chery/senses/`，**不会**随应用分发）展示：

- 编译错误场景（语法错）
- 自测失败场景（断言不匹配）
- 无 `@test` 注解场景
- 成功场景

如想本地验证你的 sense 模板，先 `pnpm compile:senses` 跑通后再打包。

## 关联文档

- [docs/core/sense.md](../../docs/core/sense.md) — 完整 API：`sense()` / `SupervisionLevel` / `approvalRegistry`
- [docs/core/compiler.md](../../docs/core/compiler.md) — 编译器工作原理（`new Function` 注入上下文）
- [docs/agent/sense.md](../../docs/agent/sense.md) — 内置感官实现参考
- [docs/agent/middleware.md](../../docs/agent/middleware.md) — senseMiddleware 洋葱链位置