import { describe, expect, it, vi } from 'vitest'
import {
  ConfigApplyCoordinator,
  type ConfigApplyAdapter,
} from '@/service/config/applyCoordinator.js'
import {
  diffResources,
  imageRevision,
  resources,
  type ConfigImage,
} from '@/service/config/impact.js'
import { ConfigApplyStateSchema, NotificationEnvelopeSchema } from '@chery/protocol'

function image(): ConfigImage {
  return {
    config: {
      global: { thinking: true, stream: true, supervision: 'auto', textEditor: 'old' },
      llm: { brain: { a: { provider: 'mock', model: 'm', key: 'secret-old' } } },
    },
    hooks: {},
  } as ConfigImage
}
function adapter(
  apply = vi.fn(),
  unsafe = () => undefined as string | undefined,
): ConfigApplyAdapter {
  return { prepare: vi.fn(async () => ({ apply, unsafe, dispose: vi.fn() })) }
}
describe('config apply coordinator', () => {
  it('keeps cleanup failures visible even after the resource was swapped', async () => {
    const engine = new ConfigApplyCoordinator(image()),
      after = image()
    after.config.global.textEditor = 'new'
    engine.register('["global","textEditor"]', {
      prepare: async () => ({
        unsafe: () => undefined,
        apply: () => {},
        dispose: () => {
          throw Error('cleanup')
        },
      }),
    })
    engine.submit(after)
    await engine.retry()
    expect(engine.getState()).toMatchObject({
      status: 'failed',
      impacts: [expect.objectContaining({ status: 'failed' })],
    })
  })
  it('no change is applied without preparing anything or requiring restart', async () => {
    const initial = image(),
      engine = new ConfigApplyCoordinator(initial),
      handler = adapter()
    engine.register('["global","textEditor"]', handler)
    expect(engine.submit(initial)).toMatchObject({
      status: 'applied',
      impacts: [],
      restart: { required: false, status: 'none' },
    })
    await engine.retry()
    expect(handler.prepare).not.toHaveBeenCalled()
  })
  it('compares real secrets but only exports paths and no secret values', () => {
    const before = image(),
      after = image()
    after.config.llm.brain.a!.key = 'secret-new'
    const diff = diffResources(resources(before), resources(after), imageRevision(before))
    expect(diff).toHaveLength(1)
    expect(diff[0]).toMatchObject({ boundary: 'run', semantic: false })
    expect(JSON.stringify(diff)).not.toContain('secret-')
    after.config.llm.brain.a!.protocol = 'mock'
    expect(diffResources(resources(before), resources(after), '')[0]).toMatchObject({
      boundary: 'tree',
      semantic: true,
    })
  })
  it('unknown nested fields are unsupported, even when an adapter is registered', async () => {
    const after = image()
    Object.assign(after.config.global, { logger: { alien: true } })
    const engine = new ConfigApplyCoordinator(image()),
      handler = adapter()
    engine.register('["global","logger"]', handler)
    engine.submit(after)
    await engine.retry()
    expect(engine.getState().impacts[0]).toMatchObject({
      boundary: 'unsupported',
      status: 'pending',
    })
    expect(handler.prepare).not.toHaveBeenCalled()
  })
  it('unregistered modules remain explicitly pending', async () => {
    const after = image(),
      engine = new ConfigApplyCoordinator(image())
    after.config.global.textEditor = 'new'
    engine.submit(after)
    await engine.retry()
    expect(engine.getState()).toMatchObject({
      status: 'pending',
      savedRevision: imageRevision(after),
      appliedRevision: imageRevision(image()),
    })
  })
  it('publishes mixed applied and failed results without exposing thrown secrets', async () => {
    const after = image(),
      engine = new ConfigApplyCoordinator(image()),
      notifications: unknown[] = []
    engine.subscribe((s) => notifications.push(s))
    after.config.global.textEditor = 'new'
    after.config.llm.brain.a!.key = 'secret-new'
    engine.register('["global","textEditor"]', adapter())
    engine.register('["llm","brain","a"]', {
      prepare: async () => {
        throw Error('secret-new')
      },
    })
    engine.submit(after)
    await engine.retry()
    const state = engine.getState()
    expect(state.status).toBe('failed')
    expect(state.appliedRevision).toBe(imageRevision(image()))
    expect(state.impacts.map((i) => i.status).sort()).toEqual(['applied', 'failed'])
    expect(notifications.at(-1)).toEqual(state)
    expect(ConfigApplyStateSchema.safeParse(state).success).toBe(true)
    expect(
      NotificationEnvelopeSchema.safeParse({
        kind: 'notification',
        type: 'config.apply.changed',
        data: state,
      }).success,
    ).toBe(true)
    expect(JSON.stringify(notifications)).not.toContain('secret-new')
  })
  it('rechecks safe boundary and supports an explicit retry', async () => {
    const after = image(),
      engine = new ConfigApplyCoordinator(image()),
      swap = vi.fn()
    let busy = true
    after.config.global.textEditor = 'new'
    engine.register(
      '["global","textEditor"]',
      adapter(swap, () => (busy ? 'busy' : undefined)),
    )
    engine.submit(after)
    await engine.retry()
    expect(swap).not.toHaveBeenCalled()
    busy = false
    await engine.retry()
    expect(swap).toHaveBeenCalledOnce()
    expect(engine.getState()).toMatchObject({
      status: 'applied',
      appliedRevision: imageRevision(after),
    })
  })
  it('coalesces candidates that have not begun preparation', async () => {
    const engine = new ConfigApplyCoordinator(image()),
      handler = adapter()
    engine.register('["global","textEditor"]', handler)
    const a = image(),
      b = image()
    a.config.global.textEditor = 'a'
    b.config.global.textEditor = 'b'
    engine.submit(a)
    engine.submit(b)
    await engine.retry()
    expect(handler.prepare).toHaveBeenCalledOnce()
    expect(handler.prepare).toHaveBeenCalledWith(expect.objectContaining({ after: 'b' }))
  })
  it('finishes in-flight application then recomputes against newest candidate', async () => {
    const engine = new ConfigApplyCoordinator(image()),
      swaps: unknown[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    let count = 0
    engine.register('["global","textEditor"]', {
      prepare: async ({ after }) => {
        if (++count === 1) await gate
        return {
          unsafe: () => undefined,
          apply: () => {
            swaps.push(after)
          },
          dispose: () => {},
        }
      },
    })
    const a = image(),
      b = image()
    a.config.global.textEditor = 'a'
    b.config.global.textEditor = 'b'
    engine.submit(a)
    await Promise.resolve()
    engine.submit(b)
    release()
    await engine.retry()
    expect(swaps).toEqual(['a', 'b'])
    expect(engine.getState()).toMatchObject({
      status: 'applied',
      appliedRevision: imageRevision(b),
    })
  })
})
