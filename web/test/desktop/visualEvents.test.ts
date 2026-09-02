import { describe, expect, it } from 'vitest'
import { visualEventWindow } from '../../src/features/desktop/visualEvents'

describe('cyber workspace visual events', () => {
  it('reserves error windows for genuine failures', () => {
    const failure = visualEventWindow({
      type: 'failure',
      source: 'rpc',
      message: 'request failed',
      code: 'RPC_FAILED',
    })
    const business = visualEventWindow({
      type: 'business',
      event: 'workspace.boot',
      message: 'online',
    })

    // 2026-09-02 中文化返工：失败窗口标题「错误 // <协议码>」（协议码保留英文）。
    expect(failure.title).toContain('错误')
    expect(failure.title).toContain('RPC_FAILED')
    expect(failure.context).toMatchObject({ kind: 'diagnostic', severity: 'error' })
    expect(failure.persistent).toBe(false)
    expect(business.title).not.toContain('错误')
    expect(business.context).toMatchObject({ kind: 'diagnostic', severity: 'diagnostic' })
  })

  it('deduplicates identical failure fingerprints', () => {
    const event = { type: 'failure', source: 'rpc', message: 'failed', code: 'X' } as const
    expect(visualEventWindow(event).resourceKey).toBe(visualEventWindow(event).resourceKey)
  })
})
