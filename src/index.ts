import { startService } from "./service/index.js";
import { getSoulDb, closeAllDbs } from "./db/index.js";
import { compileSenses } from "./core/sense/compiler/index.js";
import { runSenseTestsAndCollect, reportSenseCompileResult } from "./agent/sense/compileToolsReporter.js";
import { bootstrapAgentRuntime } from "./agent/bootstrap.js";
import { reloadSenses } from "./agent/sense/index.js";
import { startWebServer } from "./web/server.js";
import { initLogger, logger } from "@/utils/logger/index.js";
import config from "@/utils/config.js";

// 初始化 Logger
initLogger(config.global.logger);

const WS_PORT = parseInt(process.env.WS_PORT || "8080", 10);
const WEB_PORT = parseInt(process.env.WEB_PORT || "8081", 10);

async function main(): Promise<void> {
  const subcommand = process.argv[2];

  if (subcommand === "compile-senses") {
    await compileSensesCommand();
    return;
  }

  await bootstrapAgentRuntime();

  // 启动 WebSocket 服务
  const wss = startService(WS_PORT);

  // 启动 Web 测试页面
  startWebServer(WEB_PORT);

  // 启动时初始化数据库
  getSoulDb();

  // 优雅关闭
  process.on("SIGINT", () => {
    logger.info("\n正在关闭服务...");
    wss.close();
    closeAllDbs();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    wss.close();
    closeAllDbs();
    process.exit(0);
  });
}

async function compileSensesCommand(): Promise<void> {
  const summary = await compileSenses();

  if (summary.succeeded.length === 0 && summary.failed.length === 0) {
    logger.info("未找到外部感官源文件");
    await reloadSenses();
    return;
  }

  const testResults = await runSenseTestsAndCollect(summary.succeeded);
  reportSenseCompileResult(summary, testResults);
  await reloadSenses();

  const hasFailure = summary.failed.length > 0 ||
    [...testResults.values()].some(r => !r.detail.passed && r.detail.error);

  if (hasFailure) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  logger.error("启动失败:", err.message);
  process.exit(1);
});
