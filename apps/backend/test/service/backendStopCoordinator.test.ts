import { afterEach, describe, expect, it, vi } from 'vitest'
import { BackendStopCoordinator } from '@/service/backendStopCoordinator.js'

function setup(idle = false) {
  const options = { backendInstanceId: 'one', parkInputs: vi.fn(() => 2), restoreInputs: vi.fn(),
    blockers: vi.fn(() => idle ? [] : [{ id: 'run', kind: 'agent' as const, description: 'running' }]),
    close: vi.fn(), force: vi.fn(), now: () => 1000 }
  return { options, stop: new BackendStopCoordinator(options) }
}

describe('BackendStopCoordinator', () => {
  afterEach(() => vi.useRealTimers())

  it('closes admission before parking; waits indefinitely and retains existing-work admission', () => {
    vi.useFakeTimers()
    const { stop, options } = setup()
    options.parkInputs.mockImplementation(() => {
      expect(stop.canConsumeInput()).toBe(false)
      expect(() => stop.assertAdmission()).toThrow('关闭')
      expect(() => stop.assertAdmission(true)).not.toThrow()
      return 2
    })
    stop.request('stop-1')
    vi.advanceTimersByTime(60 * 60 * 1000)
    expect(options.close).not.toHaveBeenCalled()
    expect(options.force).not.toHaveBeenCalled()
    expect(stop.snapshot()).toMatchObject({ phase: 'draining', canCancel: true, forceDeadlineAt: null, parkedInputCount: 2 })
    stop.dispose()
  })

  it('cancels only the current reversible operation, and does not restart a cancelled request on retry', () => {
    const { stop, options } = setup()
    stop.request('stop-1')
    expect(() => stop.cancel('stale')).toThrow('变化')
    expect(stop.cancel('stop-1')).toMatchObject({ phase: 'running', desiredState: 'running' })
    expect(options.restoreInputs).toHaveBeenCalledWith('stop-1')
    expect(stop.request('stop-1').phase).toBe('running')
    stop.request('stop-2')
    expect(() => stop.cancel('stop-1')).toThrow('变化')
    stop.dispose()
  })

  it('natural completion and force are irreversible, and repeated force cannot extend the deadline', () => {
    const first = setup(true)
    expect(first.stop.request('close').phase).toBe('closing')
    expect(first.options.close).toHaveBeenCalledOnce()
    expect(() => first.stop.cancel('close')).toThrow('不能取消')
    first.stop.dispose()
    const { stop, options } = setup()
    stop.request('force')
    expect(stop.force('force', 9000)).toMatchObject({ phase: 'force_stopping', forceDeadlineAt: 9000 })
    stop.force('force', 20_000)
    expect(stop.snapshot().forceDeadlineAt).toBe(9000)
    expect(options.force).toHaveBeenCalledOnce()
    expect(() => stop.assertAdmission(true)).toThrow('关闭')
    expect(() => stop.cancel('force')).toThrow('不能取消')
    stop.dispose()
  })

  it('does not close or resume on control loss or partial parking failure', () => {
    const { stop, options } = setup()
    stop.setConnection(false)
    stop.request('wait')
    options.blockers.mockReturnValue([])
    stop.refresh()
    expect(stop.snapshot()).toMatchObject({ phase: 'draining', connection: 'lost', desiredState: 'stopped' })
    expect(() => stop.cancel('wait')).toThrow()
    expect(options.close).not.toHaveBeenCalled()
    stop.setConnection(true)
    expect(options.close).toHaveBeenCalledOnce()
    stop.dispose()
    const second = setup()
    second.options.parkInputs.mockImplementation(() => { throw new Error('db unavailable') })
    expect(second.stop.request('failed')).toMatchObject({ phase: 'draining', error: 'db unavailable' })
    expect(second.stop.canConsumeInput()).toBe(false)
    expect(second.options.close).not.toHaveBeenCalled()
    second.stop.dispose()
  })
})
