import { afterEach, describe, expect, it } from 'vitest'
import config, {
  captureRuntimeConfig,
  getAppliedRawConfig,
  replaceRuntimeConfig,
} from '@/utils/config.js'
import { logger } from '@/utils/logger/index.js'
import { ConfigApplyCoordinator } from '@/service/config/applyCoordinator.js'
import { registerRuntimeConfigAdapters } from '@/service/config/runtimeApply.js'
import type { ConfigImage } from '@/service/config/impact.js'
import { diffResources, resources } from '@/service/config/impact.js'
import { clearHookRegistry, loadHookRegistry } from '@/agent/hooks/registry.js'

describe('runtime config coordinator adapter', () => {
  const baseline = getAppliedRawConfig()

  afterEach(() => {
    replaceRuntimeConfig(baseline)
    logger.setConfig(captureRuntimeConfig().global.logger ?? {})
    clearHookRegistry()
  })

  function image(): ConfigImage {
    return { config: getAppliedRawConfig(), hooks: {} }
  }

  it('applies connection fields for new runs while old snapshots stay stable', async () => {
    const before = image()
    const after = structuredClone(before)
    const name = Object.keys(after.config.llm.brain)[0]!
    const oldSnapshot = captureRuntimeConfig()
    const oldUrl = oldSnapshot.llm.brain[name]!.url
    after.config.llm.brain[name]!.url = `${oldUrl ?? 'http://runtime.test'}/changed`
    const coordinator = new ConfigApplyCoordinator(before)
    registerRuntimeConfigAdapters(coordinator, after)

    coordinator.submit(after)
    await coordinator.retry()

    expect(coordinator.getState().status).toBe('applied')
    expect(captureRuntimeConfig().llm.brain[name]!.url).toBe(after.config.llm.brain[name]!.url)
    expect(oldSnapshot.llm.brain[name]!.url).toBe(oldUrl)
  })

  it('publishes operation resources together and supports additions and deletions', async () => {
    const before = image()
    const after = structuredClone(before)
    const oldSnapshot = captureRuntimeConfig()
    after.config.global.textEditor = 'hot-editor'
    after.config.global.file_compression = { truncate_threshold: 17 }
    delete after.config.global.history_recall
    after.config.media = {
      ...(after.config.media ?? {}),
      hot_image: { type: 'image', url: 'http://media.hot', enabled: true },
    }
    after.config.memory = {
      ...(after.config.memory ?? {}),
      global: { max_count: 9, max_chars: 123 },
    }
    const coordinator = new ConfigApplyCoordinator(before)
    registerRuntimeConfigAdapters(coordinator, after)

    coordinator.submit(after)
    await coordinator.retry()

    expect(coordinator.getState().status).toBe('applied')
    expect(config.global.textEditor).toBe('hot-editor')
    expect(config.global.file_compression?.truncate_threshold).toBe(17)
    expect(getAppliedRawConfig().global.history_recall).toBeUndefined()
    expect(config.global.history_recall).toEqual({ max_output_chars: 4000 })
    expect(config.media?.hot_image?.url).toBe('http://media.hot')
    expect(config.memory?.global).toEqual({ max_count: 9, max_chars: 123 })
    expect(oldSnapshot.global.textEditor).not.toBe('hot-editor')
    expect(oldSnapshot.media?.hot_image).toBeUndefined()
  })

  it('applies logger and run settings without waiting for a tree boundary', async () => {
    const before = image()
    const after = structuredClone(before)
    after.config.global.logger = {
      level: 'error',
      output: ['console'],
      timestamp: false,
      location: false,
      format: 'plain',
    }
    after.config.global.thinking = !before.config.global.thinking
    after.config.global.stream = !before.config.global.stream
    after.config.global.maxLoopCount = 7
    after.config.global.approval_timeout = 321
    after.config.global.watchdog = { timeout_ms: 654, wake_on_timeout: true }
    const coordinator = new ConfigApplyCoordinator(before)
    registerRuntimeConfigAdapters(coordinator, after)

    coordinator.submit(after)
    await coordinator.retry()

    expect(coordinator.getState().status).toBe('applied')
    expect(captureRuntimeConfig().global).toMatchObject({
      thinking: after.config.global.thinking,
      stream: after.config.global.stream,
      maxLoopCount: 7,
      approval_timeout: 321,
      watchdog: { timeout_ms: 654, wake_on_timeout: true },
    })
    expect(logger.getConfig()).toMatchObject({
      output: ['console'],
      timestamp: false,
      location: false,
      format: 'plain',
    })
  })

  it('applies semantic brain changes when no affected trees have active work', async () => {
    const before = image()
    const after = structuredClone(before)
    const name = Object.keys(after.config.llm.brain)[0]!
    const oldModel = captureRuntimeConfig().llm.brain[name]!.model
    after.config.llm.brain[name]!.model = `${oldModel}-semantic-change`
    const coordinator = new ConfigApplyCoordinator(before)
    registerRuntimeConfigAdapters(coordinator, after)

    coordinator.submit(after)
    await coordinator.retry()

    expect(coordinator.getState()).toMatchObject({
      status: 'applied',
      impacts: [expect.objectContaining({ boundary: 'tree', status: 'applied' })],
    })
    expect(captureRuntimeConfig().llm.brain[name]!.model).toBe(`${oldModel}-semantic-change`)
  })

  it('splits hook paths and preset schedules from their semantic owners', () => {
    const before = image()
    const after = structuredClone(before)
    const brain = Object.keys(after.config.llm.brain)[0]!
    after.config.llm.brain[brain]!.hooks = 'hooks/next.json'
    const preset = Object.keys(after.config.presets ?? {})[0]!
    if (preset) {
      after.config.presets![preset]!.schedule = {
        cron: '0 0 * * *',
        task: 'maintenance',
        enabled: true,
      }
    }

    const impacts = diffResources(resources(before), resources(after), 'test')

    expect(impacts).toContainEqual(
      expect.objectContaining({
        resource: `["llm","brain","${brain}","hooks"]`,
        boundary: 'resource',
      }),
    )
    if (preset)
      expect(impacts).toContainEqual(
        expect.objectContaining({
          resource: `["presets","${preset}","schedule"]`,
          boundary: 'resource',
        }),
      )
  })

  it('publishes a validated Hooks resource on the next dispatch boundary', async () => {
    const before = image()
    const after = structuredClone(before)
    after.hooks = { Stop: [{ command: 'next.sh' }] }
    const coordinator = new ConfigApplyCoordinator(before)
    registerRuntimeConfigAdapters(coordinator, after)

    coordinator.submit(after)
    await coordinator.retry()

    expect(coordinator.getState().status).toBe('applied')
    expect(loadHookRegistry().Stop?.[0]?.command).toBe('next.sh')
  })
})
