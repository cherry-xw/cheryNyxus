import { z } from "zod";
import { readFile, stat } from "fs/promises";
import path from "path";
import { tool, type ToolResult, type ToolSharedData } from "@/core/tool";
import { SupervisionLevel } from "@/core/config";
import { hashGenerator } from "@/utils/hash.js";
import config from "@/utils/config.js";
import { compressLog } from "@/utils/drain/index.js";

const ReadSchema = z.object({
  path: z.string().describe("文件绝对路径（注意操作系统）"),
  limit: z.number().describe("读取的行数限制，默认读取全部内容").optional(),
  offset: z.number().describe("起始行号偏移量，默认从第0行开始，超长会自动截取").optional(),
  compression: z.enum(["auto", "truncate", "drain", "none"])
    .describe("压缩策略：auto(自动判断)、truncate(截断)、drain(日志去重)、none(不压缩)")
    .optional()
    .default("auto"),
});

const LARGE_FILE_THRESHOLD = 100 * 1024; // 100KB

/**
 * 判断是否为日志文件（基于扩展名）
 */
function isLogFile(path: string, extensions: string[]): boolean {
  return extensions.some((ext) => path.toLowerCase().endsWith(ext));
}

/**
 * 截断大文件（仅保留头部）
 */
function truncateContent(
  content: string,
  previewLines: number,
  filePath: string,
): string {
  const lines = content.split("\n");
  const totalLines = lines.length;

  if (totalLines <= previewLines) {
    return content;
  }

  const headLines = lines.slice(0, previewLines);
  const truncatedLines = totalLines - previewLines;

  const result = headLines
    .map((line, index) => `${index + 1}\t${line}`)
    .join("\n");

  return (
    result +
    `\n\n[大文件截断] 文件 "${filePath}" 大小超过阈值\n` +
    `- 已截断：仅显示前${previewLines}行\n` +
    `- 省略了剩余${truncatedLines}行\n` +
    `- 完整内容可使用 read_file(path, {offset: ${previewLines}}) 继续`
  );
}

export default tool(
  "read_file",
  "读取指定文件的内容，支持分段读取和智能压缩。路径必须是绝对路径（Unix: /path，Windows: C:\\path 或 C:/path）。大文件自动截断或使用Drain算法去重。注意：读取单个文件主要使用`read_file`，而不是使用bash命令。",
  ReadSchema,
  async (input, toolSharedData: ToolSharedData): Promise<ToolResult> => {
    try {
      // 检查路径是否为绝对路径（支持跨平台）
      if (!path.isAbsolute(input.path)) {
        return {
          content: `错误：路径 "${input.path}" 不是绝对路径。Unix需以 / 开头，Windows需以盘符开头（如 C:\\）。`,
          hash: "", // 错误情况不参与去重
        };
      }

      const absolutePath = input.path;

      // 获取文件状态
      const fileStat = await stat(absolutePath);

      // 读取文件内容
      const content = await readFile(absolutePath, "utf-8");

      // 获取压缩配置（如果配置不存在则使用默认值）
      const compressionConfig = config.global.file_compression;
      const truncateThreshold = compressionConfig?.truncate_threshold ?? LARGE_FILE_THRESHOLD;
      const truncatePreviewLines = compressionConfig?.truncate_preview_lines ?? 100;
      const logExtensions = compressionConfig?.log_file_extensions ?? [".log", ".txt", ".out", ".err"];
      const drainPreviewCount = compressionConfig?.drain_preview_count ?? 3;

      // 确定压缩策略
      let compressionStrategy = input.compression;

      if (compressionStrategy === "auto") {
        // 自动判断逻辑
        if (fileStat.size <= truncateThreshold) {
          compressionStrategy = "none"; // 小文件不压缩
        } else if (isLogFile(input.path, logExtensions)) {
          compressionStrategy = "drain"; // 日志文件使用Drain算法
        } else {
          compressionStrategy = "truncate"; // 非日志文件截断
        }
      }

      // 应用压缩策略
      let processedContent = content;
      let compressionInfo = "";

      if (compressionStrategy === "truncate" && fileStat.size > truncateThreshold) {
        processedContent = truncateContent(content, truncatePreviewLines, input.path);
        compressionInfo = `[压缩策略: 截断]`;
      } else if (compressionStrategy === "drain") {
        try {
          const drainResult = await compressLog(content, drainPreviewCount);
          processedContent = drainResult.compressedContent;
          compressionInfo = `[压缩策略: Drain去重] 模板数量: ${drainResult.templateCount}, 压缩率: ${drainResult.compressionRatio}`;
        } catch (error) {
          // Drain算法失败时回退到截断策略
          if (fileStat.size > truncateThreshold) {
            processedContent = truncateContent(content, truncatePreviewLines, input.path);
            compressionInfo = `[压缩策略: 截断（Drain失败回退）]`;
          }
        }
      }

      // 应用limit和offset参数
      const lines = processedContent.split("\n");
      const offset = input.offset ?? 0;
      const limit = input.limit ?? lines.length;
      const selectedLines = lines.slice(offset, offset + limit);

      if (selectedLines.length === 0) {
        return {
          content: `文件 "${input.path}" 在指定范围内没有内容（offset: ${offset}, limit: ${limit}）`,
          hash: "", // 空内容不参与去重
        };
      }

      // 格式化输出（保持行号格式）
      const result = selectedLines
        .map((line, index) => {
          // 如果已经是压缩格式的输出（包含\t），则不再添加行号
          if (line.includes("\t") || line.startsWith("===") || line.startsWith("[") || line.startsWith("-")) {
            return line;
          }
          return `${offset + index + 1}\t${line}`;
        })
        .join("\n");

      // 添加压缩信息（如果有）
      const finalResult = compressionInfo ? `${result}\n\n${compressionInfo}` : result;

      // 生成完整hash（用于去重）
      const hash = hashGenerator(
        "file", absolutePath, fileStat.size.toString(), fileStat.mtimeMs.toString(),
        offset.toString(), limit.toString(), compressionStrategy
      );

      // 生成基础hash并写入toolSharedData（用于write修改检测）
      const fileHash = hashGenerator(
        "file", absolutePath, fileStat.size.toString(), fileStat.mtimeMs.toString()
      );
      let readNamespace = toolSharedData.get("read_file");
      if (!readNamespace) {
        readNamespace = new Map();
        toolSharedData.set("read_file", readNamespace);
      }
      readNamespace.set(absolutePath, fileHash);

      return { content: finalResult, hash };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          content: `错误：文件 "${input.path}" 不存在`,
          hash: "", // 错误情况不参与去重
        };
      }
      return {
        content: `错误：读取文件 "${input.path}" 失败 - ${(error as Error).message}`,
        hash: "", // 错误情况不参与去重
      };
    }
  },
  SupervisionLevel.auto,
);