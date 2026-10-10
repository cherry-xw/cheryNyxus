import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createChat, deleteChat } from '@/db/chat.js'
import { ensureActiveChatEpoch } from '@/db/epoch.js'
import { archivePresetRoots } from '@/service/config/roleLifecycle.js'
import {
  handleChatEpochList,
  handleChatPromptSnapshot,
} from '@/service/chat/promptSnapshot.js'
import type { HandlerContext } from '@/service/message/router.js'
import { logger } from '@/utils/logger/index.js'

const cleanup: string[] = []

afterEach(() => {
  for (const chatId of cleanup.splice(0).reverse()) deleteChat(chatId)
})

describe('archived epoch inspection', () => {
  it('never fabricates a missing historical snapshot from the latest config', async () => {
    const chatId = randomUUID()
    cleanup.push(chatId)
    createChat(chatId, { presetId: 'preset-archived' })
    const epoch = ensureActiveChatEpoch({ chatId, revisionId: 'revision-old' }).epoch
    archivePresetRoots(['preset-archived'], 'preset deleted')

    const snapshot = await handleChatPromptSnapshot(
      { log: logger } as HandlerContext,
      { chatId, epochId: epoch.epochId },
    )
    const list = await handleChatEpochList(
      { log: logger } as HandlerContext,
      { chatId },
    )

    expect(snapshot.snapshotQuality).toBe('partial')
    expect(snapshot.systemPrompt).toContain('不会用最新配置伪造历史上下文')
    expect(snapshot.tools).toEqual([])
    expect(list.activeEpochId).toBeUndefined()
    expect(list.epochs.every((entry) => entry.executable === false)).toBe(true)
  })
})
