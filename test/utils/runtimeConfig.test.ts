import path from 'node:path'
import { describe, expect, it } from 'vitest'
import config, {
  createRuntimeConfigCandidate,
  getRuntimeConfig,
  normalizeRuntimeConfig,
  readRawConfig,
  readRuntimeConfigSource,
  replaceRuntimeConfig,
} from '@/utils/config.js'

describe('runtime config boundary', () => {
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
    const restore = readRawConfig()
    const oldRuntime = getRuntimeConfig()
    const candidate = structuredClone(restore)
    candidate.global.textEditor = 'runtime-boundary-test'

    try {
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
    } finally {
      replaceRuntimeConfig(restore)
    }
  })
})
