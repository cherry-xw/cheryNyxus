import { z } from "zod";
import { tool } from "@/tool/base/toolCreator";
import { readFile } from "fs/promises";
import { SupervisionLevel } from "@/config";
import { resolvePath } from "@/utils/env.js";

const ReadSchema = z.object({
  path: z.string().describe("文件路径，支持相对路径（相对于工作目录）或绝对路径"),
  limit: z.number().describe("读取的行数限制，默认读取全部内容").optional(),
  offset: z.number().describe("起始行号偏移量，默认从第0行开始").optional(),
});

export default tool(
  "read_file",
  "读取指定文件的内容，支持分段读取。路径可以是绝对路径或相对于工作目录的相对路径，注意：读取单个文件主要使用`read_file`，而不是使用bash命令。",
  ReadSchema,
  async (input) => {
    try {
      // 转换相对路径为绝对路径
      const absolutePath = resolvePath(input.path);

      const content = await readFile(absolutePath, "utf-8");
      const lines = content.split("\n");

      const offset = input.offset ?? 0;
      const limit = input.limit ?? lines.length;

      const selectedLines = lines.slice(offset, offset + limit);

      if (selectedLines.length === 0) {
        return `文件 "${input.path}" 在指定范围内没有内容（offset: ${offset}, limit: ${limit})`;
      }

      const result = selectedLines
        .map((line, index) => `${offset + index + 1}\t${line}`)
        .join("\n");

      return result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return `错误：文件 "${input.path}" 不存在`;
      }
      return `错误：读取文件 "${input.path}" 失败 - ${(error as Error).message}`;
    }
  },
  SupervisionLevel.auto, // read_file是安全操作，允许自动执行
);
