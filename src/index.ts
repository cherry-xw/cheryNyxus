import { startService } from "./service/index.js";
import { closeDb } from "./db/index.js";
import { compileSenses, parseTestCases } from "./core/sense/compiler/index.js";
import { runSenseTestsAndCollect, reportSenseCompileResult } from "./agent/sense/compileToolsReporter.js";

const WS_PORT = parseInt(process.env.WS_PORT || "8080", 10);

async function main(): Promise<void> {
  const subcommand = process.argv[2];

  if (subcommand === "compile-senses") {
    await compileSensesCommand();
    return;
  }

  // 启动 WebSocket 服务
  const wss = startService(WS_PORT);

  // 优雅关闭
  process.on("SIGINT", () => {
    console.log("\n正在关闭服务...");
    wss.close();
    closeDb();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    wss.close();
    closeDb();
    process.exit(0);
  });
}

async function compileSensesCommand(): Promise<void> {
  const summary = await compileSenses();

  if (summary.succeeded.length === 0 && summary.failed.length === 0) {
    console.log("未找到外部感官源文件");
    return;
  }

  const testResults = await runSenseTestsAndCollect(summary.succeeded);
  reportSenseCompileResult(summary, testResults);

  const hasFailure = summary.failed.length > 0 ||
    [...testResults.values()].some(r => !r.detail.passed && r.detail.error);

  if (hasFailure) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("启动失败:", err.message);
  process.exit(1);
});