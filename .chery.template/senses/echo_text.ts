/**
 * ====================================================================
 * 自定义 Sense 示例 — echo_text
 * ====================================================================
 *
 * 【什么是外部 Sense】
 * 外部 Sense 是放在 .chery/senses/ 下的 .ts 文件，编译后注入运行时。
 * 用于扩展 Agent 能力：文件操作、数据库查询、调用外部 API 等。
 *
 * 【文件规范】
 *  - 无需手动 import zod / sense / SupervisionLevel，编译器自动注入
 *  - 文件默认导出（export default）一个 sense(...) 调用
 *  - 文件名即 Sense 标识（去掉 .ts），在 sense_groups 配置中引用
 *
 * 【sense() 参数】
 *  sense(name, description, schema, handler, supervision?)
 *   - name:         Sense 名称（字符串，与文件名一致）
 *   - description:  给 LLM 看的说明（LLM 据此决定是否调用）
 *   - schema:       zod schema，定义 input 参数结构
 *   - handler:      async (input) => SenseResult，实际执行逻辑
 *   - supervision:  可选，监管等级（auto / confirm / manual）
 *                   优先级：感官配置 > 感官内置声明 > global.supervision
 *
 * 【自测注解 @test】
 *  使用 /* @test [...] *​/ 块定义测试用例，pnpm compile:senses 时自动执行。
 *  每个用例：{ input: <符合 schema>, output: <期望 SenseResult> }
 *  自测失败的 Sense 不会被注册（fail-loud）。
 *
 * 【使用流程】
 *  1. 在 .chery/senses/ 下创建 .ts 文件，参考本文件结构
 *  2. 运行 pnpm compile:senses 编译（开发期可用 --watch）
 *  3. 在 config.yaml 的 sense_groups 中引用该 Sense 名称
 *  4. 启动 Agent，LLM 即可根据 description 决定是否调用
 *
 * ====================================================================
 */

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
  SupervisionLevel.confirm,
);