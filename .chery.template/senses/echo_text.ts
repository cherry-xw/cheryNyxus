/**
 * 示例自定义 Sense（简化格式）
 *
 * 外部 sense 文件无需手动导入 zod、sense 函数、SupervisionLevel。
 * 编译系统会自动注入以下导入语句：
 * - import { z } from "../index.js";
 * - import { sense } from "../index.js";
 * - import { SupervisionLevel } from "../index.js";
 *
 * 可选：使用 /* @test [...] *​/ 注解定义自测用例。
 * 编译后自动执行，input 传入 schema 参数，output 与 SenseResult 逐字段比对。
 * 自测失败的感官不会被注册。
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