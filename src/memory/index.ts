/**
 * 项目记忆模块统一导出（双层 · 平铺布局）。
 *
 *   .chery/memory/                                ← global 层（所有 chat 共享）
 *   .chery/workspace/<hash>/memory/               ← workspace 层（workspace chat 用）
 *   每层：main.md + 平铺 *.md + history/
 */

export type {
  MemoryType,
  MemoryMetadata,
  MemoryFrontmatter,
  HistoryFrontmatter,
  MemoryIndexEntry,
  HistoryIndexEntry,
  Memory,
  HistoryEntry,
} from "./types.js";

export type { MemoryScope } from "./path.js";

export {
  getMemoryRootDir,
  getHistoryDir,
  getMemoryIndexPath,
  getHistoryIndexPath,
  hashWorkspacePath,
} from "./path.js";

export {
  readMemoryIndex,
  writeMemoryIndex,
  readMemory,
  writeMemory,
  deleteMemoryFile,
  listMemoryNames,
  readHistoryIndex,
  writeHistoryIndex,
  readHistoryEntry,
  writeHistoryEntry,
  listHistoryNames,
  readMemoryIndexContent,
} from "./store.js";

export { addMemory, removeMemory, updateMemory, listMemories, listHistories } from "./manager.js";
