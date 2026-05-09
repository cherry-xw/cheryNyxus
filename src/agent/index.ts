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
 * 流式响应示例：使用 send 获取实时输出
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
    for await (const chunk of agent.send(threadId, currentPrompt)) {
      // interrupt 状态检测
      if (chunk.type === "interrupt") {
        hasPending = true;
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

        // 使用 chunk 的 continue/abort
        if (approved) {
          await chunk.continue("用户批准执行");
        } else {
          chunk.abort();
        }

        break; // 跳出当前 for 循环，进入下一次 while 循环
      }

      // stream chunk 处理
      if (chunk.type === "stream") {
        // 思考内容增量输出
        if (chunk.thinkingDelta) {
          if (step === 0) {
            console.log("\n=== Thinking ===");
            step = 1;
          }
          process.stdout.write(chunk.thinkingDelta);
        }
        // 内容增量输出
        if (chunk.contentDelta) {
          if (step === 1) {
            console.log("\n\n=== LLM 响应 ===");
            step = 0;
          }
          process.stdout.write(chunk.contentDelta);
        }
      }

      // staged/done 处理
      if (chunk.type === "staged" || chunk.type === "done") {
        if (chunk.type === "staged") {
          console.log("\n=== 响应完成 ===");
          if (chunk.thinking) {
            console.log(`Thinking: ${chunk.thinking}`);
          }
          console.log(`Content: ${chunk.content}`);
        }
      }
    }

    // 如果有 pending，下一轮不再发送新 prompt（continue 会触发 retry）
    if (hasPending) {
      currentPrompt = ""; // 空字符串，retry 时不添加新 user 消息
    }
  }

  // 流结束
  console.log("\n\n=== 流式响应完成 ===");

  console.log("使用上面提示词自由发挥,给出最终笑话内容示例");
  // 获取新响应
  let step2 = 0;
  for await (const chunk of agent.send(
    threadId,
    "使用上面提示词自由发挥,给出最终笑话内容示例",
  )) {
    // stream chunk 处理
    if (chunk.type === "stream") {
      if (chunk.thinkingDelta) {
        if (step2 === 0) {
          console.log("\n=== Thinking ===");
          step2 = 1;
        }
        process.stdout.write(chunk.thinkingDelta);
      }
      if (chunk.contentDelta) {
        if (step2 === 1) {
          console.log("\n\n=== LLM 响应 ===");
          step2 = 0;
        }
        process.stdout.write(chunk.contentDelta);
      }
    }
  }
  console.log("\n运行结束");
}

// 运行示例
// main().catch(console.error);
streamExample().catch(console.error);
