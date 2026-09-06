import { afterEach, describe, expect, it } from 'vitest'
import { applyEnvFileSnapshot, listEnvVarMap } from '@/utils/config.js'

describe('runtime .env reconciliation', () => {
  const name = 'CHERY_TEST_ENV_RECONCILE'
  const base = listEnvVarMap()

  afterEach(() => {
    applyEnvFileSnapshot(base, true)
    delete process.env[name]
  })

  it('reports additions and rotations and removes the last file-owned value', () => {
    expect(applyEnvFileSnapshot({ ...base, [name]: 'first' }, true).added).toContain(name)
    expect(process.env[name]).toBe('first')
    expect(applyEnvFileSnapshot({ ...base, [name]: 'second' }, true).changed).toContain(name)
    expect(process.env[name]).toBe('second')
    expect(applyEnvFileSnapshot(base, true).removed).toContain(name)
    expect(process.env[name]).toBeUndefined()
  })

  it('reports process-bound changes without replacing their live value', () => {
    const current = process.env.CHERY_DIR
    const changes = applyEnvFileSnapshot({ ...base, CHERY_DIR: 'next-root' }, true)
    expect([...changes.added, ...changes.changed]).toContain('CHERY_DIR')
    expect(process.env.CHERY_DIR).toBe(current)
  })
})
