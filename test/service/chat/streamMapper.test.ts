import { describe, expect, it } from 'vitest'
import type { MiddlewareChunk } from '@/core/middleware/types.js'
import { streamAgentChunks } from '@/service/chat/streamMapper.js'

async function* idleGenerator(): AsyncGenerator<MiddlewareChunk, void, unknown> {
  return
}

async function* announcedTurnGenerator(): AsyncGenerator<MiddlewareChunk, void, unknown> {
  yield {
    type: 'stream',
    thinkingDelta: '',
    contentDelta: '',
    msgId: 'assistant-node-1',
    createdAt: 123,
  }
}

async function* twoCommittedTurnsGenerator(): AsyncGenerator<MiddlewareChunk, void, unknown> {
  for (const [id, createdAt] of [
    ['assistant-node-1', 123],
    ['assistant-node-2', 456],
  ] as const) {
    yield {
      type: 'stream',
      thinkingDelta: '',
      contentDelta: `${id} delta`,
      msgId: id,
      createdAt,
    }
    yield {
      type: 'message_created',
      message: { id, role: 'assistant', content: `${id} complete` },
    }
  }
}

describe('streamAgentChunks run lifecycle', () => {
  it('broadcasts active run state before the provider produces a first chunk', async () => {
    const stream = streamAgentChunks(idleGenerator(), 'request-1', 'chat-1', 'run-1')
    const first = await stream.next()

    expect(first.done).toBe(false)
    expect(first.value).toMatchObject({
      kind: 'notification',
      type: 'run.updated',
      chatId: 'chat-1',
      runId: 'run-1',
      data: { runId: 'run-1', status: 'running' },
    })
  })

  it('creates the response node before a provider token and suppresses an empty legacy chunk', async () => {
    const stream = streamAgentChunks(announcedTurnGenerator(), 'request-2', 'chat-2', 'run-2')
    await stream.next() // run.updated
    const turn = await stream.next()

    expect(turn.value).toMatchObject({
      kind: 'notification',
      type: 'turn.started',
      chatId: 'chat-2',
      data: {
        turnId: 'assistant-node-1',
        messageId: 'assistant-node-1',
        runId: 'run-2',
      },
    })
    expect((await stream.next()).done).toBe(true)
  })

  it('completes each committed assistant node independently within one run', async () => {
    const events = []
    for await (const event of streamAgentChunks(
      twoCommittedTurnsGenerator(),
      'request-3',
      'chat-3',
      'run-shared',
    )) {
      events.push(event)
    }

    expect(
      events
        .filter((event) => event.kind === 'notification')
        .map((event) => [event.type, event.data]),
    ).toEqual([
      ['run.updated', expect.objectContaining({ runId: 'run-shared', status: 'running' })],
      [
        'turn.started',
        expect.objectContaining({ turnId: 'assistant-node-1', messageId: 'assistant-node-1' }),
      ],
      [
        'turn.delta',
        expect.objectContaining({ turnId: 'assistant-node-1', delta: 'assistant-node-1 delta' }),
      ],
      [
        'turn.completed',
        expect.objectContaining({ turnId: 'assistant-node-1', messageId: 'assistant-node-1' }),
      ],
      [
        'turn.started',
        expect.objectContaining({ turnId: 'assistant-node-2', messageId: 'assistant-node-2' }),
      ],
      [
        'turn.delta',
        expect.objectContaining({ turnId: 'assistant-node-2', delta: 'assistant-node-2 delta' }),
      ],
      [
        'turn.completed',
        expect.objectContaining({ turnId: 'assistant-node-2', messageId: 'assistant-node-2' }),
      ],
    ])
  })
})
