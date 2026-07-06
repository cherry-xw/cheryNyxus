import { z } from "zod";
import { FileFinder } from "@ff-labs/fff-node";
import { sense, type SenseResult, type SenseSharedData } from "@/core/sense";
import { SupervisionLevel } from "@/core/config";
import { logger } from "@/utils/logger/index.js";

/**
 * fff FileFinder 单例（模块级懒加载）。
 *
 * 首次调用触发 FileFinder.create + waitForScan；后续调用复用同一实例。
 * fff 内置实时文件 watcher，扫描后自动跟进变更，无需手动 rescan。
 * 单例 Promise 缓存：初始化失败也缓存 null，避免每次调用重试（成本高）；需重试重启进程。
 */
let finderPromise: Promise<FileFinder | null> | null = null;

function getFinder(): Promise<FileFinder | null> {
  if (finderPromise) return finderPromise;
  finderPromise = (async () => {
    if (!FileFinder.isAvailable()) {
      logger.warn("⚠ fff 原生库不可用，search_codebase 感官无法工作");
      return null;
    }
    const created = FileFinder.create({ basePath: process.cwd(), aiMode: true });
    if (!created.ok) {
      logger.warn(`⚠ fff FileFinder.create 失败: ${created.error}`);
      return null;
    }
    const scan = await created.value.waitForScan(10_000);
    if (!scan.ok || !scan.value) {
      logger.warn("⚠ fff 初始扫描超时(10s)，搜索结果可能不完整");
    }
    return created.value;
  })();
  return finderPromise;
}

const SearchSchema = z.object({
  mode: z.enum(["content", "filename"])
    .describe("搜索模式：content=按文件内容grep搜索文本（默认）；filename=按文件名模糊搜索")
    .optional()
    .default("content"),
  query: z.string().describe(
    "搜索查询。content模式支持约束语法 '*.ts TODO'(仅搜TS文件)、'src/ TODO'(仅搜src目录)；" +
    "filename模式支持模糊匹配与 'file.ts:42' 行定位",
  ),
  regex: z.boolean()
    .describe("content模式：是否正则匹配，默认false纯文本")
    .optional(),
  maxResults: z.number().int().min(1).max(200)
    .describe("返回结果上限，默认50")
    .optional(),
  contextLines: z.number().int().min(0).max(10)
    .describe("content模式：匹配行前后各显示的上下文行数，默认0")
    .optional(),
});

/**
 * 内容搜索（grep）。返回格式化的匹配列表，每条含路径:行号:内容，可选上下文。
 */
function searchContent(
  finder: FileFinder,
  query: string,
  opts: { regex: boolean; maxResults: number; contextLines: number },
): SenseResult {
  const result = finder.grep(query, {
    mode: opts.regex ? "regex" : "plain",
    pageSize: opts.maxResults,
    beforeContext: opts.contextLines,
    afterContext: opts.contextLines,
    timeBudgetMs: 8000,
  });

  if (!result.ok) {
    return { content: `错误：内容搜索失败 - ${result.error}`, hash: "" };
  }

  const gr = result.value;
  if (gr.items.length === 0) {
    return {
      content: `未找到匹配 "${query}" 的内容（搜索了 ${gr.totalFilesSearched} 个文件，共索引 ${gr.totalFiles} 个文件）`,
      hash: "",
    };
  }

  const lines: string[] = [];
  for (const m of gr.items) {
    if (opts.contextLines > 0 && m.contextBefore && m.contextBefore.length > 0) {
      let ctxLineNo = m.lineNumber - m.contextBefore.length;
      for (const ctx of m.contextBefore) {
        lines.push(`${m.relativePath}:${ctxLineNo}:   ${ctx}`);
        ctxLineNo++;
      }
    }
    lines.push(`${m.relativePath}:${m.lineNumber}: ${m.lineContent}`);
    if (opts.contextLines > 0 && m.contextAfter && m.contextAfter.length > 0) {
      let ctxLineNo = m.lineNumber + 1;
      for (const ctx of m.contextAfter) {
        lines.push(`${m.relativePath}:${ctxLineNo}:   ${ctx}`);
        ctxLineNo++;
      }
    }
  }

  const more = gr.nextCursor
    ? "（仍有更多结果，请缩小查询范围或增加 maxResults）"
    : "";
  const header =
    `找到 ${gr.totalMatched} 个匹配` +
    `（搜索了 ${gr.totalFilesSearched} 个文件，共索引 ${gr.totalFiles} 个文件）${more}`;

  return { content: `${header}\n${lines.join("\n")}`, hash: "" };
}

/**
 * 文件名模糊搜索（fileSearch）。返回匹配文件相对路径列表（带 git 状态）。
 */
function searchFilename(
  finder: FileFinder,
  query: string,
  maxResults: number,
): SenseResult {
  const result = finder.fileSearch(query, { pageSize: maxResults });

  if (!result.ok) {
    return { content: `错误：文件名搜索失败 - ${result.error}`, hash: "" };
  }

  const sr = result.value;
  if (sr.items.length === 0) {
    return {
      content: `未找到匹配 "${query}" 的文件（共索引 ${sr.totalFiles} 个文件）`,
      hash: "",
    };
  }

  const lines = sr.items.map((it) => {
    const status = it.gitStatus && it.gitStatus !== "clean" ? ` [${it.gitStatus}]` : "";
    return `${it.relativePath}${status}`;
  });

  const more =
    sr.totalMatched > sr.items.length
      ? `（共 ${sr.totalMatched} 个匹配，显示前 ${sr.items.length} 个）`
      : "";
  const header = `找到 ${sr.totalMatched} 个匹配文件${more}（共索引 ${sr.totalFiles} 个文件）`;

  return { content: `${header}\n${lines.join("\n")}`, hash: "" };
}

export default sense(
  "search_codebase",
  "在当前代码库中搜索文本或文件名。mode=content(默认)按文件内容grep搜索文本，支持约束语法 '*.ts TODO'(仅搜TS文件)、'src/ TODO'(仅搜src目录)，可正则、可带上下文行；mode=filename按文件名模糊搜索（容错，支持 'file.ts:42' 行定位）。结果为相对路径列表。注意：搜索文件内容或定位文件主要使用本感官，而非 execute_command 调 grep/find。",
  SearchSchema,
  async (input, _senseSharedData: SenseSharedData): Promise<SenseResult> => {
    const finder = await getFinder();
    if (!finder) {
      return {
        content: "错误：文件搜索索引未就绪（fff 原生库不可用或初始扫描失败），无法执行搜索",
        hash: "",
      };
    }

    const maxResults = input.maxResults ?? 50;

    if (input.mode === "filename") {
      return searchFilename(finder, input.query, maxResults);
    }

    return searchContent(finder, input.query, {
      regex: input.regex ?? false,
      maxResults,
      contextLines: input.contextLines ?? 0,
    });
  },
  SupervisionLevel.auto,
);
