import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createChat, deleteChat, getChatSystemPromptFile } from '@/db/chat.js'
import { closeAllDbs } from '@/db/index.js'
import config from '@/utils/config.js'

let tempCheryDir = ''
const cleanup: string[] = []

beforeEach(() => {
  tempCheryDir = mkdtempSync(join(tmpdir(), 'chery-chatsp-'))
  process.env.CHERY_DIR = tempCheryDir
  config.global.db_dir = join(tempCheryDir, '.chery', 'db')
})

afterEach(() => {
  for (const chatId of cleanup.splice(0).reverse()) deleteChat(chatId)
  // 关闭 db 缓存释放 SQLite 文件句柄，否则 Windows 上 rmSync 会 EBUSY
  closeAllDbs()
  if (process.env.CHERY_DIR === tempCheryDir) delete process.env.CHERY_DIR
  rmSync(tempCheryDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
})

describe('getChatSystemPromptFile', () => {
  it('无 systemPromptFile → undefined', () => {
    const chatId = randomUUID()
    cleanup.push(chatId)
    createChat(chatId)

    expect(getChatSystemPromptFile(chatId)).toBeUndefined()
  })

  it('相对路径按「相对 CHERY_DIR/.chery」解析为绝对路径（存量被写坏数据兜底）', () => {
    const chatId = randomUUID()
    cleanup.push(chatId)
    // 模拟配置热更新曾写入的原始相对路径（prompt/index.ts existsSync 相对 cwd 解析不到 → 反复告警）
    createChat(chatId, { systemPromptFile: 'prompt/cheryNyxus/cheryNyxus.md' })

    expect(getChatSystemPromptFile(chatId)).toBe(
      join(tempCheryDir, '.chery', 'prompt', 'cheryNyxus', 'cheryNyxus.md'),
    )
  })

  it('绝对路径原样返回', () => {
    const chatId = randomUUID()
    cleanup.push(chatId)
    const abs = join(tempCheryDir, '.chery', 'prompt', 'leader.md')
    createChat(chatId, { systemPromptFile: abs })

    expect(getChatSystemPromptFile(chatId)).toBe(abs)
  })
})
