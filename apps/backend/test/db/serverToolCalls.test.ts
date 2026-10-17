import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createChat, deleteChat } from '@/db/chat.js'
import {
  addMessage,
  getMessages,
  parseMessageRow,
  updateAssistantSenseCalls,
} from '@/db/message.js'
import type { ServerToolCallInfo } from '@/core/message/adapter.js'

describe('服务端工具持久化', () => {
  it('新增、更新、重新读取与清空均不破坏独立续接字段和本地工具', () => {
    const chatId = randomUUID()
    createChat(chatId)
    try {
      const call: ServerToolCallInfo = {
        id: 'server-1',
        name: 'webReader',
        arguments: '{}',
        executionOwner: 'server',
        status: 'started',
        protocol: 'anthropic-messages',
      }
      const local = [{ id: 'local-1', name: 'read_file', arguments: '{}' }]
      const row = addMessage(randomUUID(), chatId, {
        role: 'assistant',
        content: 'answer',
        senseCall: local,
        serverToolCalls: [call],
        providerContinuation: { thoughtSignature: 'protected-continuation' },
      })
      const load = () =>
        parseMessageRow(getMessages(chatId).find((message) => message.id === row.id)!)
      expect(load().serverToolCalls).toEqual([call])
      expect(load().senseCall).toEqual(local)
      const completed = {
        ...call,
        status: 'completed' as const,
        result: 'page',
        sources: [{ url: 'https://example.com' }],
      }
      updateAssistantSenseCalls(chatId, row.id, local, [completed])
      expect(load().serverToolCalls).toEqual([completed])
      expect(load().providerContinuation?.thoughtSignature).toBe('protected-continuation')
      updateAssistantSenseCalls(chatId, row.id, [])
      expect(load().serverToolCalls).toEqual([completed])
      updateAssistantSenseCalls(chatId, row.id, local, [])
      expect(load().serverToolCalls).toBeUndefined()
      expect(load().senseCall).toEqual(local)
      expect(load().providerContinuation?.thoughtSignature).toBe('protected-continuation')
    } finally {
      deleteChat(chatId)
    }
  })

  it('旧消息未记录服务端调用时不补造记录', () => {
    const chatId = randomUUID()
    createChat(chatId)
    try {
      const row = addMessage(randomUUID(), chatId, { role: 'assistant', content: 'history' })
      expect(parseMessageRow(row).serverToolCalls).toBeUndefined()
      expect(row.provider_continuation).toBeNull()
    } finally {
      deleteChat(chatId)
    }
  })
})
