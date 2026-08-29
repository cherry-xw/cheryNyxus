import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createChat, deleteChat } from '@/db/chat.js'
import {
  getExecutionActiveRun,
  listExecutionNodes,
  upsertExecutionNode,
} from '@/db/executionGraph.js'
import { recordRunFact, recordTerminationFact } from '@/service/chat/executionFacts.js'

const cleanupChats: string[] = []

afterEach(() => {
  for (const chatId of cleanupChats.splice(0).reverse()) deleteChat(chatId)
})

describe('execution termination facts', () => {
  it('records a reached limit as paused rather than failed', () => {
    const chatId = randomUUID()
    const runId = randomUUID()
    cleanupChats.push(chatId)
    createChat(chatId)
    recordRunFact({ chatId, runId, status: 'running' })

    const node = recordTerminationFact({
      chatId,
      runId,
      actor: 'system',
      code: 'limit_reached',
      content: '已达到循环上限\n\n本轮已安全暂停。',
      detail: 'iterations=30; maxLoop=30',
    })

    expect(node).toMatchObject({
      content: '已达到循环上限\n\n本轮已安全暂停。',
      termination: { code: 'limit_reached', detail: 'iterations=30; maxLoop=30' },
    })
    expect(getExecutionActiveRun(chatId, runId)).toMatchObject({ status: 'paused' })
  })

  it('uses a safe explanation for terminal facts without an explicit content', () => {
    const chatId = randomUUID()
    const runId = randomUUID()
    cleanupChats.push(chatId)
    createChat(chatId)

    const node = recordTerminationFact({
      chatId,
      runId,
      actor: 'system',
      code: 'watchdog',
      detail: '300s without output',
    })

    expect(node.content).toContain('任务长时间没有新的输出')
    expect(node.content).not.toContain('300s without output')
  })

  it('does not fabricate a message when a reserved response id was never committed', () => {
    const chatId = randomUUID()
    const runId = randomUUID()
    const reservedMessageId = randomUUID()
    cleanupChats.push(chatId)
    createChat(chatId)
    recordRunFact({
      chatId,
      runId,
      status: 'running',
      turnId: reservedMessageId,
      nodeId: reservedMessageId,
    })

    const terminationNode = recordTerminationFact({
      chatId,
      runId,
      actor: 'system',
      code: 'error',
      content: 'AI 服务配置有误\n\n请检查服务设置。',
      detail: 'failed before message commit',
    })

    expect(terminationNode).toMatchObject({
      id: `termination:${runId}:error`,
      kind: 'system',
      visibility: 'internal',
      direction: 'internal',
      content: 'AI 服务配置有误\n\n请检查服务设置。',
      runId,
      turnId: reservedMessageId,
      termination: {
        actor: 'system',
        code: 'error',
        detail: 'failed before message commit',
      },
    })
    expect(listExecutionNodes(chatId)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: reservedMessageId, kind: 'message' })]),
    )
    expect(getExecutionActiveRun(chatId, runId)).toMatchObject({
      status: 'failed',
      nodeId: terminationNode.id,
    })
  })

  it('annotates an existing committed message instead of creating a system fact', () => {
    const chatId = randomUUID()
    const runId = randomUUID()
    const messageId = randomUUID()
    cleanupChats.push(chatId)
    createChat(chatId)
    upsertExecutionNode({
      id: messageId,
      rootChatId: chatId,
      sourceChatId: chatId,
      sourceMessageId: messageId,
      kind: 'message',
      actor: { kind: 'agent', chatId },
      direction: 'agent-to-user',
      visibility: 'conversation',
      content: 'partial response',
      createdAt: 1,
      updatedAt: 1,
      status: 'committed',
    })
    recordRunFact({ chatId, runId, status: 'running', nodeId: messageId })

    const terminationNode = recordTerminationFact({
      chatId,
      runId,
      actor: 'user',
      code: 'user_abort',
    })

    expect(terminationNode).toMatchObject({
      id: messageId,
      kind: 'message',
      visibility: 'conversation',
      content: 'partial response',
      termination: { actor: 'user', code: 'user_abort' },
    })
    expect(listExecutionNodes(chatId).filter((node) => node.id.startsWith('termination:'))).toEqual(
      [],
    )
  })
})
