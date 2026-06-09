/**
 * Terminal Demo - Agent 模块完整功能测试
 * 使用 ali_glm5 配置，stdin 审批
 */
import { AgentBuilder } from "@/agent/builder";
import type { MiddlewareChunk, MiddlewareContext } from "@/core/middleware/types";
import { createSoul, getSoul } from "@/db/soul.js";
import { createChat, getChat, addMessage } from "@/db/chat.js";
import { approvalManager } from "@/service/approval/manager.js";
import { SupervisionLevel } from "@/core/config.js";
import config from "@/utils/config.js";
import readline from "readline";
import { initLogger, logger } from "@/utils/logger/index.js";

// 初始化 Logger（使用全局配置，使 output: [file] 生效）
initLogger(config.global.logger);

async function main() {
  logger.info("=== Terminal Demo ===");
  logger.info("使用 ali_glm5 配置，输入 exit 或空行退出\n");

  const soulId = "demo-soul";
  const chatId = "demo-chat";
  const aiConfig = config.llm.brain.ali_glm5!;

  // 创建 soul 和 chat 数据库记录（approval 外键依赖）
  if (!getSoul(soulId)) {
    createSoul(soulId, {
      agentName: "demo",
      provider: aiConfig.provider,
      model: aiConfig.model,
      senseGroup: aiConfig.sense_group,
    });
  }
  if (!getChat(chatId)) {
    createChat(chatId, soulId);
  }

  // 构建 Agent
  const agent = await new AgentBuilder()
    .use("ali_glm5")
    .setSoulId(soulId)
    .build();

  // 创建聊天
  agent.createChat(chatId);
  logger.info(`聊天已创建: ${chatId}\n`);

  // stdin 审批监听（提示输出到 stderr，终端可见）
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr, // 提示输出到 stderr，不被重定向
  });

  // 获取 context 用于 approval middleware
  const ctx = agent.getContext(chatId)!;

  // 注入消息持久化回调（与 WebSocket 模式一致）
  ctx.persistMessage = (msg) => {
    addMessage(msg.id, chatId, {
      role: msg.role,
      content: msg.content,
      thinking: msg.thinking,
      senseCall: msg.senseCalls,
    });
  };

  // 多轮对话循环
  while (true) {
    const input = await new Promise<string>((resolve) => {
      rl.question("用户输入: ", resolve);
    });

    // 退出条件：空行或 exit
    if (!input.trim() || input.trim().toLowerCase() === "exit") {
      break;
    }

    logger.info("\n--- 响应开始 ---\n");

    // 重置标题状态
    hasThinkingTitle = false;
    hasContentTitle = false;

    // 流式执行（包装 approval 处理）
    const generator = wrapWithApproval(ctx, agent.send(chatId, input));

    for await (const chunk of generator) {
      if (chunk.type === "sense_end" && chunk.supervisionLevel > SupervisionLevel.auto) {
        // 需审批：打印信息，等待 stdin
        logger.info(`\n[需审批] ${chunk.name}`);
        logger.info(`参数: ${chunk.arguments}`);
        const decision = await askApproval(rl);
        // 通过 approvalResolve 回调通知 generator
        if (chunk.approvalResolve) {
          chunk.approvalResolve(decision.action, decision.reason);
        }
      }
      if (chunk.type === "sense_accept" || chunk.type === "sense_reject") {
        handleChunk(chunk);
      } else {
        handleChunk(chunk);
      }
    }

    logger.info("\n--- 响应结束 ---\n");
  }

  rl.close();
  logger.info("\n=== Demo 完成 ===");
  logger.close();
}

/**
 * 包装 approval 处理（创建 approval 记录）
 */
async function* wrapWithApproval(
  ctx: MiddlewareContext,
  generator: AsyncGenerator<MiddlewareChunk>,
): AsyncGenerator<MiddlewareChunk> {
  for await (const chunk of generator) {
    if (chunk.type === "sense_end" && chunk.supervisionLevel > SupervisionLevel.auto) {
      await approvalManager.createSingleApproval(ctx, chunk);
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
          logger.info("\n[思考]");
          hasThinkingTitle = true;
        }
        logger.write(chunk.thinkingDelta);
      }
      if (chunk.contentDelta) {
        if (!hasContentTitle) {
          logger.info("\n[内容]");
          hasContentTitle = true;
        }
        logger.write(chunk.contentDelta);
      }
      break;
    case "sense_end":
      logger.info(`\n[工具触发] ${chunk.name} (${chunk.supervisionLevel})`);
      break;
    case "sense_accept":
      logger.info(`\n[工具完成] ${chunk.name}`);
      logger.info(`  结果: ${chunk.result}`);
      break;
    case "sense_reject":
      logger.info(`\n[已拒绝] ${chunk.name}`);
      if (chunk.reason) {
        logger.info(`  原因: ${chunk.reason}`);
      }
      break;
    case "staged":
      logger.info("\n--- 阶段完成 ---");
      // 重置标题状态，下轮可重新打印
      hasThinkingTitle = false;
      hasContentTitle = false;
      break;
    case "consumed":
      logger.info(`\n[已消费] ${chunk.count} 条输入`);
      break;
    case "error":
      logger.info("\n[错误]");
      chunk.errors.forEach((e) => {
        logger.info(`  - ${e.category}: ${e.message}`);
      });
      break;
    case "done":
      logger.info("\n--- 响应结束 ---");
      break;
  }
}

main().catch((err) => {
  logger.error("执行失败:", err);
  process.exit(1);
});