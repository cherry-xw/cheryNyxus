/**
 * vitest setupFiles —— 必须在所有测试文件 import 之前执行。
 *
 * 职责（仅环境隔离，不 import 任何 config 链，避免提前触发 loadConfig）：
 * 1. 将 test/flows/fixtures 复制到每个测试文件独立的临时目录并设置 CHERY_DIR
 * 2. 设置 CHERY_TRANSPORT=binary（验证真实二进制帧）
 * 3. 清理上一次运行的 DB 目录（保证隔离）
 */
import { cpSync, mkdtempSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "fixtures");
const runDir = process.env.CHERY_TEST_RUN_DIR;

if (!runDir) {
  throw new Error("CHERY_TEST_RUN_DIR is missing; run tests through the root Vitest config");
}

const testDir = mkdtempSync(join(runDir, "case-"));

cpSync(fixturesDir, testDir, { recursive: true });

// 环境变量必须在 import config 之前设置
process.env.CHERY_DIR = testDir;
process.env.CHERY_TRANSPORT = "binary";
