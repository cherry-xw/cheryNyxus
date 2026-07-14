/**
 * 记忆存储路径计算。
 *
 * workspace 模式 → .chery/workspace/<sha256(path)[:12]>/
 * 非 workspace   → .chery/memory/（config.global.memory_dir）
 */

import { createHash } from "crypto";
import path from "path";
import config from "@/utils/config";

/** SHA256(workspace 路径) 取前 12 位十六进制 */
export function hashWorkspacePath(workspacePath: string): string {
  return createHash("sha256").update(workspacePath).digest("hex").slice(0, 12);
}

/** 获取 cheryDir（CHERY_DIR 环境变量或 cwd） */
function getCheryDir(): string {
  return process.env.CHERY_DIR || process.cwd();
}

/**
 * 获取记忆存储根目录。
 * workspace 给出 → .chery/workspace/<hash>/；否则 → config.global.memory_dir
 */
export function getMemoryRootDir(workspace?: string): string {
  if (workspace) {
    const hash = hashWorkspacePath(workspace);
    return path.join(getCheryDir(), ".chery", "workspace", hash);
  }
  return config.global.memory_dir;
}

export function getMemoriesDir(workspace?: string): string {
  return path.join(getMemoryRootDir(workspace), "memories");
}

export function getHistoryDir(workspace?: string): string {
  return path.join(getMemoryRootDir(workspace), "history");
}

export function getHistoryMemoriesDir(workspace?: string): string {
  return path.join(getHistoryDir(workspace), "memories");
}

export function getMemoryIndexPath(workspace?: string): string {
  return path.join(getMemoryRootDir(workspace), "MEMORY.md");
}

export function getHistoryIndexPath(workspace?: string): string {
  return path.join(getHistoryDir(workspace), "MEMORY.md");
}
