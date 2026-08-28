import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { addMessage, createChat, deleteChat, getMessages } from '@/db/chat.js'
import {
  ensureActiveChatEpoch,
  freezeChatEpochSnapshot,
  getActiveChatEpoch,
  getFrozenChatSnapshot,
  listChatEpochs,
} from '@/db/epoch.js'
import { getSoulDb } from '@/db/index.js'

const cleanup: string[] = []

afterEach(() => {
  for (const chatId of cleanup.splice(0).reverse()) deleteChat(chatId)
})

describe('chat context epochs', () => {
  it('creates one exact active epoch and returns it idempotently', () => {
    const chatId = randomUUID()
    cleanup.push(chatId)
    createChat(chatId)

    const first = ensureActiveChatEpoch({ chatId, revisionId: 'revision-a' })
    const second = ensureActiveChatEpoch({ chatId, revisionId: 'revision-a' })

    expect(first.created).toBe(true)
    expect(first.epoch.ordinal).toBe(0)
    expect(first.epoch.snapshotQuality).toBe('exact')
    expect(second.created).toBe(false)
    expect(second.epoch.epochId).toBe(first.epoch.epochId)
    expect(listChatEpochs(chatId)).toHaveLength(1)
  })

  it('moves pre-versioning messages into reconstructed legacy-0', () => {
    const chatId = randomUUID()
    cleanup.push(chatId)
    createChat(chatId)
    addMessage(randomUUID(), chatId, { role: 'user', content: 'legacy input' })

    const result = ensureActiveChatEpoch({ chatId, revisionId: 'revision-a' })
    const epochs = listChatEpochs(chatId)

    expect(result.legacyEpoch?.ordinal).toBe(0)
    expect(epochs.map((epoch) => epoch.snapshotQuality)).toEqual(['reconstructed', 'exact'])
    expect(getMessages(chatId, result.legacyEpoch!.epochId)).toHaveLength(1)
    expect(getMessages(chatId, result.epoch.epochId)).toHaveLength(0)
  })

  it('switches revisions without leaking structured history into the new epoch', () => {
    const chatId = randomUUID()
    cleanup.push(chatId)
    createChat(chatId)
    const oldEpoch = ensureActiveChatEpoch({ chatId, revisionId: 'revision-a' }).epoch
    addMessage(randomUUID(), chatId, {
      role: 'assistant',
      content: 'old tool call',
      senseCall: [{ id: 'call-old', name: 'retired_tool', arguments: '{}' }],
    })

    const next = ensureActiveChatEpoch({
      chatId,
      revisionId: 'revision-b',
      handoffSummary: '旧角色已退役。',
    }).epoch

    expect(next.ordinal).toBe(1)
    expect(getActiveChatEpoch(chatId)?.epochId).toBe(next.epochId)
    expect(getMessages(chatId, oldEpoch.epochId)).toHaveLength(1)
    expect(getMessages(chatId, next.epochId)).toHaveLength(0)
    expect(listChatEpochs(chatId)[0]?.status).toBe('historical')
  })

  it('freezes prompt/tool contracts once and keeps the first exact value', () => {
    const chatId = randomUUID()
    cleanup.push(chatId)
    createChat(chatId)
    const epoch = ensureActiveChatEpoch({ chatId, revisionId: 'revision-a' }).epoch

    freezeChatEpochSnapshot({
      epochId: epoch.epochId,
      chatId,
      systemPrompt: 'frozen prompt',
      tools: [{ name: 'read_file', description: 'read', parameters: { type: 'object' } }],
      runtime: { brain: 'a' },
      resources: { config: 'hash-a' },
    })
    freezeChatEpochSnapshot({
      epochId: epoch.epochId,
      chatId,
      systemPrompt: 'drifted prompt',
      tools: [],
      runtime: { brain: 'b' },
      resources: { config: 'hash-b' },
    })

    const frozen = getFrozenChatSnapshot(epoch.epochId, chatId)
    expect(frozen?.systemPrompt).toBe('frozen prompt')
    expect(frozen?.tools[0]?.name).toBe('read_file')
    expect(frozen?.runtime).toEqual({ brain: 'a' })
  })

  it('removes epoch rows when the root chat is physically deleted', () => {
    const chatId = randomUUID()
    createChat(chatId)
    ensureActiveChatEpoch({ chatId, revisionId: 'revision-a' })
    deleteChat(chatId)

    const count = getSoulDb()
      .prepare('SELECT COUNT(*) AS count FROM chat_epochs WHERE root_chat_id = ?')
      .get(chatId) as { count: number }
    expect(count.count).toBe(0)
  })
})
