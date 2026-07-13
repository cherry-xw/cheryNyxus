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
import { clearAllApprovals } from "@/core/sense/approvalRegistry.js";
import { clearAllWaitedChildren } from "@/agent/spawnBroker.js";
import { closeAllConnections } from "@/service/websocket/index.js";
import { initLogger, logger, LogLevel } from "@/utils/logger/index.js";
import config from "@/utils/config.js";

// 初始化 Logger
initLogger(config.global.logger);

// 记录配置基准（日志文件新建时）
import { readRawConfig } from "@/utils/config.js";
logger.recordConfigBaseline(readRawConfig());

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
    host: config.server.host,
    auth: config.server.auth,
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

  /**
   * 优雅关闭函数：先关闭连接 → 等待清理 → 退出
   * 最长等待 5 秒，超时后强制退出
   */
  async function gracefulShutdown(signal: string): Promise<void> {
    logger.info(`\n收到 ${signal}，正在关闭服务...`);

    const SHUTDOWN_TIMEOUT_MS = 5000;

    // 1. 先关闭所有 WebSocket 连接（wss.close() 只停止接受新连接）
    closeAllConnections(wss);

    // 2. 等待 server 关闭完成（Promise 包装）
    const closeWss = new Promise<void>((resolve) => wss.close(() => resolve()));
    const closeHttp = new Promise<void>((resolve) => httpServer.close(() => resolve()));

    // 3. 清理所有定时器
    clearAllApprovals();
    clearAllWaitedChildren();

    // 4. 等待所有清理完成（带超时）
    const cleanupPromise = Promise.all([
      closeWss,
      closeHttp,
      closeMcpClients(),
    ]);

    try {
      await Promise.race([
        cleanupPromise,
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error("关闭超时")), SHUTDOWN_TIMEOUT_MS)
        ),
      ]);
      logger.info("所有资源已清理完成");
    } catch (err) {
      logger.warn(`关闭超时（${SHUTDOWN_TIMEOUT_MS}ms），强制退出`);
    }

    // 5. 关闭数据库
    closeAllDbs();

    process.exit(0);
  }

  // 优雅关闭
  process.on("SIGINT", async () => {
    await gracefulShutdown("SIGINT");
  });

  process.on("SIGTERM", async () => {
    await gracefulShutdown("SIGTERM");
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
