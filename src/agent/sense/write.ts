import { z } from 'zod'
import { sense, type SenseResult, type SenseSharedData } from '@/core/sense'
import { writeFile, rename, copyFile, unlink, stat, readFile } from 'fs/promises'
import { SupervisionLevel } from '@/core/config'
import { hashGenerator } from '@/utils/hash.js'
import os from 'os'
import path from 'path'

const WriteSchema = z.object({
  path: z.string().describe('文件绝对路径'),
  content: z.string().describe('要写入文件的内容'),
  offset: z
    .number()
    .int()
    .min(0)
    .describe('起始行号偏移量（0-based），与 limit 配合使用实现行范围替换。不指定则写入整个文件')
    .optional(),
  limit: z
    .number()
    .int()
    .min(0)
    .describe('要替换的行数，与 offset 配合使用。不指定则写入整个文件')
    .optional(),
})

/**
 * 替换文件中指定行范围的内容
 * @param originalContent 原始文件内容
 * @param newContent 要插入的新内容
 * @param offset 起始行号（0-based）
 * @param limit 要替换的行数
 * @returns 替换后的文件内容
 */
function replaceLines(
  originalContent: string,
  newContent: string,
  offset: number,
  limit: number,
): string {
  const lines = originalContent.split('\n')

  // 处理边界情况
  const clampedOffset = Math.max(0, Math.min(offset, lines.length))
  const clampedEnd = Math.max(clampedOffset, Math.min(offset + limit, lines.length))

  // 构建新内容行数组
  const newLines = newContent.split('\n')

  // 替换指定范围：删除 [offset, offset+limit) 范围的行，插入新内容
  const result = [...lines.slice(0, clampedOffset), ...newLines, ...lines.slice(clampedEnd)]

  return result.join('\n')
}

export default sense(
  'write_file',
  '写入内容到指定文件。仅支持绝对路径。如果文件已存在将被覆盖，如果目录不存在将报错。先写入临时目录后移动到目标位置，确保数据安全。注意：写入文件主要使用`write_file`，而不是使用bash命令。',
  WriteSchema,
  async (input, senseSharedData: SenseSharedData): Promise<SenseResult> => {
    try {
      const absolutePath = input.path
      const isRangeWrite = input.offset !== undefined && input.limit !== undefined

      // 行范围写入的参数验证
      if (
        (input.offset !== undefined && input.limit === undefined) ||
        (input.offset === undefined && input.limit !== undefined)
      ) {
        return {
          content: `错误：offset 和 limit 必须同时指定或不指定`,
          hash: '',
        }
      }

      // 检查文件是否被修改过（写入前检测）
      const readNamespace = senseSharedData.get('read_file')
      const storedHash = readNamespace?.get(absolutePath) as string | undefined

      if (storedHash) {
        // 尝试获取当前文件状态
        try {
          const currentStat = await stat(absolutePath)
          const currentBaseHash = hashGenerator(
            'file',
            absolutePath,
            currentStat.size.toString(),
            currentStat.mtimeMs.toString(),
          )

          // 对比hash，不同则提示重新读取
          if (currentBaseHash !== storedHash) {
            return {
              content: `[文件修改警告] 发现 "${input.path}" 写入前被修改过，需重新读取。文件状态已变更`,
              hash: '',
            }
          }
        } catch (statError) {
          // 文件不存在（ENOENT）时，如果是行范围写入则报错，否则继续
          if ((statError as NodeJS.ErrnoException).code === 'ENOENT') {
            if (isRangeWrite) {
              return {
                content: `错误：文件 "${input.path}" 不存在，无法执行行范围替换。请先创建文件或使用完整写入。`,
                hash: '',
              }
            }
          } else {
            throw statError
          }
        }
      } else if (isRangeWrite) {
        // 行范围写入但未检测到读取记录，需要先读取文件
        // 尝试检查文件是否存在
        try {
          await stat(absolutePath)
          // 文件存在但没有读取记录，提示先读取
          return {
            content: `错误：执行行范围替换前需要先读取文件 "${input.path}"。请先使用 read_file 读取该文件。`,
            hash: '',
          }
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code === 'ENOENT') {
            return {
              content: `错误：文件 "${input.path}" 不存在，无法执行行范围替换。请先创建文件或使用完整写入。`,
              hash: '',
            }
          }
          throw statError
        }
      }

      // write hash返回空字符串
      const hash = ''

      // 确定最终写入内容
      let finalContent: string

      if (isRangeWrite) {
        // 行范围替换模式
        const originalContent = await readFile(absolutePath, 'utf-8')
        finalContent = replaceLines(originalContent, input.content, input.offset!, input.limit!)
      } else {
        // 完整写入模式
        finalContent = input.content
      }

      // 获取临时目录（跨平台兼容）
      const tmpDir = os.tmpdir()

      // 生成临时文件名（避免命名冲突）
      const filename = path.basename(absolutePath)
      const tmpFilePath = path.join(tmpDir, `${Date.now()}-${filename}`)

      // 先写入临时文件
      await writeFile(tmpFilePath, finalContent, 'utf-8')

      // 尝试移动临时文件到目标位置
      try {
        await rename(tmpFilePath, absolutePath)

        if (isRangeWrite) {
          return {
            content: `成功替换文件 "${input.path}" 第 ${input.offset} 到 ${input.offset! + input.limit! - 1} 行的内容`,
            hash,
          }
        }
        return { content: `成功写入文件 "${input.path}"`, hash }
      } catch (renameError) {
        // rename() 跨文件系统可能失败，尝试 copy + delete
        if ((renameError as NodeJS.ErrnoException).code === 'EXDEV') {
          await copyFile(tmpFilePath, absolutePath)
          await unlink(tmpFilePath)

          if (isRangeWrite) {
            return {
              content: `成功替换文件 "${input.path}" 第 ${input.offset} 到 ${input.offset! + input.limit! - 1} 行的内容（跨文件系统移动）`,
              hash,
            }
          }
          return { content: `成功写入文件 "${input.path}"（跨文件系统移动）`, hash }
        }
        throw renameError
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          content: `错误：目录不存在，无法写入文件 "${input.path}"`,
          hash: '', // 错误情况不参与去重
        }
      }
      if ((error as NodeJS.ErrnoException).code === 'EACCES') {
        return {
          content: `错误：权限不足，无法写入文件 "${input.path}"`,
          hash: '', // 错误情况不参与去重
        }
      }
      return {
        content: `错误：写入文件 "${input.path}" 失败 - ${(error as Error).message}`,
        hash: '', // 错误情况不参与去重
      }
    }
  },
  SupervisionLevel.manual, // write_file 禁止自动执行，需手动触发
)
