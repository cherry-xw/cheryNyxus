import { createAgent } from "./builder";
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
  const agent = createAgent()
    .use("longcat")         // 使用 longcat 配置
    .bindTools(readTool)    // 绑定 read_file 工具
    .build();

  // 2. 发送消息：让 LLM 读取 package.json
  const prompt = "请使用 read_file 工具读取 package.json 文件，告诉我项目的名称和版本号";

  console.log("=== 发送请求 ===");
  console.log(`Prompt: ${prompt}\n`);

  // 3. 获取响应（非流式）
  const response = await agent.send(threadId, prompt);

  if (response.thinking) {
    console.log("\n=== Thinking ===");
    console.log(response.thinking);
  }
  console.log("=== LLM 响应 ===");
  console.log(`Role: ${response.role}`);
  console.log(`Content: ${response.content}`);

}

main().catch(console.error);