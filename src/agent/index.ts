import { AgentBuilder } from "./builder";

/**
 * Agent 示例：使用 longcat 配置访问 package.json 数据
 *
 * 流程：
 * 1. 创建 AgentBuilder
 * 2. 选择 longcat 服务
 * 3. 构建 Agent（工具自动从 config.yaml 的 tool_group 配置加载）
 * 4. 发送消息，让 LLM 读取 package.json
 */

/**
 * 流式响应示例：使用 sendStream 获取实时输出
 */
async function streamExample() {

  const agent = await new AgentBuilder()
    .use("longcat")
    .build();

  const threadId = agent.createThread();
  const prompt = "给我讲一个笑话";

  console.log("=== 流式请求 ===");
  console.log(`Prompt: ${prompt}\n`);

  // 循环处理可能的多次 interrupt
  let currentPrompt = prompt;
  let hasPending = true;

  while (hasPending) {
    hasPending = false;
    let step = 0;

    // 遍历 AsyncGenerator 获取流式响应
    for await (const chunk of agent.invoke(threadId, currentPrompt)) {
      // pending 状态检测
      if (chunk.status === "pending" && chunk.pendingTool) {
        hasPending = true;
        console.log("\n=== Tool 需要确认 ===");
        console.log(`Tool: ${chunk.pendingTool.toolName}`);
        console.log(`Args: ${JSON.stringify(chunk.pendingTool.args, null, 2)}`);

        // 用户交互确认
        console.log("\n是否批准执行？(Y/N)");
        const input = await new Promise<string>((resolve) => {
          process.stdin.once("data", (data) => {
            resolve(data.toString().trim().toUpperCase());
          });
        });

        const approved = input === "Y" || input === "YES";
        console.log(`用户选择: ${approved ? "批准" : "拒绝"}\n`);

        // 调用 confirmToolCall
        const result = await agent.confirmToolCall(
          threadId,  // 使用已知的 threadId
          approved,
          chunk.pendingTool,
        );

        // 显示确认后的结果
        if (result.status === "success") {
          console.log("=== Tool 执行完成 ===");
          console.log(result.accumulated);
        } else if (result.status === "pending") {
          // 还有新的 interrupt，继续循环
          console.log("=== 还有新的 tool 需要确认 ===");
        }

        break; // 跳出当前 for 循环，进入下一次 while 循环
      }

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

    // 如果有 pending，下一轮不再发送新 prompt（confirmToolCall 会触发 retry）
    if (hasPending) {
      currentPrompt = ""; // 空字符串，retry 时不添加新 user 消息
    }
  }

  // 流结束
  console.log("\n\n=== 流式响应完成 ===");

  console.log("使用上面提示词自由发挥,给出最终笑话内容示例");
  // 3. 获取响应（非流式）
  let step = 0;
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
