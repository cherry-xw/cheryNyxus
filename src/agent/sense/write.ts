import { z } from "zod";
import { sense, type SenseResult, type SenseSharedData } from "@/core/sense";
import { writeFile, rename, copyFile, unlink, stat } from "fs/promises";
import { SupervisionLevel } from "@/core/config";
import { hashGenerator } from "@/utils/hash.js";
import os from "os";
import path from "path";

const WriteSchema = z.object({
  path: z.string().describe("文件绝对路径"),
  content: z.string().describe("要写入文件的内容"),
});

export default sense(
  "write_file",
  "写入内容到指定文件。仅支持绝对路径。如果文件已存在将被覆盖，如果目录不存在将报错。先写入临时目录后移动到目标位置，确保数据安全。注意：写入文件主要使用`write_file`，而不是使用bash命令。",
  WriteSchema,
  async (input, senseSharedData: SenseSharedData): Promise<SenseResult> => {
    try {
      const absolutePath = input.path;

      // 检查文件是否被修改过（写入前检测）
      const readNamespace = senseSharedData.get("read_file");
      const storedHash = readNamespace?.get(absolutePath) as string | undefined;

      if (storedHash) {
        // 尝试获取当前文件状态
        try {
          const currentStat = await stat(absolutePath);
          const currentBaseHash = hashGenerator(
            "file", absolutePath, currentStat.size.toString(), currentStat.mtimeMs.toString()
          );

          // 对比hash，不同则提示重新读取
          if (currentBaseHash !== storedHash) {
            return {
              content: `[文件修改警告] 发现 "${input.path}" 写入前被修改过，需重新读取。文件状态已变更`,
              hash: "",
            };
          }
        } catch (statError) {
          // 文件不存在（ENOENT）时跳过检测，继续写入
          if ((statError as NodeJS.ErrnoException).code !== "ENOENT") {
            throw statError;
          }
        }
      }

      // write hash返回空字符串
      const hash = "";

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
        return { content: `成功写入文件 "${input.path}"`, hash };
      } catch (renameError) {
        // rename() 跨文件系统可能失败，尝试 copy + delete
        if ((renameError as NodeJS.ErrnoException).code === "EXDEV") {
          await copyFile(tmpFilePath, absolutePath);
          await unlink(tmpFilePath);
          return { content: `成功写入文件 "${input.path}"（跨文件系统移动）`, hash };
        }
        throw renameError;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          content: `错误：目录不存在，无法写入文件 "${input.path}"`,
          hash: "", // 错误情况不参与去重
        };
      }
      if ((error as NodeJS.ErrnoException).code === "EACCES") {
        return {
          content: `错误：权限不足，无法写入文件 "${input.path}"`,
          hash: "", // 错误情况不参与去重
        };
      }
      return {
        content: `错误：写入文件 "${input.path}" 失败 - ${(error as Error).message}`,
        hash: "", // 错误情况不参与去重
      };
    }
  },
  SupervisionLevel.manual, // write_file 禁止自动执行，需手动触发
);