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
      detail: 'failed before message commit',
    })

    expect(terminationNode).toMatchObject({
      id: `termination:${runId}:error`,
      kind: 'system',
      visibility: 'internal',
      direction: 'internal',
      runId,
      turnId: reservedMessageId,
      termination: {
        actor: 'system',
        code: 'error',
        detail: 'failed before message commit',
      },
    })
    expect(listExecutionNodes(chatId)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: reservedMessageId, kind: 'message' }),
      ]),
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
