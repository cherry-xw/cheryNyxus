/**
 * vitest setupFiles —— 必须在所有测试文件 import 之前执行。
 *
 * 职责（仅环境隔离，不 import 任何 config 链，避免提前触发 loadConfig）：
 * 1. 设置 CHERY_DIR 指向 test/flows/fixtures（独立 config + mock 脚本 + DB）
 * 2. 设置 CHERY_TRANSPORT=binary（验证真实二进制帧）
 * 3. 清理上一次运行的 DB 目录（保证隔离）
 */
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { rmSync, existsSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "fixtures");

// 环境变量必须在 import config 之前设置
process.env.CHERY_DIR = fixturesDir;
process.env.CHERY_TRANSPORT = "binary";

// 清理上次运行的 DB（soul.db + YYYY-MM.db），保证每次隔离
const dbDir = resolve(fixturesDir, ".chery", "db");
if (existsSync(dbDir)) {
  rmSync(dbDir, { recursive: true, force: true });
}
