import { afterEach, describe, expect, it } from 'vitest'
import {
  clearConversationSelectionRun,
  getConversationSelection,
  recordConversationSelection,
  registerConversationSelectionRun,
} from '@/agent/shadow/conversationSelectionRegistry.js'

const runId = 'shadow-test-run'

afterEach(() => clearConversationSelectionRun(runId))

describe('conversation selection run registry', () => {
  it('records one candidate from the immutable run snapshot', () => {
    registerConversationSelectionRun(runId, ['chat-a', 'chat-b'])
    recordConversationSelection(runId, {
      chatId: 'chat-b',
      confidence: 0.8,
      reason: '延续同一主题',
    })
    expect(getConversationSelection(runId)).toEqual({
      chatId: 'chat-b',
      confidence: 0.8,
      reason: '延续同一主题',
    })
  })

  it('accepts null as the explicit new-conversation target', () => {
    registerConversationSelectionRun(runId, [])
    expect(() =>
      recordConversationSelection(runId, {
        chatId: null,
        confidence: 0.7,
        reason: '新主题',
      }),
    ).not.toThrow()
  })

  it('rejects unknown candidates and a second terminal result', () => {
    registerConversationSelectionRun(runId, ['chat-a'])
    expect(() =>
      recordConversationSelection(runId, {
        chatId: 'chat-x',
        confidence: 0.5,
        reason: '错误候选',
      }),
    ).toThrow('不在本次候选快照中')

    recordConversationSelection(runId, { chatId: 'chat-a', confidence: 1, reason: '命中' })
    expect(() =>
      recordConversationSelection(runId, { chatId: null, confidence: 1, reason: '重复' }),
    ).toThrow('已经完成选择')
  })
})
