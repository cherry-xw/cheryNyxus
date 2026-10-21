import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GuardianLifecycle } from '@/service/guardianLifecycle.js'

function setup(cleanupManaged = vi.fn(async () => false)) {
  const child = Object.assign(new EventEmitter(), { pid: 700001, connected: true,
    send: vi.fn((_message, done) => done?.(null)) }) as unknown as ChildProcess
  const publish = vi.fn(), complete = vi.fn()
  const guardian = new GuardianLifecycle('instance', { publish, complete, cleanupManaged })
  guardian.attach(child, 'instance')
  return { child, publish, complete, guardian, cleanupManaged }
}

describe('GuardianLifecycle', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })
  it('does not turn a worker crash during waiting into a timed force stop', () => {
    vi.useFakeTimers()
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const { child, guardian, complete } = setup()
    guardian.receiveWorker(child, { type: 'backend-process', backendInstanceId: 'instance', kind: 'command', action: 'register', pid: 700002, commandId: 'command' })
    guardian.receive({ type: 'stop-drain', backendInstanceId: 'instance', operationId: 'stop' })
    guardian.exited(child, 1, null)
    vi.advanceTimersByTime(60_000)
    expect(guardian.snapshot()).toMatchObject({ phase: 'closing', forceDeadlineAt: null, desiredState: 'stopped' })
    expect(kill.mock.calls.some(([, signal]) => signal === 'SIGKILL')).toBe(false)
    expect(complete).not.toHaveBeenCalled()
    kill.mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) })
    vi.advanceTimersByTime(100)
    expect(complete).toHaveBeenCalledOnce()
  })
  it('holds cancellation acknowledgements until terminal managed-task evidence, without replay', async () => {
    vi.useFakeTimers()
    const cleanup = vi.fn(async () => false)
    const { child, guardian, complete } = setup(cleanup)
    guardian.receiveWorker(child, { type: 'backend-managed-task', backendInstanceId: 'instance', action: 'register',
      commandId: 'command', userId: '12345', appId: 'example', taskId: 'task_0123456789abcdef' })
    guardian.receive({ type: 'stop-drain', backendInstanceId: 'instance', operationId: 'stop' })
    guardian.exited(child, 1, null)
    await vi.advanceTimersByTimeAsync(1000)
    expect(complete).not.toHaveBeenCalled()
    cleanup.mockResolvedValue(true)
    await vi.advanceTimersByTimeAsync(300)
    expect(complete).toHaveBeenCalledOnce()
  })
  it('never extends an externally authorized force deadline', () => {
    vi.useFakeTimers()
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const { guardian } = setup()
    guardian.externalStop('stop')
    const deadline = guardian.snapshot().forceDeadlineAt
    vi.advanceTimersByTime(9000)
    guardian.externalStop('later')
    expect(guardian.snapshot().forceDeadlineAt).toBe(deadline)
    vi.advanceTimersByTime(1000)
    expect(kill).toHaveBeenCalledWith(-700001, 'SIGKILL')
    expect(guardian.snapshot().phase).not.toBe('stopped')
  })
})
