import { describe, it, expect } from "@jest/globals";
import { graph } from "../src/agent/graph.js";

describe("config.configurable 数据来源演示", () => {
  it("方式1: 代码调用时传递 configurable 参数", async () => {
    const input = { messages: ["Hello"] };

    // ✅ 通过 config.configurable 传递自定义参数
    const config = {
      configurable: {
        LANGSMITH_API_KEY: "test-key-from-invoke", // 自定义值
        userId: "user-123",
        temperature: 0.7,
        customParam: "runtime-value"
      }
    };

    // graph.invoke 的第二个参数就是 RunnableConfig
    const result = await graph.invoke(input, config);

    expect(result).toBeDefined();
    expect(result.messages).toBeDefined();
    console.log("✅ config.configurable 来自代码调用:", JSON.stringify(config.configurable));
  }, 30000);

  it("方式2: 无 configurable 参数时为 undefined", async () => {
    const input = { messages: ["Test"] };

    // ❌ 不传 config 参数，config.configurable 为空
    const result = await graph.invoke(input);

    expect(result).toBeDefined();
    console.log("❌ 未传递 config 时，config.configurable 为 undefined");
  }, 30000);
});