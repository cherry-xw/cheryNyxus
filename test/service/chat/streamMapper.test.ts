import { afterEach, describe, expect, it } from 'vitest'
import { NotificationEnvelopeSchema } from '@chery/protocol'
import type { MiddlewareChunk } from '@/core/middleware/types.js'
import { AgentAbortError, AgentParkError } from '@/core/middleware/errors.js'
import { createChat, deleteChat } from '@/db/chat.js'
import { listExecutionNodes } from '@/db/executionGraph.js'
import { streamAgentChunks } from '@/service/chat/streamMapper.js'
import { getLiveTurns } from '@/service/chat/liveTurns.js'

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

async function* retriedTurnGenerator(): AsyncGenerator<MiddlewareChunk, void, unknown> {
  yield {
    type: 'stream',
    thinkingDelta: '',
    contentDelta: 'discard-me',
    msgId: 'failed-turn',
    createdAt: 123,
  }
  yield { type: 'retry_reset', messageId: 'failed-turn' }
  yield {
    type: 'stream',
    thinkingDelta: '',
    contentDelta: 'clean-result',
    msgId: 'clean-turn',
    createdAt: 456,
  }
  yield {
    type: 'staged',
    stagedType: 'content_end',
    thinking: '',
    content: 'clean-result',
    role: 'assistant',
    msgId: 'clean-turn',
    createdAt: 456,
  }
  yield { type: 'done' }
}

function notifications(events: unknown[]): Array<[string, unknown]> {
  return events
    .filter((event) => (event as { kind?: string }).kind === 'notification')
    .map((event) => [(event as { type: string }).type, (event as { data?: unknown }).data])
}

