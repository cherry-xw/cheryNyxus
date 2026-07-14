/**
 * 项目记忆模块统一导出。
 *
 * 存储结构：
 *   .chery/workspace/<hash>/MEMORY.md    ← 活跃索引
 *   .chery/workspace/<hash>/memories/    ← 活跃记忆详情
 *   .chery/workspace/<hash>/history/     ← 淘汰归档
 *   非 workspace → .chery/memory/（同上结构）
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

export {
  getMemoryRootDir,
  getMemoriesDir,
  getHistoryDir,
  getHistoryMemoriesDir,
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
