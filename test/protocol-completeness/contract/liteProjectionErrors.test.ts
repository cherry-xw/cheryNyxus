import { describe, expect, it } from 'vitest'
import { ProtocolErrorSchema } from '@chery/protocol'
import { applyLiteResponse, type LiteProfile } from '@/service/websocket/liteProjection'

describe('lite structured error projection', () => {
  it('keeps ProtocolError fields while fitting a node-detail error into the frame budget', () => {
    const profile: LiteProfile = { kind: 'lite', v: 1, maxFrameBytes: 512, turnDelta: false }
    const error = {
      code: 'RATE_LIMITED',
      message: 'provider quota exceeded',
      source: 'brain' as const,
      retryable: true,
      tracingId: 'trace-structured-error',
      retryAfterMs: 2500,
    }
    const projected = applyLiteResponse(
      profile,
      {
        id: 'response-1',
        kind: 'response',
        requestId: 'request-1',
        success: false,
        error: { ...error, message: error.message.repeat(200) },
      },
      undefined,
      'chat.timeline.node.get',
    ) as { error: unknown }

    expect(ProtocolErrorSchema.parse(projected.error)).toMatchObject({
      code: error.code,
      source: error.source,
      retryable: error.retryable,
      tracingId: error.tracingId,
      retryAfterMs: error.retryAfterMs,
    })
    expect(Buffer.byteLength(JSON.stringify(projected), 'utf8')).toBeLessThanOrEqual(512)
  })

  it('synthesizes a valid complete ProtocolError for legacy node-detail failures', () => {
    const profile: LiteProfile = { kind: 'lite', v: 1, maxFrameBytes: 512, turnDelta: false }
    const projected = applyLiteResponse(
      profile,
      {
        id: 'response-2',
        kind: 'response',
        requestId: 'request-2',
        success: false,
        error: { code: 'INTERNAL', message: 'legacy'.repeat(1000) },
      },
      undefined,
      'chat.timeline.node.get',
    ) as { error: unknown }

    expect(ProtocolErrorSchema.safeParse(projected.error).success).toBe(true)
  })
})
