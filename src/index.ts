import path from "node:path";
import { fileURLToPath } from "node:url";
import { startService } from "./service/index.js";
import { getSoulDb, closeAllDbs } from "./db/index.js";
import { reconcileMessageCounts } from "./db/chat.js";
import { compileSenses } from "./core/sense/compiler/index.js";
import { runSenseTestsAndCollect, reportSenseCompileResult } from "./agent/sense/compileToolsReporter.js";
import { bootstrapAgentRuntime } from "./agent/bootstrap.js";
import { closeMcpClients } from "@/core/mcp/index.js";
import { reloadSenses } from "./agent/sense/index.js";
import { initLogger, logger, LogLevel } from "@/utils/logger/index.js";
import config from "@/utils/config.js";

// 初始化 Logger
initLogger(config.global.logger);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WS_PORT = config.server.port;
const WEB_PORT = Number(process.env.WEB_PORT ?? 8183); // HTTP 静态服务端口（原 config.server.web_port 已废弃，改 env，与 electron/main.ts 一致）
// 前端静态产物目录：优先 WEB_DIST_DIR env（打包后指定），默认相对后端 dist/ 的 ../web/dist
const STATIC_DIR = process.env.WEB_DIST_DIR ?? path.resolve(__dirname, "..", "web", "dist");

async function main(): Promise<void> {
  const subcommand = process.argv[2];

  if (subcommand === "compile-senses") {
    await compileSensesCommand();
    return;
  }

  if (subcommand === "reconcile-db") {
    const result = reconcileMessageCounts();
    logger.info(
      `reconcile-db: checked ${result.checked} chats, fixed ${result.fixed} drift(s)`,
    );
    closeAllDbs();
    return;
  }

  await bootstrapAgentRuntime();

  // 启动 WebSocket + HTTP 服务
  const { wss, httpServer } = startService({
    port: WS_PORT,
    webPort: WEB_PORT,
    staticDir: STATIC_DIR,
  });

  // 启动时初始化数据库
  getSoulDb();
  // 对账冗余 message_count：修 addMessage 跨库写崩溃导致的漂移（O(chats)，每 chat 1 次 COUNT）
  const reconcileResult = reconcileMessageCounts();
  if (reconcileResult.fixed > 0) {
    logger.event(
      "db.reconcile",
      { checked: reconcileResult.checked, fixed: reconcileResult.fixed },
      LogLevel.warn,
    );
  }

  // 优雅关闭
  process.on("SIGINT", async () => {
    logger.info("\n正在关闭服务...");
    wss.close();
    httpServer.close();
    await closeMcpClients();
    closeAllDbs();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    wss.close();
    httpServer.close();
    await closeMcpClients();
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
