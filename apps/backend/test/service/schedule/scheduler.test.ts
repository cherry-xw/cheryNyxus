import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  jobs: [] as Array<{ callback: () => Promise<void>; stopped: boolean; resumed: boolean }>,
  run: vi.fn<() => Promise<void>>(),
}))

vi.mock('croner', () => ({
  Cron: class {
    stopped = false
    resumed = false
    callback: () => Promise<void>
    constructor(pattern: string, _options: unknown, callback: () => Promise<void>) {
      if (pattern === 'bad') throw new Error('invalid cron')
      this.callback = callback
      state.jobs.push(this)
    }
    stop(): void {
      this.stopped = true
    }
    resume(): void {
      this.resumed = true
    }
  },
}))
vi.mock('@/agent/runtimeResolver.js', () => ({
  resolvePresetSelection: () => ({
    presetId: 'preset-id',
    selection: { brain: 'main', senseGroup: 'default', mcpServers: [] },
    leaderName: 'leader',
    leaderId: 'leader-id',
    spawnTypes: [],
  }),
}))
vi.mock('@/service/schedule/maintenanceChat.js', () => ({
  runMaintenanceChat: () => state.run(),
}))

import { preparePresetSchedule, stopScheduleService } from '@/service/schedule/scheduler.js'
import {
  cancelPendingRestart,
  configureRestartCoordinator,
  requestRestartWhenIdle,
} from '@/service/restartCoordinator.js'

describe('schedule hot apply', () => {
  it('does not create cron work during restart drain', async () => {
    configureRestartCoordinator({ isIdle: () => false, onRestartReady: () => {} })
    requestRestartWhenIdle()
    try {
      preparePresetSchedule('daily', { cron: '* * * * *', task: 'skip' }).apply()
      await state.jobs[0]!.callback()
      expect(state.run).not.toHaveBeenCalled()
    } finally {
      cancelPendingRestart()
    }
  })
  beforeEach(() => {
    stopScheduleService()
    state.jobs.length = 0
    state.run.mockReset()
  })

  it('validates before publish and swaps the old job atomically', () => {
    const first = preparePresetSchedule('daily', { cron: '* * * * *', task: 'old' })
    expect(state.jobs[0]!.resumed).toBe(false)
    first.apply()
    expect(state.jobs[0]!.resumed).toBe(true)

    expect(() => preparePresetSchedule('daily', { cron: 'bad', task: 'bad' })).toThrow()
    expect(state.jobs[0]!.stopped).toBe(false)

    const second = preparePresetSchedule('daily', { cron: '0 * * * *', task: 'new' })
    second.apply()
    expect(state.jobs[0]!.stopped).toBe(true)
    expect(state.jobs[1]!.resumed).toBe(true)
  })

  it('keeps an in-flight task and suppresses a duplicate trigger after replacement', async () => {
    let finish!: () => void
    state.run.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)))
    const first = preparePresetSchedule('daily', { cron: '* * * * *', task: 'old' })
    first.apply()
    const running = state.jobs[0]!.callback()

    const second = preparePresetSchedule('daily', { cron: '0 * * * *', task: 'new' })
    second.apply()
    await state.jobs[1]!.callback()
    expect(state.run).toHaveBeenCalledTimes(1)

    finish()
    await running
    state.run.mockResolvedValueOnce()
    await state.jobs[1]!.callback()
    expect(state.run).toHaveBeenCalledTimes(2)
  })

  it('disabling or deleting a schedule stops the active job', () => {
    preparePresetSchedule('daily', { cron: '* * * * *', task: 'old' }).apply()
    preparePresetSchedule('daily', undefined).apply()
    expect(state.jobs[0]!.stopped).toBe(true)
  })
})
