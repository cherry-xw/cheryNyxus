import { describe, expect, it } from 'vitest'
import {
  ChunkEnvelopeSchema,
  NotificationEnvelopeSchema,
  StagedReverseChunkDataSchema,
  TurnCancelledNotificationDataSchema,
} from '@chery/protocol'

describe('retry reset wire event schemas', () => {
  it('accepts a non-empty staged.reverse messageIds payload', () => {
    const data = { type: 'reverse', messageIds: ['message-1'] }
    expect(StagedReverseChunkDataSchema.safeParse(data).success).toBe(true)
    expect(
      ChunkEnvelopeSchema.safeParse({
        kind: 'chunk',
        type: 'staged',
        requestId: 'request-1',
        data,
      }).success,
    ).toBe(true)
  })

  it.each([
    { type: 'reverse' },
    { type: 'reverse', messageIds: [] },
    { type: 'reverse', messageIds: [''] },
  ])('rejects an invalid staged.reverse payload %#', (data) => {
    expect(StagedReverseChunkDataSchema.safeParse(data).success).toBe(false)
    expect(
      ChunkEnvelopeSchema.safeParse({
        kind: 'chunk',
        type: 'staged',
        requestId: 'request-1',
        data,
      }).success,
    ).toBe(false)
  })

  it('accepts turn.cancelled and validates it through the notification envelope', () => {
    const data = {
      turnId: 'turn-1',
      messageId: 'message-1',
      reason: 'retry_reset',
      cancelledAt: 123,
    }
    expect(TurnCancelledNotificationDataSchema.safeParse(data).success).toBe(true)
    expect(
      NotificationEnvelopeSchema.safeParse({
        kind: 'notification',
        type: 'turn.cancelled',
        data,
      }).success,
    ).toBe(true)
  })

  it.each([
    { messageId: 'message-1', reason: 'retry_reset' },
    { turnId: 'turn-1', reason: 'retry_reset' },
    { turnId: 'turn-1', messageId: 'message-1', reason: 'unknown' },
  ])('rejects an invalid turn.cancelled payload %#', (data) => {
    expect(TurnCancelledNotificationDataSchema.safeParse(data).success).toBe(false)
    expect(
      NotificationEnvelopeSchema.safeParse({
        kind: 'notification',
        type: 'turn.cancelled',
        data,
      }).success,
    ).toBe(false)
  })
})
