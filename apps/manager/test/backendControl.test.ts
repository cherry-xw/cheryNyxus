import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BackendStopSnapshot } from '@chery/protocol'
import { BackendControl } from '../src/backendControl.js'

function setup() {
  const emitter = new EventEmitter()
  const child = Object.assign(emitter, { connected: true, pid: 700001, exitCode: null, signalCode: null,
    send: vi.fn((_message: unknown, callback: (error: Error | null) => void) => callback(null)), kill: vi.fn() })
  let current: ChildProcess | undefined = child as unknown as ChildProcess
  const stopAdmission = vi.fn()
  const resumeAdmission = vi.fn()
  const control = new BackendControl({ child: () => current, stopAdmission, resumeAdmission, now: () => Date.now() })
  control.beginChild('instance')
  const observe = (patch: Partial<BackendStopSnapshot>, version: number) => control.observe({ type: 'stop-state',
    state: { ...control.snapshot()!, ...patch, version } })
  const exit = () => { current = undefined; control.exited(0, null); child.emit('exit', 0, null) }
  return { control, child, observe, exit, stopAdmission, resumeAdmission }
}

describe('BackendControl', () => {
  afterEach(() => vi.useRealTimers())
  it('retains unknown external outcomes from the final guardian snapshot but waits for local exit', async () => {
    vi.useFakeTimers()
    const { control, observe, exit } = setup()
    await control.requestStop()
    observe({ phase: 'stopped', unknownExternalOperations: [{ id: 'remote', description: '结果未确认' }] }, 1)
    expect(control.snapshot()?.phase).not.toBe('stopped')
    exit()
    expect(control.snapshot()).toMatchObject({ phase: 'stopped', unknownExternalOperations: [{ id: 'remote' }] })
  })

  it('keeps default waiting unbounded and only reports stopped after the process exits', async () => {
    vi.useFakeTimers()
    const { control, child, observe, exit } = setup()
    const stop = await control.requestStop()
    expect(stop?.phase).toBe('requesting')
    observe({ phase: 'draining', canCancel: true }, 1)
    vi.advanceTimersByTime(60 * 60 * 1000)
    expect(child.kill).not.toHaveBeenCalled()
    observe({ phase: 'stopped' }, 2)
    expect(control.snapshot()?.phase).not.toBe('stopped')
    exit()
    expect(control.snapshot()?.phase).toBe('stopped')
    expect((await control.readIntent()).desiredState).toBe('stopped')
  })

  it('does not hold the transition lock while cancellation awaits worker acknowledgement', async () => {
    vi.useFakeTimers()
    const { control, observe, exit } = setup()
    const state = (await control.requestStop())!
    observe({ phase: 'draining', canCancel: true }, 1)
    const cancel = control.cancel('instance', state.operationId!)
    const rejection = expect(cancel).rejects.toThrow('未获确认')
    await control.force('instance', state.operationId!)
    expect(control.snapshot()?.phase).toBe('force_stopping')
    vi.advanceTimersByTime(5000)
    await rejection
    exit()
  })

  it('restores running intent only after a matching cancellation confirmation', async () => {
    vi.useFakeTimers()
    const { control, child, observe, exit, resumeAdmission } = setup()
    const state = (await control.requestStop())!
    observe({ phase: 'draining', canCancel: true }, 1)
    const cancelled = control.cancel('instance', state.operationId!)
    // Wait until the cancel request reaches the fake child, not for an arbitrary timer.
    while (!child.send.mock.calls.some(([message]) => (message as { type?: string }).type === 'stop-cancel')) await Promise.resolve()
    expect((await control.readIntent()).desiredState).toBe('stopped')
    observe({ phase: 'running', desiredState: 'running', canCancel: false }, 2)
    expect((await cancelled).phase).toBe('running')
    expect((await control.readIntent()).desiredState).toBe('running')
    expect(resumeAdmission).toHaveBeenCalledOnce()
    exit()
  })
})
