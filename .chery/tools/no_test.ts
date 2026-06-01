const NoTestSchema = z.object({
  value: z.string().describe("输入值"),
});

export default tool(
  "no_test_tool",
  "无测试用例的工具",
  NoTestSchema,
  async (input) => {
    return {
      content: `Result: ${input.value}`,
      hash: "",
    };
  },
  SupervisionLevel.auto,
);