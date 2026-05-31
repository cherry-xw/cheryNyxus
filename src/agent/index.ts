import { AgentBuilder } from "./builder";
import * as readline from "readline";

// 导出 tool 相关内容，供外部 tool 编译后使用
export { z, tool, SupervisionLevel, registerTool, registerTools } from "./tool/index.js";
export type { Tool, ToolResult } from "./tool/index.js";

/**
 * Agent 示例：使用 deepseek 配置访问 package.json 数据
 */

// 创建 readline 接口（复用）
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

async function promptUser(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim().toUpperCase());
    });
  });
}

async function streamExample() {

  const agent = await new AgentBuilder()
    .use("ali_glm5")
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
      console.log(`共 ${chunk.handles.length} 个工具调用待审批：\n`);

      // 显示所有 handles
      for (let i = 0; i < chunk.handles.length; i++) {
        const handle = chunk.handles[i];
        if (handle) {
          console.log(`[${i + 1}] ${handle.reason}`);
        }
      }

      // 独立审批每个 handle，批量调用 acknowledge（不 await）
      for (let i = 0; i < chunk.handles.length; i++) {
        const handle = chunk.handles[i];
        if (!handle) continue;

        const input = await promptUser(`\n[${i + 1}] 是否批准执行？(Y/N)`);

        const approved = input === "Y" || input === "YES";
        console.log(`用户选择: ${approved ? "批准" : "拒绝"}\n`);

        // 调用 acknowledge（不 await，同步填充 execList，异步 promise 在 generator 内部 await）
        handle.acknowledge(approved ? "accept" : "reject");
      }

      // generator 继续执行
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
  rl.close();
}

streamExample().catch(console.error);
