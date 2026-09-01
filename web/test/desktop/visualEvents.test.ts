import { describe, expect, it } from 'vitest'
import { visualEventWindow } from '../../src/features/desktop/visualEvents'

describe('cyber workspace visual events', () => {
  it('reserves ERROR windows for genuine failures', () => {
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

    expect(failure.title).toContain('ERROR')
    expect(failure.context).toMatchObject({ kind: 'diagnostic', severity: 'error' })
    expect(failure.persistent).toBe(false)
    expect(business.title).not.toContain('ERROR')
    expect(business.context).toMatchObject({ kind: 'diagnostic', severity: 'diagnostic' })
  })

  it('deduplicates identical failure fingerprints', () => {
    const event = { type: 'failure', source: 'rpc', message: 'failed', code: 'X' } as const
    expect(visualEventWindow(event).resourceKey).toBe(visualEventWindow(event).resourceKey)
  })
})
