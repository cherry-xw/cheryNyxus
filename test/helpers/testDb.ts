import { dirname, join } from "path";
import { createTempDir, cleanupTempDir } from "./tempDir.js";

/**
 * 临时 db 目录 helper —— 供 db 层测试隔离。
 *
 * src/db/index.ts 的 dbCache 是模块级单例，且 config.global.db_dir 在 setup.ts 中
 * 固定指向 test/flows/fixtures。若 db 测试直接用真实 db，跨测试文件（vitest forks 并行）
 * 会共享同一物理文件、数据互相污染。
 *
 * 方案：每个 db 测试文件 vi.mock("@/utils/config.js")，将 global.db_dir 重定向到每测试
 * 独立的 tempDir；本 helper 只负责目录创建与清理。closeAllDbs 由测试文件直接从
 * @/db/index 导入调用，重置单例缓存。
 */

/** 创建独立临时 db 目录（getSoulDb 会 join(dir, "soul.db")）。 */
export function createTempDbDir(): string {
  return join(createTempDir(), "db");
}

/** 清理临时 db 目录（含父级 tempDir）。 */
export function cleanupTempDbDir(dbDir: string): void {
  cleanupTempDir(dirname(dbDir));
}
