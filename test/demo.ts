/**
 * Terminal Demo - Agent 模块完整功能测试
 * 使用 ali_glm5 配置，stdin 审批
 */
import { AgentBuilder } from "@/agent/builder";
import type { MiddlewareChunk, MiddlewareContext } from "@/core/middleware/types";
import { createSession, getSession } from "@/db/session.js";
import { createThread, getThread } from "@/db/thread.js";
import { interruptManager } from "@/service/agent/interrupt.js";
import { SupervisionLevel } from "@/core/config.js";
import config from "@/utils/config.js";
import readline from "readline";

async function main() {
  console.log("=== Terminal Demo ===");
  console.log("使用 ali_glm5 配置\n");

  const sessionId = "demo-session";
  const threadId = "demo-thread";
  const aiConfig = config.llm.brain.ali_glm5!;

  // 创建 session 和 thread 数据库记录（interrupt 外键依赖）
  if (!getSession(sessionId)) {
    createSession(sessionId, {
      agentName: "demo",
      provider: aiConfig.provider,
      model: aiConfig.model,
      toolGroup: aiConfig.tool_group,
    });
  }
  if (!getThread(threadId)) {
    createThread(threadId, sessionId);
  }

  // 构建 Agent
  const agent = await new AgentBuilder()
    .use("ali_glm5")
    .setSessionId(sessionId)
    .build();

  // 创建线程
  agent.createThread(threadId);
  console.log(`线程已创建: ${threadId}\n`);

  // stdin 审批监听
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // 固定输入
  const input = "帮我分析一下/home/chc/self/cheryClaw文件夹是什么项目";

  console.log(`用户输入: ${input}\n`);
  console.log("--- 响应开始 ---\n");

  // 获取 context 用于 interrupt middleware
  const ctx = agent.getContext(threadId)!;

  // 流式执行（包装 interrupt 处理）
  const generator = wrapWithInterrupt(ctx, agent.send(threadId, input));

  for await (const chunk of generator) {
    if (chunk.type === "tool_trigger" && chunk.supervisionLevel > SupervisionLevel.auto) {
      // 需审批：打印信息，等待 stdin
      console.log(`\n[需审批] ${chunk.name}`);
      console.log(`参数: ${chunk.arguments}`);
      chunk.approval = await askApproval(rl);
    }
    handleChunk(chunk);
  }

  rl.close();
  console.log("\n=== Demo 完成 ===");
}

/**
 * 包装 interrupt 处理（创建 interrupt 记录）
 */
async function* wrapWithInterrupt(
  ctx: MiddlewareContext,
  generator: AsyncGenerator<MiddlewareChunk>,
): AsyncGenerator<MiddlewareChunk> {
  for await (const chunk of generator) {
    if (chunk.type === "tool_trigger" && chunk.supervisionLevel > SupervisionLevel.auto) {
      await interruptManager.createSingleInterrupt(ctx, chunk);
    }
    yield chunk;
  }
}

/**
 * stdin 审批
 */
async function askApproval(
  rl: readline.Interface,
): Promise<{ action: "accept" | "reject"; reason?: string }> {
  return new Promise((resolve) => {
    rl.question("批准执行? (y/n): ", (input) => {
      if (input.toLowerCase() === "y" || input.toLowerCase() === "yes") {
        resolve({ action: "accept" });
      } else {
        rl.question("拒绝原因 (可选): ", (reason) => {
          resolve({
            action: "reject",
            reason: reason.trim() || undefined,
          });
        });
      }
    });
  });
}

// 追踪是否已打印标题（每轮重置）
let hasThinkingTitle = false;
let hasContentTitle = false;

function handleChunk(chunk: MiddlewareChunk) {
  switch (chunk.type) {
    case "stream":
      if (chunk.thinkingDelta) {
        if (!hasThinkingTitle) {
          console.log("\n[思考]");
          hasThinkingTitle = true;
        }
        process.stdout.write(chunk.thinkingDelta);
      }
      if (chunk.contentDelta) {
        if (!hasContentTitle) {
          console.log("\n[内容]");
          hasContentTitle = true;
        }
        process.stdout.write(chunk.contentDelta);
      }
      break;
    case "tool_trigger":
      console.log(`\n[工具触发] ${chunk.name} (${chunk.supervisionLevel})`);
      break;
    case "tool_complete":
      console.log(`\n[工具完成] ${chunk.name}`);
      const resultPreview =
        chunk.result.length > 100
          ? chunk.result.slice(0, 100) + "..."
          : chunk.result;
      console.log(`  结果: ${resultPreview}`);
      break;
    case "staged":
      console.log("\n--- 阶段完成 ---");
      // 重置标题状态，下轮可重新打印
      hasThinkingTitle = false;
      hasContentTitle = false;
      break;
    case "consumed":
      console.log(`\n[已消费] ${chunk.count} 条输入`);
      break;
    case "error":
      console.log("\n[错误]");
      chunk.errors.forEach((e) => {
        console.log(`  - ${e.category}: ${e.message}`);
      });
      break;
    case "done":
      console.log("\n--- 响应结束 ---");
      break;
  }
}

main().catch((err) => {
  console.error("执行失败:", err);
  process.exit(1);
});