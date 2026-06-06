const NoTestSchema = z.object({
  value: z.string().describe("输入值"),
});

export default sense(
  "no_test_sense",
  "无测试用例的感官",
  NoTestSchema,
  async (input) => {
    return {
      content: `Result: ${input.value}`,
      hash: "",
    };
  },
  SupervisionLevel.auto,
);