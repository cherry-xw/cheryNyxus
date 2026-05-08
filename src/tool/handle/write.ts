import { z } from "zod";
import { tool } from "@/tool/base/toolCreator";
import { writeFile, rename, copyFile, unlink } from "fs/promises";
import { SupervisionLevel } from "@/config";
import { resolvePath } from "@/utils/env.js";
import os from "os";
import path from "path";

const WriteSchema = z.object({
  path: z.string().describe("文件路径，支持相对路径（相对于工作目录）或绝对路径"),
  content: z.string().describe("要写入文件的内容"),
});

export default tool(
  "write_file",
  "写入内容到指定文件。路径可以是绝对路径或相对于工作目录的相对路径。如果文件已存在将被覆盖，如果目录不存在将报错。先写入临时目录后移动到目标位置，确保数据安全。注意：写入文件主要使用`write_file`，而不是使用bash命令。",
  WriteSchema,
  async (input) => {
    try {
      // 转换相对路径为绝对路径
      const absolutePath = resolvePath(input.path);

      // 获取临时目录（跨平台兼容）
      const tmpDir = os.tmpdir();

      // 生成临时文件名（避免命名冲突）
      const filename = path.basename(absolutePath);
      const tmpFilePath = path.join(tmpDir, `${Date.now()}-${filename}`);

      // 先写入临时文件
      await writeFile(tmpFilePath, input.content, "utf-8");

      // 尝试移动临时文件到目标位置
      try {
        await rename(tmpFilePath, absolutePath);
        return `成功写入文件 "${input.path}"`;
      } catch (renameError) {
        // rename() 跨文件系统可能失败，尝试 copy + delete
        if ((renameError as NodeJS.ErrnoException).code === "EXDEV") {
          await copyFile(tmpFilePath, absolutePath);
          await unlink(tmpFilePath);
          return `成功写入文件 "${input.path}"（跨文件系统移动）`;
        }
        throw renameError;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return `错误：目录不存在，无法写入文件 "${input.path}"`;
      }
      if ((error as NodeJS.ErrnoException).code === "EACCES") {
        return `错误：权限不足，无法写入文件 "${input.path}"`;
      }
      return `错误：写入文件 "${input.path}" 失败 - ${(error as Error).message}`;
    }
  },
  SupervisionLevel.manual, // write_file 禁止自动执行，需手动触发
);