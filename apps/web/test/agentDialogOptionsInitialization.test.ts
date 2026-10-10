import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('agent dialog option initialization', () => {
  it('initializes the reconnect guard before registering the immediate chat watcher', async () => {
    const source = await readFile(
      resolve(import.meta.dirname, '../src/features/agent/composer/useAgentDialogOptions.ts'),
      'utf8',
    )
    const normalized = source.replace(/\r\n/g, '\n')
    const reconnectGuard = normalized.indexOf('let connectResumed = false')
    const immediateChatWatcher = normalized.indexOf('watch(\n    chatId,')

    expect(reconnectGuard).toBeGreaterThan(-1)
    expect(immediateChatWatcher).toBeGreaterThan(-1)
    expect(reconnectGuard).toBeLessThan(immediateChatWatcher)
  })
})
