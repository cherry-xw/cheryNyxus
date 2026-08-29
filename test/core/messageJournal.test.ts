import { describe, expect, it } from 'vitest'
import { MessageJournal } from '@/core/middleware/messageJournal.js'
import { logger } from '@/utils/logger/index.js'
import type { SoulGroup } from '@/core/middleware/types.js'

describe('MessageJournal compact', () => {
  it('retains only the base system prompt and compact summary for future context', () => {
    const soul: SoulGroup = {
      chatId: 'chat',
      senseSharedData: new Map(),
      userInputs: [],
      messages: [
        { id: 'system', role: 'system', content: 'base', createdAt: 1, updateAt: 1 },
        { id: 'old', role: 'user', content: 'old context', createdAt: 2, updateAt: 2 },
        { id: 'compact', role: 'user', content: '[[command:/compact]]', createdAt: 3, updateAt: 3 },
      ],
    }
    const journal = new MessageJournal(soul, logger)
    const summary = journal.appendAssistant({ content: 'summary', thinking: '', senseCalls: [] })
    expect(summary.contextCompaction).toBe(true)
    expect(summary.contextCompactionTokens).toBeGreaterThan(0)

    journal.compactToLatestSummary()

    expect(journal.getMessages()).toHaveLength(2)
    expect(journal.getMessages()[1]).toMatchObject({
      role: 'system',
      content: expect.stringContaining('summary'),
    })
  })
})

describe('MessageJournal injected inputs', () => {
  it('keeps model-only instructions ephemeral and exposes the original user text', () => {
    const soul: SoulGroup = {
      chatId: 'chat',
      senseSharedData: new Map(),
      userInputs: [],
      messages: [],
    }
    const journal = new MessageJournal(soul, logger)
    journal.appendUserInput('injected command body', { ephemeral: true })
    journal.appendUserInput('[[command:/compact]]\nactual request', {
      persistedContent: 'actual request',
    })

    const { messages } = journal.appendUserMessages()

    expect(journal.getMessages()).toMatchObject([
      { role: 'user', content: 'injected command body', ephemeral: true },
      { role: 'user', content: '[[command:/compact]]\nactual request' },
    ])
    expect(messages).toMatchObject([
      { role: 'user', content: 'injected command body', ephemeral: true },
      { role: 'user', content: 'actual request' },
    ])
  })
})

describe('MessageJournal updateAssistantSenseCalls', () => {
  it('in-place 更新指定 assistant 的 senseCalls（reconcile 内存回写）', () => {
    const soul: SoulGroup = {
      chatId: 'chat',
      senseSharedData: new Map(),
      userInputs: [],
      messages: [],
    }
    const journal = new MessageJournal(soul, logger)
    const assistant = journal.appendAssistant({
      content: 'c',
      thinking: '',
      senseCalls: [{ id: 't0', name: 'read_file', arguments: '{}' }],
    })

    journal.updateAssistantSenseCalls(assistant.id, [
      { id: 't0', name: 'read_file', arguments: '{}' },
      { id: 't1', name: 'write_file', arguments: '{}' },
    ])

    expect(journal.getMessages().find((m) => m.id === assistant.id)?.senseCalls).toEqual([
      { id: 't0', name: 'read_file', arguments: '{}' },
      { id: 't1', name: 'write_file', arguments: '{}' },
    ])
  })

  it('id 未命中时静默忽略（不抛错不新增）', () => {
    const soul: SoulGroup = {
      chatId: 'chat',
      senseSharedData: new Map(),
      userInputs: [],
      messages: [],
    }
    const journal = new MessageJournal(soul, logger)
    journal.appendAssistant({ content: 'c', thinking: '', senseCalls: [] })

    journal.updateAssistantSenseCalls('missing-id', [{ id: 't1', name: 'x', arguments: '{}' }])

    expect(journal.getMessages()).toHaveLength(1)
    expect(journal.getMessages()[0]?.senseCalls).toEqual([])
  })
})
