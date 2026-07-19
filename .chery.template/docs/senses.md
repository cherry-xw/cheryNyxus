# senses — 自定义感官（外部）

> 模板目录：`.chery.template/senses/` ｜ 运行位置：`.chery/senses/`
> 编译命令：`pnpm compile:senses`（开发期 `--watch`）
> 编译入口：[src/core/sense/compiler/](../../src/core/sense/compiler/) ｜ 详细文档：[../../docs/core/sense.md](../../docs/core/sense.md)、[../../docs/core/compiler.md](../../docs/core/compiler.md)

## 用途

`.chery/senses/` 下的 `.ts` 文件，编译后注入运行时。用于扩展 Agent 能力：文件操作、数据库查询、调用外部 API、自定义业务工具等。

**文件名即 Sense 标识**（去掉 `.ts` 后缀），在 `config.yaml` 的 `sense_groups` 中按名引用。

## 文件规范

1. **无需 import**：`zod` / `sense` / `SupervisionLevel` 由编译器自动注入
2. **默认导出**（`export default`）一个 `sense(...)` 调用
3. **文件名 = Sense 名**（去掉 `.ts`），与 `sense()` 第一个参数一致
4. **可声明监管等级**：作为 `sense()` 第 5 个参数；优先级低于 `config.yaml sense_groups` 的 `:level` 后缀

## sense() 函数签名

```ts
sense(
  name: string,                            // Sense 名称（与文件名一致）
  description: string,                     // 给 LLM 看的说明（LLM 据此决定是否调用）
  schema: z.ZodType,                       // zod schema，定义 input 参数结构
  handler: async (input) => SenseResult,   // 实际执行逻辑
  supervision?: SupervisionLevel,         // 可选：监管等级（auto / confirm / manual）
): SenseDefinition
```

### SenseResult 类型

```ts
interface SenseResult {
  content: string;            // 返回给 LLM 的内容（必填）
  hash?: string;              // 缓存哈希（相同 input 复用结果；缺省视为空，不缓存）
}
```

## schema 编写

用 zod 描述 input，`.describe()` 给 LLM 看：

```ts
const EchoSchema = z.object({
  text: z.string().describe("要回显的文本"),
});
```

## 自测注解 `@test`

使用 `/* @test [...] */` 块定义测试用例，`pnpm compile:senses` 时自动执行：

```ts
/* @test [
  { "input": { "text": "hello" }, "output": { "content": "Echo: hello", "hash": "" } },
  { "input": { "text": "" }, "output": { "content": "Echo: ", "hash": "" } }
] */
```

- 每个用例：`{ input: <符合 schema>, output: <期望 SenseResult> }`
- 自测失败的 Sense **不被注册**（fail-loud）

## 使用流程

1. 在 `.chery/senses/` 下创建 `.ts` 文件，参考模板 [../senses/echo_text.ts](../senses/echo_text.ts)
2. 运行 `pnpm compile:senses` 编译（开发期可用 `--watch`）
3. 在 `config.yaml` 的 `sense_groups` 中引用该 Sense 名称
4. 启动 Agent，LLM 即可根据 `description` 决定是否调用

## 模板示例（echo_text.ts）

```ts
/* @test [
  { "input": { "text": "hello" }, "output": { "content": "Echo: hello", "hash": "" } },
  { "input": { "text": "" }, "output": { "content": "Echo: ", "hash": "" } }
] */

const EchoSchema = z.object({
  text: z.string().describe("要回显的文本"),
});

export default sense(
  "echo_text",
  "回显输入文本，用于测试自定义 sense 功能",
  EchoSchema,
  async (input) => {
    return {
      content: `Echo: ${input.text}`,
      hash: "",
    };
  },
  SupervisionLevel.confirm,    // 监管等级：config.yaml 可覆盖
);
```

## 关联配置

`.chery/config.yaml`：

```yaml
sense_groups:
  my_group:
    - echo_text:manual        # 显式指定 manual 监管
    - other_sense             # 用 echo_text 感官内置或 global.supervision
```

## 字段参考表

| 文件元素 | 类型 | 必填 | 说明 |
|----------|------|------|------|
| `sense.name` | string | ✅ | 与文件名一致（去 `.ts`） |
| `sense.description` | string | ✅ | 给 LLM 看的功能说明 |
| `sense.schema` | z.ZodType | ✅ | input 参数 schema；用 `.describe()` 标注字段语义 |
| `sense.handler` | async fn | ✅ | `(input) => { content, hash? }` |
| `sense.supervision` | enum | ❌ | `auto` / `confirm` / `manual`；缺省走 `global.supervision` |
| `@test` 注解 | array | ❌ | 自测用例；失败则 Sense 不注册 |

## 注意事项

- **路径守卫**：外部 sense 写 `.chery/` 受 pathGuard 保护；如需写 `.chery/`，需 `GUARD_EXEMPT` 豁免
- **缓存语义**：`hash` 缺省视为空（不缓存）；返回相同 `hash` 字符串视为命中缓存
- **描述质量**：`description` 直接影响 LLM 调用决策，必须清晰说明功能、参数语义、典型场景
- **错误处理**：handler 内抛错 → senseMiddleware 捕获，标记为 `error` 状态喂回 LLM，不阻断 loop

## 关联

- Sense 框架文档：[../../docs/core/sense.md](../../docs/core/sense.md)
- 外部编译器：[../../docs/core/compiler.md](../../docs/core/compiler.md)
- 模板示例：[../senses/echo_text.ts](../senses/echo_text.ts)