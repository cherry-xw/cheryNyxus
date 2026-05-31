/**
 * 示例自定义 Tool（简化格式）
 *
 * 外部 tool 文件无需手动导入 zod、tool 函数、SupervisionLevel。
 * 编译系统会自动注入以下导入语句：
 * - import { z } from "zod";
 * - import { tool, type ToolResult } from "@/core/tool";
 * - import { SupervisionLevel } from "@/core/config";
 */

const EchoSchema = z.object({
  text: z.string().describe("要回显的文本"),
});

export default tool(
  "echo_text",
  "回显输入文本，用于测试自定义 tool 功能",
  EchoSchema,
  async (input) => {
    return {
      content: `Echo: ${input.text}`,
      hash: "",
    };
  },
  SupervisionLevel.confirm,
);