/**
 * 记忆存储路径计算（双层 · 平铺布局）。
 *
 * scope=global（与 workspace 无关）
 *   → .chery/memory/                          主目录（含 active 平铺 *.md + history/ 子目录）
 *
 * scope=workspace + workspace
 *   → .chery/workspace/<sha256(path)[:12]>/memory/
 *
 * scope=workspace + 无 workspace
 *   → throw Error（业务层拒绝非 workspace chat 调用 scope="workspace"）
 *
 * 每层目录结构：
 *   <root>/
 *   ├── main.md                ← 活跃索引
 *   ├── <name>.md              ← 活跃条目（与 main.md 同级；平铺，无子目录）
 *   └── history/
 *       ├── main.md            ← 历史索引
 *       └── <name>.md          ← 历史条目（平铺）
 */

import { createHash } from "crypto";
import path from "path";
import config from "@/utils/config";

/** 记忆层标识 */
export type MemoryScope = "global" | "workspace";

/** SHA256(workspace 路径) 取前 12 位十六进制 */
export function hashWorkspacePath(workspacePath: string): string {
  return createHash("sha256").update(workspacePath).digest("hex").slice(0, 12);
}

/** 获取 cheryDir（CHERY_DIR 环境变量或 cwd） */
function getCheryDir(): string {
  return process.env.CHERY_DIR || process.cwd();
}

/**
 * 获取记忆主目录。
 *   scope="global" → .chery/memory/
 *   scope="workspace" + workspace → .chery/workspace/<hash>/memory/
 *   scope="workspace" + 无 workspace → throw
 */
export function getMemoryRootDir(workspace?: string, scope: MemoryScope = "workspace"): string {
  if (scope === "global") {
    return config.global.memory_dir;
  }
  // scope === "workspace"
  if (!workspace) {
    throw new Error("scope=\"workspace\" 但 chat 未配置 PresetConfig.workspace；请改用 scope=\"global\"");
  }
  const hash = hashWorkspacePath(workspace);
  return path.join(getCheryDir(), ".chery", "workspace", hash, "memory");
}

/** 历史归档子目录：<root>/history/ */
export function getHistoryDir(workspace?: string, scope: MemoryScope = "workspace"): string {
  return path.join(getMemoryRootDir(workspace, scope), "history");
}

/** 活跃索引文件：<root>/main.md */
export function getMemoryIndexPath(workspace?: string, scope: MemoryScope = "workspace"): string {
  return path.join(getMemoryRootDir(workspace, scope), "main.md");
}

/** 历史索引文件：<root>/history/main.md */
export function getHistoryIndexPath(workspace?: string, scope: MemoryScope = "workspace"): string {
  return path.join(getHistoryDir(workspace, scope), "main.md");
}
