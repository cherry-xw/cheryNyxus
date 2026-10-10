import { describe, expect, it } from 'vitest'
import {
  ChunkEnvelopeSchema,
  NotificationEnvelopeSchema,
  StagedReverseChunkDataSchema,
  TurnCancelledNotificationDataSchema,
  RunOutcomeNotificationDataSchema,
  UserFeedbackSchema,
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

describe('run outcome and user feedback wire schemas', () => {
  const feedback = {
    code: 'RUN_LOOP_LIMIT_REACHED',
    severity: 'warning',
    source: 'system',
    title: '已达到循环上限',
    description: '本轮已执行 30 次，系统已安全暂停。',
    guidance: '检查最后几步后继续，或调整循环限制。',
    actions: [
      { type: 'resume_run' },
      { type: 'open_settings', section: 'limits' },
      { type: 'view_details' },
    ],
    retention: 'history',
    detail: 'iterations=30; maxLoop=30',
  } as const

  it('accepts a protective pause and validates it through the notification envelope', () => {
    const data = {
      status: 'paused',
      reasonCode: 'RUN_LOOP_LIMIT_REACHED',
      canResume: true,
      retryable: false,
      occurredAt: 123,
      feedback,
    }
    expect(UserFeedbackSchema.safeParse(feedback).success).toBe(true)
    expect(RunOutcomeNotificationDataSchema.safeParse(data).success).toBe(true)
    expect(
      NotificationEnvelopeSchema.safeParse({
        kind: 'notification',
        type: 'run.outcome',
        chatId: 'chat-1',
        runId: 'run-1',
        data,
      }).success,
    ).toBe(true)
  })

  it('requires feedback for every non-completed result', () => {
    expect(
      RunOutcomeNotificationDataSchema.safeParse({
        status: 'paused',
        reasonCode: 'RUN_PAUSED',
        canResume: true,
        retryable: false,
        occurredAt: 123,
      }).success,
    ).toBe(false)
  })

  it('rejects unknown semantic actions and invalid settings targets', () => {
    expect(UserFeedbackSchema.safeParse({ ...feedback, actions: [] }).success).toBe(false)
    expect(
      UserFeedbackSchema.safeParse({ ...feedback, actions: [{ type: 'execute_script' }] }).success,
    ).toBe(false)
    expect(
      UserFeedbackSchema.safeParse({ ...feedback, actions: [{ type: 'update_app' }] }).success,
    ).toBe(false)
    expect(
      UserFeedbackSchema.safeParse({
        ...feedback,
        actions: [{ type: 'open_settings', section: 'unknown' }],
      }).success,
    ).toBe(false)
  })
})
