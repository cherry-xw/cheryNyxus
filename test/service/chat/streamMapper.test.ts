import { afterEach, describe, expect, it } from 'vitest'
import type { MiddlewareChunk } from '@/core/middleware/types.js'
import { AgentAbortError, AgentParkError } from '@/core/middleware/errors.js'
import { createChat, deleteChat } from '@/db/chat.js'
import { streamAgentChunks } from '@/service/chat/streamMapper.js'

const cleanup: string[] = []
afterEach(() => {
  for (const id of cleanup.splice(0).reverse()) deleteChat(id)
})

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
  yield { type: 'done' }
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
  yield { type: 'done' }
}

function notifications(events: unknown[]): Array<[string, unknown]> {
  return events
    .filter((event) => (event as { kind?: string }).kind === 'notification')
    .map((event) => [(event as { type: string }).type, (event as { data?: unknown }).data])
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
      data: {
        runId: 'run-1',
        status: 'running',
        at: expect.any(Number),
        startedAt: expect.any(Number),
      },
    })
  })

  it('creates the response node before a provider token and suppresses an empty legacy chunk', async () => {
    const chatId = 'chat-2'
    cleanup.push(chatId)
    createChat(chatId)
    const events: unknown[] = []
    for await (const event of streamAgentChunks(
      announcedTurnGenerator(),
      'request-2',
      chatId,
      'run-2',
    )) {
      events.push(event)
    }

    const types = notifications(events)
    expect(types.map(([type]) => type)).toEqual([
      'run.updated', // running
      'turn.started',
      'done',
      'run.updated', // 空 chat 无末条 assistant → canResume false → completed
      'turn.completed',
    ])
    expect(types[1][1]).toMatchObject({ turnId: 'assistant-node-1', messageId: 'assistant-node-1' })
    expect(types[2][1]).toMatchObject({ canResume: false })
    // 空 stream delta 抑制 legacy chunk（chunk 通道无任何输出）
    expect(events.some((event) => (event as { kind?: string }).kind === 'chunk')).toBe(false)
  })

  it('completes each committed assistant node independently within one run', async () => {
    const chatId = 'chat-3'
    cleanup.push(chatId)
    createChat(chatId)
    const events = []
    for await (const event of streamAgentChunks(
      twoCommittedTurnsGenerator(),
      'request-3',
      chatId,
      'run-shared',
    )) {
      events.push(event)
    }

    expect(notifications(events)).toEqual([
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
      ['done', expect.objectContaining({ canResume: false })],
      ['run.updated', expect.objectContaining({ runId: 'run-shared', status: 'completed' })],
    ])
  })

  it('映射工具真实 started 与所有终态可选时间戳', async () => {
    const chatId = 'chat-timing'
    cleanup.push(chatId)
    createChat(chatId)
    async function* timed(): AsyncGenerator<MiddlewareChunk, void, unknown> {
      yield {
        type: 'sense_started',
        id: 'tool-timed',
        name: 'read_file',
        arguments: '{}',
        startedAt: 1234,
      }
      yield {
        type: 'sense_accept',
        id: 'tool-timed',
        name: 'read_file',
        result: 'ok',
      }
      yield {
        type: 'stream',
        thinkingDelta: '',
        contentDelta: '',
        msgId: 'turn-timed',
        createdAt: 2345,
      }
      yield { type: 'done' }
    }
    const events: unknown[] = []
    for await (const event of streamAgentChunks(timed(), 'request-timing', chatId, 'run-timing')) {
      events.push(event)
    }
    const typed = notifications(events)
    expect(typed.find(([type]) => type === 'sense_started')?.[1]).toMatchObject({
      id: 'tool-timed',
      startedAt: 1234,
    })
    expect(typed.find(([type]) => type === 'accept')?.[1]).toMatchObject({
      approvalId: 'tool-timed',
      completedAt: expect.any(Number),
    })
    expect(typed.find(([type]) => type === 'done')?.[1]).toMatchObject({
      completedAt: expect.any(Number),
    })
    expect(typed.find(([type]) => type === 'turn.completed')?.[1]).toMatchObject({
      completedAt: expect.any(Number),
    })
    const terminalRun = typed
      .filter(([type]) => type === 'run.updated')
      .at(-1)?.[1]
    expect(terminalRun).toMatchObject({ at: expect.any(Number) })
  })
})

