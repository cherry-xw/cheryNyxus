import { AgentBuilder } from "./builder";
import { readTool, loadSkillTool } from "@/tool/index";

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

/**
 * 流式响应示例：使用 sendStream 获取实时输出
 */
async function streamExample() {

  const agent = new AgentBuilder()
    .use("longcat")
    .bindTools([readTool, loadSkillTool])
    .build();

  const threadId = agent.createThread();
  const prompt = "给我讲个笑话";

  console.log("=== 流式请求 ===");
  console.log(`Prompt: ${prompt}\n`);
  let step = 0;
  // 遍历 AsyncGenerator 获取流式响应
  for await (const chunk of agent.invoke(threadId, prompt)) {
    // 思考内容增量输出
    if (chunk.thinkingDelta) {
      if (step === 0) {
        console.log("\n=== Thinking ===");
        step = 1;
      }
      process.stdout.write(chunk.thinkingDelta);
    }
    // 内容增量输出
    if (chunk.delta) {
      if (step === 1) {
        console.log("\n\n=== LLM 响应 ===");
        step = 0;
      }
      process.stdout.write(chunk.delta);
    }
  }
  step = 0;
  // 流结束
  console.log("\n\n=== 流式响应完成 ===");

  console.log("使用上面提示词自由发挥,给出最终笑话内容示例");
  // 3. 获取响应（非流式）
  const responseArr1 = agent.invoke(
    threadId,
    "使用上面提示词自由发挥,给出最终笑话内容示例",
  );

  for await (const chunk of responseArr1) {
    // 思考内容增量输出
    if (chunk.thinkingDelta) {
      if (step === 0) {
        console.log("\n=== Thinking ===");
        step = 1;
      }
      process.stdout.write(chunk.thinkingDelta);
    }
    // 内容增量输出
    if (chunk.delta) {
      if (step === 1) {
        console.log("\n\n=== LLM 响应 ===");
        step = 0;
      }
      process.stdout.write(chunk.delta);
    }
  }
  console.log("运行结束");
}

// 运行示例
// main().catch(console.error);
streamExample().catch(console.error);
