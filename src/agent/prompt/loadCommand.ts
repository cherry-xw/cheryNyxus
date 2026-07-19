import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import yaml from 'js-yaml'

export interface SystemCommand {
  name: string
  description: string
  content: string
}

const COMMAND_FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/

/**
 * 实时读取单个系统内置命令（如 compact）。命令文件可编辑，但仅由系统声明的名称触发，
 * 因而不会进入用户 Skill 的管理/删除范围。
 *
 * 不再被默认 system prompt 注入（避免占用 token 预算）；
 * 在 autoCompact / 手动 /compact 触发时由 service 层实时 readFile 拿正文，
 * 临时附注到该轮 user prompt 末尾。详见 docs/agent/command.md。
 */
export function getSystemCommand(name: string): SystemCommand | undefined {
  const filePath = join(process.env.CHERY_DIR || process.cwd(), '.chery', 'command', `${name}.md`)
  if (!existsSync(filePath)) return undefined

  const raw = readFileSync(filePath, 'utf-8').trim()
  const match = raw.match(COMMAND_FRONTMATTER)
  if (!match) return { name, description: '', content: raw }

  try {
    const meta = (yaml.load(match[1]!) || {}) as Record<string, unknown>
    return {
      name: typeof meta.name === 'string' && meta.name ? meta.name : name,
      description: typeof meta.description === 'string' ? meta.description : '',
      content: raw.slice(match[0].length).trim(),
    }
  } catch {
    return { name, description: '', content: raw }
  }
}
