import { describe, expect, it } from 'vitest'
import { Method } from '@chery/protocol'
import { logger } from '@/utils/logger/index.js'
import { createRouter, type HandlerContext } from '@/service/message/router.js'
import type { Notification, Request, Response } from '@/service/message/types.js'

const context: HandlerContext = { connectionId: 'protocol-test', log: logger }

function request(method: string, params: unknown, id = 'request-1'): Request {
  return { id, kind: 'request', method, params } as Request
}

async function settle(
  value: Response | AsyncGenerator<unknown, Response, unknown>,
): Promise<{ events: unknown[]; response: Response }> {
  if (!(Symbol.asyncIterator in Object(value))) return { events: [], response: value as Response }
  const events: unknown[] = []
  const generator = value as AsyncGenerator<unknown, Response, unknown>
  while (true) {
    const next = await generator.next()
    if (next.done) return { events, response: next.value }
    events.push(next.value)
  }
}

describe('RpcRouter protocol boundary', () => {
  it('rejects duplicate registration immediately', () => {
    const router = createRouter()
    router.register(Method.BRAIN_LIST, async () => ({ brains: [] }))
    expect(() => router.register(Method.BRAIN_LIST, async () => ({ brains: [] }))).toThrow(
      'Duplicate RPC handler registration',
    )
  })

  it('maps an invalid request to a structured INVALID_PARAMS response', async () => {
    const router = createRouter()
    router.register(Method.CHAT_DELETE, async (_ctx, data) => ({ chatId: data.chatId }))

    const result = await router.handle(request(Method.CHAT_DELETE, {}), context)
    const { response } = await settle(result)

    expect(response).toMatchObject({ success: false, error: { code: 'INVALID_PARAMS' } })
    expect(response.error).toMatchObject({
      source: 'system',
      retryable: false,
      tracingId: expect.any(String),
    })
  })

  it('turns an invalid successful handler result into INTERNAL', async () => {
    const router = createRouter()
    router.register(Method.CHAT_CREATE, async () => ({}) as never)

    const result = await router.handle(request(Method.CHAT_CREATE, { brain: 'mock' }), context)
    const { response } = await settle(result)

    expect(response).toMatchObject({ success: false, error: { code: 'INTERNAL' } })
    expect(response.error?.tracingId).toEqual(expect.any(String))
  })

  it('does not expose an unclassified handler exception to the client', async () => {
    const router = createRouter()
    router.register(Method.BRAIN_LIST, async () => {
      throw new Error('database password=secret-value')
    })

    const result = await router.handle(request(Method.BRAIN_LIST, {}), context)
    const { response } = await settle(result)

    expect(response.error).toMatchObject({
      code: 'INTERNAL',
      message: expect.stringMatching(/^\[[0-9a-f]{8}\] 系统出了点小问题$/),
      feedback: {
        severity: 'error',
        title: '操作没有完成',
      },
    })
    expect(response.error?.message).not.toContain('secret-value')
  })

  it('rejects a legacy unstructured error notification at the event boundary', async () => {
    const router = createRouter()
    router.register(Method.BRAIN_LIST, async function* () {
      yield {
        kind: 'notification',
        type: 'error',
        data: { message: 'legacy failure', canResume: false },
      } as Notification
      return { brains: [], mcpServers: [] }
    })

    const result = await router.handle(request(Method.BRAIN_LIST, {}), context)
    const settled = await settle(result)

    expect(settled.events).toEqual([])
    expect(settled.response).toMatchObject({ success: false, error: { code: 'INTERNAL' } })
  })

  it('passes one valid asynchronous error notification without a synchronous error', async () => {
    const router = createRouter()
    router.register(Method.BRAIN_LIST, async function* () {
      yield {
        kind: 'notification',
        type: 'error',
        chatId: 'chat-1',
        runId: 'run-1',
        data: {
          code: 'TIMEOUT',
          message: 'provider timed out',
          source: 'brain',
          retryable: true,
          tracingId: 'trace-1',
          canResume: true,
        },
      } as Notification
      return { brains: [], mcpServers: [] }
    })

    const result = await router.handle(request(Method.BRAIN_LIST, {}), context)
    const settled = await settle(result)

    expect(settled.events).toHaveLength(1)
    expect(settled.events[0]).toMatchObject({
      kind: 'notification',
      type: 'error',
      requestId: 'request-1',
      data: { code: 'TIMEOUT', canResume: true },
    })
    expect(settled.response).toMatchObject({ success: true, error: undefined })
  })
})
