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
    // User text cannot turn an ordinary assistant response into a verified summary.
    expect(summary.contextCompaction).toBeUndefined()
    expect(summary.contextCompactionTokens).toBeUndefined()
    journal.compactToLatestSummary()
    expect(journal.getMessages()).toHaveLength(4)
    // The dedicated summary writer supplies the explicit committed marker.
    soul.messages!.at(-1)!.contextCompaction = true

    journal.compactToLatestSummary()

    expect(journal.getMessages()).toHaveLength(2)
    expect(journal.getMessages()[1]).toMatchObject({
      role: 'system',
      contextCompaction: true,
      content: expect.stringContaining('summary'),
    })
  })
})

describe('MessageJournal injected inputs', () => {
  it('accepts a source-only anchor without manufacturing text and preserves its fixed source identity', () => {
    const soul: SoulGroup = { chatId: 'source-only-journal', senseSharedData: new Map(), userInputs: [], messages: [] }
    const journal = new MessageJournal(soul, logger)
    const sourceInput: import('@chery/protocol').SourceInput = { kind: 'source_snapshot', requestId: 'request', turnId: 'request',
      scopeId: 'scope', snapshotId: 'snapshot', actorRecord: { recordId: 'actor', revision: 1 }, inputRecords: [{ recordId: 'actor', revision: 1 }] }
    expect(journal.appendUserInput('')).toBeUndefined()
    const entry = journal.appendUserInput('', { commandId: 'source-command', sourceInput })
    expect(entry?.content).toBe('')
    sourceInput.snapshotId = 'later-mutation'
    const result = journal.appendUserMessages()
    expect(result.consumedCount).toBe(1)
    expect(result.messages[0]).toMatchObject({ content: '', sourceInput: { snapshotId: 'snapshot' } })
    expect(journal.getMessages()[0]).toMatchObject({ content: '', sourceInput: { snapshotId: 'snapshot' } })
  })

  it('keeps fixed asset versions and reference-only usage in memory and persistence effects', () => {
    const soul: SoulGroup = { chatId: 'chat', senseSharedData: new Map(), userInputs: [], messages: [] }
    const journal = new MessageJournal(soul, logger)
    const parts: import('@chery/protocol').MessagePart[] = [
      { partId: 'before', type: 'text', text: '说明' },
      { partId: 'file', type: 'asset', assetId: 'asset', assetVersionId: 'version', variant: 'original', usage: 'reference-only' },
      { partId: 'after', type: 'text', text: '后文' },
    ]
    journal.appendUserInput('说明[文件: asset]后文', { parts, commandId: 'command' })
    parts[0] = { partId: 'changed', type: 'text', text: '调用方后来修改' }
    const result = journal.appendUserMessages()
    expect(result.messages[0]?.parts?.map((part) => part.partId)).toEqual(['before', 'file', 'after'])
    expect(journal.getMessages()[0]?.parts).toEqual(result.messages[0]?.parts)
    expect(result.messages[0]?.parts?.[1]).toMatchObject({ assetVersionId: 'version', usage: 'reference-only' })
  })

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