describe('streamAgentChunks terminal fallback（统一暂停语义）', () => {
  /** 收集通知序列直至 generator 抛错中断；返回 [events, thrown]。 */
  async function collectUntilThrow(
    generator: AsyncGenerator<MiddlewareChunk, void, unknown>,
    chatId = 'c',
  ): Promise<[unknown[], Error | undefined]> {
    const events: unknown[] = []
    let thrown: Error | undefined
    try {
      for await (const event of streamAgentChunks(generator, 'r', chatId, 'run')) {
        events.push(event)
      }
    } catch (err) {
      thrown = err as Error
    }
    return [events, thrown]
  }

  it('generator throw AgentParkError → 补发 paused + turn.completed、无 error、rejects 原错误', async () => {
    async function* parked(): AsyncGenerator<MiddlewareChunk, void, unknown> {
      yield { type: 'stream', thinkingDelta: '', contentDelta: '', msgId: 'a1', createdAt: 1 }
      throw new AgentParkError('disconnected')
    }
    const [events, thrown] = await collectUntilThrow(parked())

    expect(thrown).toBeInstanceOf(AgentParkError)
    const types = notifications(events)
    expect(types.map(([type]) => type)).toEqual([
      'run.updated', // running 首发
      'turn.started',
      'run.updated', // catch 兜底 paused
      'turn.completed',
    ])
    expect(types[2][1]).toMatchObject({ runId: 'run', status: 'paused' })
    expect(types.some(([type]) => type === 'error')).toBe(false)
  })

  it('generator throw AgentAbortError → 同样归 paused 不弹 error（无 turn 则无 turn.completed）', async () => {
    async function* aborted(): AsyncGenerator<MiddlewareChunk, void, unknown> {
      throw new AgentAbortError('approval aborted')
    }
    const [events, thrown] = await collectUntilThrow(aborted())

    expect(thrown).toBeInstanceOf(AgentAbortError)
    const types = notifications(events)
    expect(types.map(([type]) => type)).toEqual(['run.updated', 'run.updated'])
    expect(types[1][1]).toMatchObject({ runId: 'run', status: 'paused' })
    expect(types.some(([type]) => type === 'error')).toBe(false)
  })

  it('generator throw 普通 Error → 补发 error（tracingId 前缀 + canResume）+ paused、rejects 原错误', async () => {
    const chatId = 'c-boom'
    cleanup.push(chatId)
    createChat(chatId)
    async function* boom(): AsyncGenerator<MiddlewareChunk, void, unknown> {
      throw new Error('boom')
    }
    const [events, thrown] = await collectUntilThrow(boom(), chatId)

    expect(thrown).toBeInstanceOf(Error)
    expect(thrown?.message).toBe('boom')
    const types = notifications(events)
    expect(types.map(([type]) => type)).toEqual(['run.updated', 'error', 'run.updated'])
    const errorNotif = types.find(([type]) => type === 'error')![1] as Record<string, unknown>
    expect(typeof errorNotif.message).toBe('string')
    expect(errorNotif.message).toMatch(/^\[[a-z0-9]{6,}\] /)
    expect(typeof errorNotif.canResume).toBe('boolean')
    expect(types[2][1]).toMatchObject({ runId: 'run', status: 'paused' })
  })

  it('generator 正常 return 且无 done/error → finally 兜底发 paused', async () => {
    async function* silentEnd(): AsyncGenerator<MiddlewareChunk, void, unknown> {
      yield { type: 'stream', thinkingDelta: '', contentDelta: '', msgId: 'a1', createdAt: 1 }
      return
    }
    const events: unknown[] = []
    for await (const event of streamAgentChunks(silentEnd(), 'r', 'c', 'run')) {
      events.push(event)
    }
    const types = notifications(events)
    expect(types.map(([type]) => type)).toEqual([
      'run.updated',
      'turn.started',
      'run.updated', // finally 兜底 paused
      'turn.completed',
    ])
    expect(types[2][1]).toMatchObject({ runId: 'run', status: 'paused' })
  })
})
