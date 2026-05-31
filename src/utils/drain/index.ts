// 导出核心类
export { TemplateMiner } from "./templateMiner";
export { TemplateMinerConfig } from "./templateMinerConfig";
export { InMemoryPersistenceHandler } from "./inMemoryPersistence";
export { Drain } from "./drain";
export { DrainBase } from "./drainBase";
export { NullProfiler } from "./drainBase";
export { PersistenceHandler } from "./persistenceHandler";

// 导出类型定义
export type {
  DrainResult,
  LogClusterInterface,
  TemplateMinerResult,
  NodeInterface,
  ChangeType,
  DrainState,
  SerializedCluster,
  SerializedNode,
} from "./types";

export type { Profiler } from "./drainBase";
export type { TemplateMinerOptions } from "./templateMinerConfig";

// 导入内部依赖（用于compressLog函数）
import { TemplateMiner } from "./templateMiner";
import { TemplateMinerConfig } from "./templateMinerConfig";
import { InMemoryPersistenceHandler } from "./inMemoryPersistence";
import type { DrainResult } from "./types";

/**
 * 压缩日志内容（简化接口）
 *
 * @param content 日志内容
 * @param previewCount 每个模板显示的实例数（默认3）
 * @returns 压缩结果
 */
export async function compressLog(
  content: string,
  previewCount: number = 3,
): Promise<DrainResult> {
  const config = new TemplateMinerConfig({
    drainSimTh: 0.5,
    drainDepth: 4,
    parametrizeNumericTokens: true,
  });

  const persistence = new InMemoryPersistenceHandler();
  const miner = new TemplateMiner(config, persistence);
  await miner.initialize();

  const lines = content.split("\n").filter((line) => line.trim());
  const templateMap = new Map<string, string[]>();

  // 处理每行日志，提取模板
  for (const line of lines) {
    const result = await miner.addLogMessage(line);
    const template = result.logCluster.template.join(" ");

    if (!templateMap.has(template)) {
      templateMap.set(template, []);
    }
    templateMap.get(template)!.push(line);
  }

  // 生成压缩内容
  const compressedLines: string[] = [];
  let originalSize = 0;
  let compressedSize = 0;

  compressedLines.push(
    `=== 日志模板摘要 (共${templateMap.size}个模板) ===\n`,
  );

  for (const [template, instances] of templateMap) {
    const count = instances.length;
    const displayCount = Math.min(previewCount, count);

    compressedLines.push(`\n[模板: ${template}] (${count}次)`);
    compressedLines.push(`  显示前${displayCount}个实例:`);

    for (let i = 0; i < displayCount; i++) {
      compressedLines.push(`  ${i + 1}. ${instances[i]}`);
    }

    if (count > displayCount) {
      compressedLines.push(`  ... 省略${count - displayCount}个相似日志`);
    }

    originalSize += instances.join("\n").length;
  }

  compressedLines.push(`\n---\n`);
  compressedLines.push(`[压缩统计]`);
  compressedLines.push(`- 原始行数: ${lines.length}`);
  compressedLines.push(`- 模板数量: ${templateMap.size}`);

  compressedSize = compressedLines.join("\n").length;
  const ratio = ((1 - compressedSize / originalSize) * 100).toFixed(1);
  compressedLines.push(`- 压缩率: ${ratio}%`);
  compressedLines.push(`- 压缩策略: Drain模板化去重`);

  await miner.close();

  return {
    compressedContent: compressedLines.join("\n"),
    templateCount: templateMap.size,
    lineCount: lines.length,
    compressionRatio: `${ratio}%`,
  };
}