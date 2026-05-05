import { z } from "zod";
import { tool } from "@/tool/base/toolCreator";
import { readFile } from "fs/promises";
import { SupervisionLevel } from "@/config";

const ReadSchema = z.object({
  path: z.string().describe("文件路径，例如: /path/to/file.txt"),
  limit: z.number().describe("读取的行数限制，默认读取全部内容").optional(),
  offset: z.number().describe("起始行号偏移量，默认从第0行开始").optional(),
});

export const readTool = tool(
  "read_file",
  "读取指定文件的内容，支持分段读取",
  ReadSchema,
  async (input) => {
    try {
      const content = await readFile(input.path, "utf-8");
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
