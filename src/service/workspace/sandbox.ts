import { promises as fs } from 'node:fs'
import path from 'node:path'
import { getChatWorkspace } from '@/db/chat.js'
import { operationError } from '../message/operationError.js'

export function normalizeWorkspacePath(input = ''): string {
  const value = input.replaceAll('\\', '/')
  const segments = value.split('/')
  if (
    value.startsWith('/') ||
    /^[A-Za-z]:/.test(value) ||
    /[\x00-\x1f:]/.test(value) ||
    segments.some((part) => part === '..' || part.toLowerCase() === '.chery')
  ) {
    throw operationError('只允许引用工作区内的相对路径，不能访问 .chery 或父目录')
  }
  return value === '' || value === '.' ? '' : path.posix.normalize(value).replace(/\/$/, '')
}
export async function resolveWorkspaceEntry(workspace: string, input = '') {
  const relative = normalizeWorkspacePath(input)
  const root = await fs.realpath(workspace)
  if (!(await fs.stat(root)).isDirectory()) throw operationError('关联工作区不是目录')
  const absolute = await fs.realpath(path.resolve(root, relative))
  const resolved = path.relative(root, absolute)
  if (resolved === '..' || resolved.startsWith('..' + path.sep) || path.isAbsolute(resolved))
    throw operationError('文件路径超出了当前工作区')
  normalizeWorkspacePath(resolved)
  const stat = await fs.stat(absolute)
  return { root, absolute, relative, stat }
}
export async function resolveChatWorkspaceEntry(chatId: string, input = '') {
  const workspace = getChatWorkspace(chatId)
  if (!workspace) throw operationError('当前会话没有关联工作区，请先在预设中设置工作区')
  return resolveWorkspaceEntry(workspace, input)
}
