/**
 * 受控重启协调器 单测：validateBeforeRestart 预检失败 → 不通知重启 + 待重启状态复位。
 * 见 docs/agent/config-manage.md「重启前预检（dry-run）」。
 *
 * restartCoordinator 的待重启状态（restartRequested/restartNotified）为模块私有且跨测试残留，
 * 故每用例 vi.resetModules 重建模块实例隔离。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type RestartCoordinatorMod = typeof import('@/service/restartCoordinator.js')
let mod: RestartCoordinatorMod

/** setImmediate 后让 notifyIfReady 执行完。 */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

beforeEach(async () => {
  vi.resetModules()
  mod = await import('@/service/restartCoordinator.js')
  mod.configureRestartCoordinator({ isIdle: () => true })
})

describe('restartCoordinator 重启前预检', () => {
  it('validateBeforeRestart 通过 → 正常通知 onRestartReady', async () => {
    const onReady = vi.fn()
    mod.configureRestartCoordinator({
      isIdle: () => true,
      onRestartReady: onReady,
      validateBeforeRestart: () => ({ ok: true }),
    })
    expect(mod.requestRestartWhenIdle()).toBe('immediate')
    await flush()
    expect(onReady).toHaveBeenCalledTimes(1)
  })

  it('validateBeforeRestart 失败 → 不通知 onRestartReady', async () => {
    const onReady = vi.fn()
    const validate = vi.fn(() => ({ ok: false as const, error: '坏配置' }))
    mod.configureRestartCoordinator({
      isIdle: () => true,
      onRestartReady: onReady,
      validateBeforeRestart: validate,
    })
    mod.requestRestartWhenIdle()
    await flush()
    expect(validate).toHaveBeenCalled()
    expect(onReady).not.toHaveBeenCalled()
  })

  it('预检失败后待重启状态复位，再次预检通过可正常重启', async () => {
    const onReady = vi.fn()
    mod.configureRestartCoordinator({
      isIdle: () => true,
      onRestartReady: onReady,
      validateBeforeRestart: () => ({ ok: false as const, error: '第一次坏' }),
    })
    mod.requestRestartWhenIdle()
    await flush()
    expect(onReady).not.toHaveBeenCalled()

    // 修复后（validateBeforeRestart 改为通过）重新请求 → 应能正常通知
    mod.configureRestartCoordinator({
      isIdle: () => true,
      onRestartReady: onReady,
      validateBeforeRestart: () => ({ ok: true }),
    })
    mod.requestRestartWhenIdle()
    await flush()
    expect(onReady).toHaveBeenCalledTimes(1)
  })
})