describe('streamAgentChunks run lifecycle', () => {
  it('maps loop limit to a warning pause before the legacy compatibility error', async () => {
    const chatId = 'chat-loop-limit'
    cleanup.push(chatId)
    createChat(chatId)
    async function* limited(): AsyncGenerator<MiddlewareChunk, void, unknown> {
      yield { type: 'run_paused', reason: 'loop_limit', iterations: 30, limit: 30 }
      // Defensive duplicate terminal signal: the mapper must keep the first,
      // more specific limit outcome authoritative and suppress this tail event.
      yield { type: 'done' }
    }
    const events: unknown[] = []
    for await (const event of streamAgentChunks(limited(), 'request-limit', chatId, 'run-limit')) {
      events.push(event)
    }
    const typed = notifications(events)
    expect(typed.map(([type]) => type)).toEqual([
      'run.updated',
      'run.outcome',
      'error',
      'timeline.patch',
      'run.updated',
    ])
    expect(typed[1]?.[1]).toMatchObject({
      status: 'paused',
      reasonCode: 'RUN_LOOP_LIMIT_REACHED',
      canResume: true,
      retryable: false,
      feedback: {
        severity: 'warning',
        title: '已达到循环上限',
        retention: 'history',
      },
    })
    const termination = listExecutionNodes(chatId).find(
      (node) => node.id === 'termination:run-limit:limit_reached',
    )
    expect(termination).toMatchObject({
      content: expect.stringContaining('已达到循环上限'),
      termination: { detail: 'iterations=30; maxLoop=30' },
    })
    expect(typed.at(-1)?.[1]).toMatchObject({ status: 'paused' })
    expect(typed.filter(([type]) => type === 'run.outcome')).toHaveLength(1)
    expect(typed.some(([type]) => type === 'done')).toBe(false)
  })

  it('normalizes long multiline error details before emitting terminal notifications', async () => {
    const chatId = 'chat-long-error-detail'
    cleanup.push(chatId)
    createChat(chatId)
    async function* failed(): AsyncGenerator<MiddlewareChunk, void, unknown> {
      yield {
        type: 'error',
        errors: [
          {
            attempt: 1,
            timestamp: Date.now(),
            message: 'upstream request failed',
            userMessage: 'AI 服务拒绝了这个请求',
            detail: `upstream 400:\n${'x'.repeat(240)}`,
            source: 'brain',
            recoverable: false,
            category: 'validation',
          },
        ],
      }
    }

    const events: unknown[] = []
    for await (const event of streamAgentChunks(
      failed(),
      'request-long-detail',
      chatId,
      'run-long-detail',
    )) {
      events.push(event)
    }

    const terminalEvents = events.filter((event) => {
      const type = (event as { type?: string }).type
      return type === 'run.outcome' || type === 'error'
    }) as Array<{ type: string; data: Record<string, unknown> }>
    expect(terminalEvents).toHaveLength(2)
    expect(
      terminalEvents.every((event) => NotificationEnvelopeSchema.safeParse(event).success),
    ).toBe(true)

    const error = terminalEvents.find((event) => event.type === 'error')!
    const outcome = terminalEvents.find((event) => event.type === 'run.outcome')!
    const detail = error.data.detail as string
    expect(detail).toHaveLength(200)
    expect(detail).not.toContain('\n')
    expect(detail).toMatch(/…$/)
    expect((outcome.data.feedback as { detail?: string }).detail).toBe(detail)
    expect(outcome.data.feedback).toMatchObject({
      guidance: '请在设置中修正模型地址、模型或密钥配置后，再继续运行。',
      actions: [{ type: 'open_settings', section: 'provider' }, { type: 'view_details' }],
    })
    const termination = listExecutionNodes(chatId).find(
      (node) => node.id === 'termination:run-long-detail:error',
    )
    expect(termination).toMatchObject({
      content: expect.stringContaining('AI 服务拒绝了这个请求'),
      termination: { detail: 'upstream request failed' },
    })
  })

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
      'run.outcome',
      'done',
      'run.updated', // 空 chat 无末条 assistant → canResume false → completed
      'turn.completed',
    ])
    expect(types[1][1]).toMatchObject({ turnId: 'assistant-node-1', messageId: 'assistant-node-1' })
    expect(types[2][1]).toMatchObject({ status: 'completed', canResume: false })
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
      ['run.outcome', expect.objectContaining({ status: 'completed', canResume: false })],
      ['done', expect.objectContaining({ canResume: false })],
      ['run.updated', expect.objectContaining({ runId: 'run-shared', status: 'completed' })],
    ])
  })

  it('keeps the current accumulated text in memory only until the turn is sealed', async () => {
    const chatId = 'chat-live-buffer'
    cleanup.push(chatId)
    createChat(chatId)
    async function* live(): AsyncGenerator<MiddlewareChunk, void, unknown> {
      yield {
        type: 'stream',
        thinkingDelta: 'thought',
        contentDelta: 'answer',
        msgId: 'live-turn',
        createdAt: 321,
      }
      yield {
        type: 'message_created',
        message: { id: 'live-turn', role: 'assistant', content: 'answer', thinking: 'thought' },
      }
      yield { type: 'done' }
    }

    const stream = streamAgentChunks(live(), 'request-live', chatId, 'run-live')
    let sawContentDelta = false
    while (!sawContentDelta) {
      const next = await stream.next()
      expect(next.done).toBe(false)
      const event = next.value as { type?: string; data?: { channel?: string } }
      sawContentDelta = event.type === 'turn.delta' && event.data?.channel === 'content'
    }
    expect(getLiveTurns(chatId)).toEqual([
      expect.objectContaining({
        turnId: 'live-turn',
        thinking: 'thought',
        content: 'answer',
        nextThinkingOffset: 7,
        nextContentOffset: 6,
      }),
    ])

    while (!(await stream.next()).done) {
      // drain terminal events so message_created can seal and clear the live buffer
    }
    expect(getLiveTurns(chatId)).toEqual([])
  })

  it('maps retry_reset to staged.reverse and restarts turn offsets from zero', async () => {
    const chatId = 'chat-retry-reset'
    cleanup.push(chatId)
    createChat(chatId)
    const events: unknown[] = []
    for await (const event of streamAgentChunks(
      retriedTurnGenerator(),
      'request-retry',
      chatId,
      'run-retry',
    )) {
      events.push(event)
    }

    const reverse = events.find(
      (event) =>
        (event as { kind?: string }).kind === 'chunk' &&
        (event as { type?: string }).type === 'staged' &&
        (event as { data?: { type?: string } }).data?.type === 'reverse',
    ) as { data?: unknown } | undefined
    expect(reverse?.data).toEqual({ type: 'reverse', messageIds: ['failed-turn'] })

    const typed = notifications(events)
    expect(typed.find(([type]) => type === 'turn.cancelled')?.[1]).toMatchObject({
      turnId: 'failed-turn',
      messageId: 'failed-turn',
      reason: 'retry_reset',
      cancelledAt: expect.any(Number),
    })
    const retryLifecycle = events
      .map((event) => {
        const envelope = event as {
          kind?: string
          type?: string
          data?: { type?: string; turnId?: string }
        }
        if (envelope.type === 'turn.started') return `started:${envelope.data?.turnId}`
        if (envelope.type === 'turn.cancelled') return `cancelled:${envelope.data?.turnId}`
        if (envelope.type === 'staged' && envelope.data?.type === 'reverse') return 'reverse'
        return undefined
      })
      .filter(Boolean)
    expect(retryLifecycle).toEqual([
      'started:failed-turn',
      'cancelled:failed-turn',
      'reverse',
      'started:clean-turn',
    ])
    expect(typed.filter(([type]) => type === 'turn.started').map(([, data]) => data)).toEqual([
      expect.objectContaining({ turnId: 'failed-turn' }),
      expect.objectContaining({ turnId: 'clean-turn' }),
    ])
    expect(typed.filter(([type]) => type === 'turn.delta').map(([, data]) => data)).toEqual([
      expect.objectContaining({ turnId: 'failed-turn', offset: 0, delta: 'discard-me' }),
      expect.objectContaining({ turnId: 'clean-turn', offset: 0, delta: 'clean-result' }),
    ])
    expect(typed.filter(([type]) => type === 'turn.completed').map(([, data]) => data)).toEqual([
      expect.objectContaining({ turnId: 'clean-turn' }),
    ])
  })

  it('映射工具真实 started 与所有终态可选时间戳', async () => {
    const chatId = 'chat-timing'
    cleanup.push(chatId)
    createChat(chatId)
    async function* timed(): AsyncGenerator<MiddlewareChunk, void, unknown> {
      yield {
        type: 'stream',
        thinkingDelta: '',
        contentDelta: '',
        msgId: 'turn-before-tool',
        createdAt: 1200,
      }
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
    const handoff = typed
      .map(([type, data]) => [type, data as Record<string, unknown>] as const)
      .filter(([type]) => type === 'turn.completed' || type === 'sense_started')
    expect(handoff).toEqual([
      ['turn.completed', expect.objectContaining({ turnId: 'turn-before-tool', completedAt: 1234 })],
      ['sense_started', expect.objectContaining({ id: 'tool-timed', startedAt: 1234 })],
      ['turn.completed', expect.objectContaining({ turnId: 'turn-timed' })],
    ])
    expect(typed.find(([type]) => type === 'sense_started')?.[1]).toMatchObject({
      id: 'tool-timed',
      startedAt: 1234,
    })
    expect(typed.find(([type]) => type === 'accept')?.[1]).toMatchObject({
      approvalId: 'tool-timed',
      completedAt: expect.any(Number),
    })
    const done = typed.find(([type]) => type === 'done')?.[1] as
      { completedAt?: number; serverNow?: number } | undefined
    expect(done).toMatchObject({
      completedAt: expect.any(Number),
      serverNow: expect.any(Number),
    })
    expect(done?.serverNow).toBe(done?.completedAt)
    expect(typed.find(([type]) => type === 'turn.completed')?.[1]).toMatchObject({
      completedAt: expect.any(Number),
    })
    const terminalRun = typed.filter(([type]) => type === 'run.updated').at(-1)?.[1]
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
      'run.outcome',
      'run.updated', // catch 兜底 paused
      'turn.completed',
    ])
    expect(types[2][1]).toMatchObject({ status: 'paused', reasonCode: 'RUN_PAUSED' })
    expect(types[3][1]).toMatchObject({ runId: 'run', status: 'paused' })
    expect(types.some(([type]) => type === 'error')).toBe(false)
  })

  it('generator throw AgentAbortError → 同样归 paused 不弹 error（无 turn 则无 turn.completed）', async () => {
    async function* aborted(): AsyncGenerator<MiddlewareChunk, void, unknown> {
      throw new AgentAbortError('approval aborted')
    }
    const [events, thrown] = await collectUntilThrow(aborted())

    expect(thrown).toBeInstanceOf(AgentAbortError)
    const types = notifications(events)
    expect(types.map(([type]) => type)).toEqual(['run.updated', 'run.outcome', 'run.updated'])
    expect(types[1][1]).toMatchObject({ status: 'cancelled', reasonCode: 'RUN_USER_CANCELLED' })
    expect(types[2][1]).toMatchObject({ runId: 'run', status: 'paused' })
    expect(types.some(([type]) => type === 'error')).toBe(false)
  })

  it('generator throw 普通 Error → 补发 failed outcome + error（tracingId 前缀 + canResume）、rejects 原错误', async () => {
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
    expect(types.map(([type]) => type)).toEqual([
      'run.updated',
      'run.outcome',
      'error',
      'run.updated',
    ])
    const errorNotif = types.find(([type]) => type === 'error')![1] as Record<string, unknown>
    expect(typeof errorNotif.message).toBe('string')
    expect(errorNotif.message).toMatch(/^\[[a-z0-9]{6,}\] /)
    expect(typeof errorNotif.canResume).toBe('boolean')
    expect(types[1][1]).toMatchObject({ status: 'failed', reasonCode: 'RUN_UNKNOWN_FAILED' })
    expect(types[3][1]).toMatchObject({ runId: 'run', status: 'failed' })
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
      'run.outcome',
      'run.updated', // finally 兜底 paused
      'turn.completed',
    ])
    expect(types[2][1]).toMatchObject({ status: 'paused', reasonCode: 'RUN_SYSTEM_CANCELLED' })
    expect(types[3][1]).toMatchObject({ runId: 'run', status: 'paused' })
  })
})
