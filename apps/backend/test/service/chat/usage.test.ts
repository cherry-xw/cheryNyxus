import { beforeEach, describe, expect, it, vi } from 'vitest'

const recordsByTask = new Map<string, Array<Record<string, unknown>>>()

vi.mock('@/db/usage.js', () => ({
  readRequestUsage: (taskKey: string) => recordsByTask.get(taskKey) ?? [],
  readRequestUsagePage: vi.fn(),
  readUsageOperations: () => [],
  readUsageOperationsPage: vi.fn(),
}))
vi.mock('@/db/chat.js', () => ({ getChat: () => undefined }))
vi.mock('@/db/chatFamily.js', () => ({ getChatFamily: () => undefined, listChatFamilies: () => [] }))
vi.mock('@/service/chat/promptSnapshot.js', () => ({ handleChatPromptSnapshot: vi.fn() }))

import { handleUsageSummaries } from '@/service/chat/usage.js'

function request(taskKey: string, attemptId: string, inputMessageId: string) {
  return {
    attemptId,
    taskKey,
    chatId: taskKey,
    model: 'test-model',
    provider: 'test-provider',
    protocol: 'openai',
    startedAt: 1,
    endedAt: 2,
    status: 'completed',
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    context: { system: 0, tools: 0, conversation: 0, limit: null },
    inputMessageId,
  }
}

describe('task usage summaries', () => {
  beforeEach(() => recordsByTask.clear())

  it('keeps activity on the task that received requests when another task is empty', async () => {
    recordsByTask.set('old-task', [
      request('old-task', 'attempt-1', 'message-1'),
      request('old-task', 'attempt-2', 'message-2'),
    ])

    const result = await handleUsageSummaries({} as never, {
      taskKeys: ['old-task', 'new-empty-task'],
    })

    expect(result.items).toHaveLength(2)
    expect(result.items[0]).toMatchObject({
      taskKey: 'old-task',
      totalTokens: { value: 30 },
      requests: { value: 2 },
      rounds: { value: 2 },
      agentCount: 1,
    })
    expect(result.items[1]).toMatchObject({
      taskKey: 'new-empty-task',
      totalTokens: { value: null },
      requests: { value: 0 },
      rounds: { value: 0 },
      agentCount: 0,
    })
  })
})
