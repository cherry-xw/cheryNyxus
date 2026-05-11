import { z } from "zod";
import { tool, type ToolResult } from "@/core/tool";
import { readFile, stat } from "fs/promises";
import { SupervisionLevel } from "@/core/config";
import { resolvePath } from "@/utils/env.js";
import { generateHash } from "@/utils/hash.js";

const ReadSchema = z.object({
  path: z.string().describe("文件路径，支持相对路径（相对于工作目录）或绝对路径"),
  limit: z.number().describe("读取的行数限制，默认读取全部内容").optional(),
  offset: z.number().describe("起始行号偏移量，默认从第0行开始").optional(),
});

const LARGE_FILE_THRESHOLD = 100 * 1024; // 100KB

export default tool(
  "read_file",
  "读取指定文件的内容，支持分段读取。路径可以是绝对路径或相对于工作目录的相对路径，注意：读取单个文件主要使用`read_file`，而不是使用bash命令。",
  ReadSchema,
  async (input): Promise<ToolResult> => {
    try {
      // 转换相对路径为绝对路径
      const absolutePath = resolvePath(input.path);

      // 获取文件状态
      const fileStat = await stat(absolutePath);

      // 大文件检测
      if (fileStat.size > LARGE_FILE_THRESHOLD) {
        return {
          content: `[大文件警告] 文件 "${input.path}" 大小为 ${(fileStat.size / 1024).toFixed(2)}KB，超过100KB阈值。\n建议：\n1. 使用limit参数分段读取\n2. 使用offset参数指定起始行\n3. 使用bash命令grep/head/tail进行预处理`,
          hash: "", // 大文件警告不参与去重
        };
      }

      const content = await readFile(absolutePath, "utf-8");
      const lines = content.split("\n");

      const offset = input.offset ?? 0;
      const limit = input.limit ?? lines.length;

      const selectedLines = lines.slice(offset, offset + limit);

      if (selectedLines.length === 0) {
        return {
          content: `文件 "${input.path}" 在指定范围内没有内容（offset: ${offset}, limit: ${limit}）`,
          hash: "", // 空内容不参与去重
        };
      }

      const result = selectedLines
        .map((line, index) => `${offset + index + 1}\t${line}`)
        .join("\n");

      // 生成hash
      const hash = generateHash(
        `file::${absolutePath}:${fileStat.size}:${fileStat.mtimeMs}:${offset}:${limit}`
      );

      return { content: result, hash };
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