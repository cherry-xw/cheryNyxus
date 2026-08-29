import { describe, expect, it } from 'vitest'
import { legacyErrorOutcome, parseRunOutcome } from '@/domain/chat/runOutcome'

describe('run outcome normalization', () => {
  it('preserves a protocol-defined loop-limit pause', () => {
    const outcome = parseRunOutcome({
      status: 'paused',
      reasonCode: 'RUN_LOOP_LIMIT_REACHED',
      canResume: true,
      retryable: false,
      occurredAt: 123,
      feedback: {
        code: 'RUN_LOOP_LIMIT_REACHED',
        severity: 'warning',
        source: 'system',
        title: '已达到循环上限',
        description: '系统已安全暂停。',
        actions: [{ type: 'resume_run' }],
        retention: 'history',
      },
    })

    expect(outcome).toMatchObject({
      status: 'paused',
      canResume: true,
      feedback: { severity: 'warning', title: '已达到循环上限' },
    })
  })

  it('normalizes a legacy error without confusing retryable and canResume', () => {
    const outcome = legacyErrorOutcome(
      {
        code: 'RUN_VALIDATION_FAILED',
        message: '[abc12345] 请求内容不完整',
        source: 'brain',
        retryable: false,
        canResume: true,
        tracingId: 'abc12345',
        detail: `upstream\n${'x'.repeat(240)}`,
      },
      'fallback',
      456,
    )

    expect(outcome).toMatchObject({
      status: 'failed',
      retryable: false,
      canResume: true,
      feedback: {
        source: 'brain',
        description: '请求内容不完整',
        actions: [{ type: 'resume_run' }, { type: 'view_details' }],
      },
    })
    expect(outcome.feedback?.detail).toHaveLength(200)
    expect(outcome.feedback?.detail).not.toContain('\n')
    expect(outcome.feedback?.detail).toMatch(/…$/)
  })

  it('falls back to a safe source and a concrete next action', () => {
    const outcome = legacyErrorOutcome(
      {
        code: 'RUN_UNKNOWN_FAILED',
        message: '[abc12345] ',
        source: 'not-a-source',
        retryable: false,
        canResume: false,
      },
      'fallback',
      789,
    )

    expect(outcome.feedback).toMatchObject({
      source: 'system',
      description: '本轮运行意外中断',
      actions: [{ type: 'resend_input' }],
    })
  })
})
