import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import config, {
  captureRuntimeConfig,
  createRuntimeConfigCandidate,
  getAppliedRawConfig,
  getRuntimeConfig,
  normalizeRuntimeConfig,
  readRawConfig,
  readRuntimeConfigSource,
  refreshRuntimeConfigEnvironment,
  replaceRuntimeConfig,
} from '@/utils/config.js'

describe('runtime config boundary', () => {
  const baseline = readRawConfig()

  afterEach(() => {
    replaceRuntimeConfig(baseline)
  })

  it('keeps disk parsing independent from startup exit policy', () => {
    const missingRoot = path.join(process.env.CHERY_DIR!, '.missing-runtime-config')
    expect(() => readRuntimeConfigSource(missingRoot)).toThrow()
  })

  it('normalizes a clone without changing the raw placeholder source', () => {
    const source = readRuntimeConfigSource(process.env.CHERY_DIR!)
    const firstBrain = Object.values(source.llm.brain)[0]!
    firstBrain.key = '$RUNTIME_CONFIG_TEST_KEY'
    const before = structuredClone(source)

    const runtime = normalizeRuntimeConfig(source, {
      cheryDir: process.env.CHERY_DIR!,
      dbDir: 'fixed-db',
      environment: { RUNTIME_CONFIG_TEST_KEY: 'resolved-secret' },
      server: source.server,
    })

    expect(Object.values(runtime.llm.brain)[0]!.key).toBe('resolved-secret')
    expect(firstBrain.key).toBe('$RUNTIME_CONFIG_TEST_KEY')
    expect(source).toEqual(before)
    expect(runtime.global.db_dir).toBe('fixed-db')
  })

  it('publishes only a fully normalized candidate and retains the old object on failure', () => {
    const oldRuntime = getRuntimeConfig()
    const candidate = structuredClone(baseline)
    candidate.global.textEditor = 'runtime-boundary-test'

    const built = createRuntimeConfigCandidate(candidate)
    expect(getRuntimeConfig()).toBe(oldRuntime)

    const published = replaceRuntimeConfig(candidate)
    expect(published).toEqual(built)
    expect(getRuntimeConfig()).toBe(published)
    expect(config.global.textEditor).toBe('runtime-boundary-test')
    expect(oldRuntime.global.textEditor).not.toBe('runtime-boundary-test')

    const invalid = structuredClone(candidate)
    invalid.global.supervision = 'invalid' as never
    expect(() => replaceRuntimeConfig(invalid)).toThrow('配置校验失败')
    expect(getRuntimeConfig()).toBe(published)
  })

  it('uses the startup normalizer for hot candidates and preserves startup-only values', () => {
    const startup = getRuntimeConfig()
    const candidate = structuredClone(baseline) as typeof baseline & {
      server?: { port: number }
    }
    Object.assign(candidate.global, { db_dir: 'candidate-db', prompts_dir: 'candidate-prompts' })
    candidate.server = { port: 1 }
    const normalized = createRuntimeConfigCandidate(candidate)

    expect(normalized.server).toEqual(startup.server)
    expect(normalized.global.db_dir).toBe(startup.global.db_dir)
    expect(normalized.global.prompts_dir).toBe(startup.global.prompts_dir)
    expect(normalized.global.disconnect_grace_ms).toBe(15_000)
    expect(normalized.global.approval_timeout).toBe(300_000)
    expect(normalized.global.approval_hard_timeout).toBe(1_800_000)
    expect(normalized.memory).toEqual(startup.memory)
  })

  it('retains raw placeholders and can re-resolve added, rotated, and missing values', () => {
    const name = Object.keys(baseline.llm.brain)[0]!
    const variable = 'RUNTIME_CONFIG_ROTATION_TEST'
    const previous = process.env[variable]
    const candidate = structuredClone(baseline)
    candidate.llm.brain[name]!.key = `$${variable}`

    try {
      process.env[variable] = 'first-secret'
      const oldSnapshot = captureRuntimeConfig()
      replaceRuntimeConfig(candidate)
      expect(getRuntimeConfig().llm.brain[name]!.key).toBe('first-secret')
      expect(getAppliedRawConfig().llm.brain[name]!.key).toBe(`$${variable}`)

      process.env[variable] = 'second-secret'
      refreshRuntimeConfigEnvironment()
      expect(getRuntimeConfig().llm.brain[name]!.key).toBe('second-secret')
      expect(oldSnapshot.llm.brain[name]!.key).not.toBe('second-secret')

      delete process.env[variable]
      refreshRuntimeConfigEnvironment()
      expect(getRuntimeConfig().llm.brain[name]!.key).toBe(`$${variable}`)
    } finally {
      if (previous === undefined) delete process.env[variable]
      else process.env[variable] = previous
    }
  })

  it('rejects an invalid candidate workspace before publication', () => {
    const candidate = structuredClone(baseline)
    const preset = Object.keys(candidate.presets ?? {})[0]!
    candidate.presets![preset]!.workspace = 'relative/workspace'
    const before = getRuntimeConfig()

    expect(() => replaceRuntimeConfig(candidate)).toThrow('必须是绝对路径')
    expect(getRuntimeConfig()).toBe(before)
  })
})
