import { AgentBuilder } from "./builder";

/**
 * Agent 示例：使用 deepseek 配置访问 package.json 数据
 */

async function streamExample() {

  const agent = await new AgentBuilder()
    .use("deepseek")
    .build();

  const threadId = agent.createThread();
  const prompt = "看一下这是什么项目";

  console.log("=== 流式请求 ===");
  console.log(`Prompt: ${prompt}\n`);

  // 遍历 AsyncGenerator 获取流式响应
  // generator 内部已包含 loop，interrupt 时会暂停等待 acknowledge
  for await (const chunk of agent.send(threadId, prompt)) {
    // interrupt 状态检测
    if (chunk.type === "interrupt") {
      console.log("\n=== Tool 需要确认 ===");
      console.log(`Tool: ${chunk.toolName}`);
      console.log(`Args: ${JSON.stringify(chunk.args, null, 2)}`);

      // 用户交互确认
      console.log("\n是否批准执行？(Y/N)");
      const input = await new Promise<string>((resolve) => {
        process.stdin.once("data", (data) => {
          resolve(data.toString().trim().toUpperCase());
        });
      });

      const approved = input === "Y" || input === "YES";
      console.log(`用户选择: ${approved ? "批准" : "拒绝"}\n`);

      // 使用 chunk 的 acknowledge（执行工具调用后 generator 继续）
      await chunk.acknowledge(approved ? "accept" : "reject");
      // acknowledge 后 for await 继续迭代，generator 继续执行
      continue;
    }

    // stream chunk 处理
    if (chunk.type === "stream") {
      if (chunk.thinkingDelta) {
        process.stdout.write(chunk.thinkingDelta);
      }
      if (chunk.contentDelta) {
        process.stdout.write(chunk.contentDelta);
      }
    }

    // staged/done 处理
    if (chunk.type === "staged") {
      console.log("\n=== 响应完成 ===");
      if (chunk.thinking) {
        console.log(`Thinking: ${chunk.thinking}`);
      }
      console.log(`Content: ${chunk.content}`);
    }

    if (chunk.type === "done") {
      console.log("\n=== 流式响应完成 ===");
    }
  }

  console.log("\n运行结束");
}

streamExample().catch(console.error);
