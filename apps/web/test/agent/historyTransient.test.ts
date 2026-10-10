import { describe, expect, it } from 'vitest'
import type { PendingInput } from '../../src/services/agentApi'
import {
  appendQueuedInputsAfterHistory,
  pendingInputHistory,
} from '../../src/features/agent/drawer/historyTransient'

describe('pendingInputHistory', () => {
  it('preserves queue state and orders queued items by queue sequence', () => {
    const inputs: PendingInput[] = [
      {
        inputId: 'later',
        messageId: 'message-later',
        content: '第二条排队消息',
        state: 'queued',
        queueSequence: 2,
        acceptedAt: 20,
      },
      {
        inputId: 'first',
        clientMessageId: 'client-first',
        messageId: 'message-first',
        content: '第一条排队消息',
        state: 'queued',
        queueSequence: 1,
        acceptedAt: 30,
      },
    ]

    const history = pendingInputHistory(inputs, 'root')

    expect(history.map((item) => item.msgId)).toEqual(['message-first', 'message-later'])
    expect(history[0]).toMatchObject({
      pendingInputState: 'queued',
      pendingInputId: 'first',
      pendingClientMessageId: 'client-first',
      pendingInputQueueSequence: 1,
    })
  })

  it('places queued rows after the current response and deduplicates canonical ids', () => {
    const queuedItem = pendingInputHistory(
      [
        {
          inputId: 'queued',
          messageId: 'queued-message',
          content: '后续问题',
          state: 'queued',
          queueSequence: 1,
          acceptedAt: 10,
        },
      ],
      'root',
    )[0]!
    const currentResponse = {
      role: 'assistant',
      content: '当前响应',
      msgId: 'response',
      createdAt: 20,
    } as const

    expect(appendQueuedInputsAfterHistory([currentResponse], [queuedItem])).toEqual([
      currentResponse,
      queuedItem,
    ])
    expect(appendQueuedInputsAfterHistory([queuedItem], [queuedItem])).toEqual([queuedItem])
  })
})
