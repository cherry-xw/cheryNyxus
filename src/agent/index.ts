import { AgentBuilder } from "./builder";
import { readTool } from "@/tool/index";
import { v4 as uuid } from "uuid";

/**
 * Agent 示例：使用 longcat 配置访问 package.json 数据
 *
 * 流程：
 * 1. 创建 AgentBuilder
 * 2. 选择 longcat 服务
 * 3. 绑定 read_file 工具
 * 4. 构建 Agent
 * 5. 发送消息，让 LLM 读取 package.json
 */

async function main() {
  const threadId = uuid();

  // 1. 创建 builder 并配置
  const agent = new AgentBuilder()
    .use("longcat")         // 使用 longcat 配置
    .bindTools(readTool)    // 绑定 read_file 工具
    .build();

  // 2. 发送消息：让 LLM 读取 package.json
  const prompt = "请使用 read_file 工具读取 package.json 文件，告诉我项目的名称和版本号";

  console.log("=== 发送请求 ===");
  console.log(`Prompt: ${prompt}\n`);

  // 3. 获取响应（非流式）
  const responseArr = await agent.send(threadId, prompt);

  for (const response of responseArr) {
    if (response.thinking) {
      console.log("\n=== Thinking ===");
      console.log(response.thinking);
    }
    console.log("=== LLM 响应 ===");
    console.log(`Role: ${response.role}`);
    console.log(`Content: ${response.content}`);
  }
  console.log("运行结束");

}

/**
 * 流式响应示例：使用 sendStream 获取实时输出
 */
async function streamExample() {
  const threadId = uuid();

  const agent = new AgentBuilder()
    .use("longcat")
    .bindTools(readTool)
    .build();

  const prompt = "请使用 read_file 工具读取 package.json 文件，告诉我项目的名称和版本号";

  console.log("=== 流式请求 ===");
  console.log(`Prompt: ${prompt}\n`);
  let step = 0
  // 遍历 AsyncGenerator 获取流式响应
  for await (const chunk of agent.sendStream(threadId, prompt)) {
    // 思考内容增量输出
    if (chunk.thinkingDelta) {
      if (step === 0) {
        console.log("\n=== Thinking ===");
        step = 1
      }
      process.stdout.write(chunk.thinkingDelta);
    }
    // 内容增量输出
    if (chunk.delta) {
      if (step === 1) {
        console.log("\n\n=== LLM 响应 ===");
        step = 0
      }
      process.stdout.write(chunk.delta);
    }
    // 流结束
    if (chunk.isDone) {
      console.log("\n\n=== 流式响应完成 ===");
      console.log(`累积内容长度: ${chunk.accumulated.length}`);
    }
  }
  console.log("运行结束");
}

// 运行示例
// main().catch(console.error);
streamExample().catch(console.error);