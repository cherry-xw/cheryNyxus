import { randomUUID } from 'node:crypto'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { bootstrapAgentRuntime } from '@/agent/bootstrap.js'
import config, { DEFAULT_PRESET_NAME } from '@/utils/config.js'
import {
  addMessage,
  createChat,
  deleteChat,
  getChat,
  getMessages,
} from '@/db/chat.js'
import { createSpawnTask } from '@/db/delivery.js'
import {
  getFrozenChatSnapshot,
  listChatEpochs,
} from '@/db/epoch.js'
import { handleChatCreate } from '@/service/chat/handler.js'
import { ensureChat, clearChatRuntime } from '@/service/chat/runtime.js'
import { archivePresetRoots } from '@/service/config/roleLifecycle.js'
import { handleChatEpochList } from '@/service/chat/promptSnapshot.js'
import type { HandlerContext } from '@/service/message/router.js'
import { logger } from '@/utils/logger/index.js'

const cleanup: string[] = []
const originalRoles = config.roles
const originalPresets = config.presets

beforeAll(async () => {
  await bootstrapAgentRuntime()
})

afterEach(() => {
  config.roles = originalRoles
  config.presets = originalPresets
  for (const chatId of cleanup.splice(0).reverse()) {
    clearChatRuntime(chatId)
    deleteChat(chatId)
  }
})

describe('isolated default preset replacement acceptance', () => {
  it('archives the old default tree and runs a newly-created default preset without history leakage', async () => {
    const oldRoot = randomUUID()
    const oldChild = randomUUID()
    const newRoot = randomUUID()
    cleanup.push(oldRoot, oldChild, newRoot)

    config.roles = {
      ...originalRoles,
      acceptanceLeader: {
        id: 'role-default-old',
        brain: 'mock_content',
        senseGroup: 'auto_senses',
        mcpServers: [],
      },
    }
    config.presets = {
      ...originalPresets,
      [DEFAULT_PRESET_NAME]: {
        id: 'preset-default-old',
        leader: 'acceptanceLeader',
        roles: ['acceptanceLeader'],
      },
    }

    await handleChatCreate({ log: logger } as HandlerContext, {
      chatId: oldRoot,
      preset: DEFAULT_PRESET_NAME,
    })
    const oldEpoch = listChatEpochs(oldRoot).at(-1)!
    addMessage(randomUUID(), oldRoot, { role: 'user', content: 'old default history' })
    createChat(
      oldChild,
      { type: 'acceptanceLeader', roleId: 'role-default-old' },
      oldRoot,
    )
    createSpawnTask({
      childChatId: oldChild,
      parentChatId: oldRoot,
      type: 'acceptanceLeader',
      prompt: 'unfinished old work',
      brain: 'mock_content',
      senseGroup: 'auto_senses',
      epochId: oldEpoch.epochId,
      roleId: 'role-default-old',
    })

    delete config.presets[DEFAULT_PRESET_NAME]
    delete config.roles.acceptanceLeader
    expect(archivePresetRoots(['preset-default-old'], 'acceptance: remove old default')).toEqual([
      oldRoot,
    ])

    config.roles.acceptanceLeader = {
      id: 'role-default-new',
      brain: 'mock_auto',
      senseGroup: 'auto_senses',
      mcpServers: [],
    }
    config.presets[DEFAULT_PRESET_NAME] = {
      id: 'preset-default-new',
      leader: 'acceptanceLeader',
      roles: ['acceptanceLeader'],
    }
    await handleChatCreate({ log: logger } as HandlerContext, {
      chatId: newRoot,
      preset: DEFAULT_PRESET_NAME,
    })
    const newAgent = await ensureChat(newRoot)
    let chunkCount = 0
    for await (const _chunk of newAgent.run('run the recreated default preset')) chunkCount += 1

    expect(getChat(oldRoot)?.lifecycle).toBe('archived')
    expect(getChat(oldChild)?.lifecycle).toBe('archived')
    expect(getChat(newRoot)?.lifecycle).toBe('active')
    expect(getMessages(oldRoot, oldEpoch.epochId).map((row) => row.content)).toContain(
      'old default history',
    )
    const newEpoch = listChatEpochs(newRoot).at(-1)!
    expect(getMessages(newRoot, newEpoch.epochId)).toHaveLength(0)
    expect(getFrozenChatSnapshot(oldEpoch.epochId, oldRoot)).toBeDefined()
    expect(getFrozenChatSnapshot(newEpoch.epochId, newRoot)?.runtime).toMatchObject({
      brain: 'mock_auto',
    })
    expect(chunkCount).toBeGreaterThan(0)

    const oldEpochList = await handleChatEpochList(
      { log: logger } as HandlerContext,
      { chatId: oldRoot },
    )
    const newEpochList = await handleChatEpochList(
      { log: logger } as HandlerContext,
      { chatId: newRoot },
    )
    expect(oldEpochList.epochs.every((epoch) => !epoch.executable)).toBe(true)
    expect(newEpochList.epochs.some((epoch) => epoch.executable)).toBe(true)
  })
})
