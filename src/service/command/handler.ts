/**
 * 内置命令系统后端（settings 「指令」tab）。
 *
 * 数据源：.chery/command/<name>.md，frontmatter 解析规则与 .chery/skills/SKILL.md 类似。
 * 命名规则：[a-zA-Z0-9_-]+（拒绝 ../ 越权、空字符、扩展名）。
 *
 * **只读枚举**：指令不可在前端增删改（正文由文件系统维护）。本模块仅暴露 `command.list`，
 * 供 Tab 展示「存在哪些指令 + 描述 + 是否可用」。compact 的阈值配置走 `config.save`
 * （`global.command.*`），不在此处。
 *
 * 文件 IO 复用 agent/prompt/loadCommand.ts 的 frontmatter 解析逻辑（list 单独实现遍历）。
 */
import { existsSync, readdirSync, readFileSync } from 'fs'
import { join, basename } from 'path'
import yaml from 'js-yaml'
import type { HandlerContext } from '../message/router.js'
import { Method, type CommandInfo, type CommandListResponseData } from '../message/types.js'

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/
const NAME_PATTERN = /^[a-zA-Z0-9_-]+$/

function commandDir(): string {
  return join(process.env.CHERY_DIR || process.cwd(), '.chery', 'command')
}

function commandPath(name: string): string {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`命令名 "${name}" 非法（仅允许 [a-zA-Z0-9_-]）`)
  }
  return join(commandDir(), `${name}.md`)
}

function parseCommandFile(name: string, raw: string): CommandInfo {
  const text = raw.trim()
  const match = text.match(FRONTMATTER)
  if (!match) return { name, description: '', content: text }
  try {
    const meta = (yaml.load(match[1]!) || {}) as Record<string, unknown>
    return {
      name: typeof meta.name === 'string' && meta.name ? meta.name : name,
      description: typeof meta.description === 'string' ? meta.description : '',
      content: text.slice(match[0].length).trim(),
    }
  } catch {
    return { name, description: '', content: text }
  }
}

function readCommand(name: string): CommandInfo | undefined {
  const filePath = commandPath(name)
  if (!existsSync(filePath)) return undefined
  const raw = readFileSync(filePath, 'utf-8')
  return parseCommandFile(name, raw)
}

/**
 * 列出 .chery/command/ 下全部 .md：name、description、content（trim 后正文）。
 * 目录不存在返回 []。非法文件名（不匹配 NAME_PATTERN）跳过不暴露。
 */
export async function handleCommandList(
  _ctx: HandlerContext,
  _params: unknown,
): Promise<CommandListResponseData> {
  const dir = commandDir()
  if (!existsSync(dir)) return { commands: [] }
  const files = readdirSync(dir)
  const commands: CommandInfo[] = []
  for (const f of files) {
    if (!f.toLowerCase().endsWith('.md')) continue
    const name = basename(f, '.md')
    if (!NAME_PATTERN.test(name)) continue
    try {
      const info = readCommand(name)
      if (info) commands.push(info)
    } catch (err) {
      console.warn(`[command.list] 跳过 ${name}:`, (err as Error).message)
    }
  }
  // 按 name 稳定排序（前端列表顺序）
  commands.sort((a, b) => a.name.localeCompare(b.name))
  return { commands }
}

/** 注册内置命令系统 RPC handlers（仅 list）。 */
export function registerCommandHandlers(router: import('../message/router.js').RpcRouter): void {
  router.register(Method.COMMAND_LIST, handleCommandList)
}

// 显式类型导出，避免 TS 误删 imports
export type { CommandInfo } from '../message/types.js'
