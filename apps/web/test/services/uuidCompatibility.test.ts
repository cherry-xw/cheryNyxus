import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { uuid } from '../../src/utils/uuid'

const pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
afterEach(() => vi.unstubAllGlobals())

describe('browser UUID compatibility without browser operations', () => {
  it('uses native randomUUID when available', () => {
    const randomUUID = vi.fn(() => 'native-id')
    vi.stubGlobal('crypto', { randomUUID })
    expect(uuid()).toBe('native-id')
    expect(randomUUID).toHaveBeenCalledTimes(1)
  })

  it('uses getRandomValues on HTTP without randomUUID and preserves UUID version and variant', () => {
    const cryptoApi = globalThis.crypto
    const getRandomValues = vi.fn((bytes: Uint8Array) => cryptoApi.getRandomValues(bytes))
    vi.stubGlobal('crypto', { getRandomValues })
    const values = Array.from({ length: 100 }, () => uuid())
    expect(values.every(value => pattern.test(value))).toBe(true)
    expect(new Set(values).size).toBe(values.length)
    expect(getRandomValues).toHaveBeenCalledTimes(100)
  })

  it('supports environments without the crypto object for non-secret request and draft IDs', () => {
    vi.stubGlobal('crypto', undefined)
    expect(uuid()).toMatch(pattern)
  })

  it('does not bypass the shared compatibility helper in browser features or file drafts', () => {
    function check(path: string): void {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const name = join(path, entry.name)
        if (entry.isDirectory()) check(name)
        else if (/\.(ts|vue)$/.test(name)) expect(readFileSync(name, 'utf8'), name).not.toMatch(/\bcrypto\s*(?:\?\.)?\.?(?:randomUUID|\[['"]randomUUID['"]\])/)
      }
    }
    check('apps/web/src/features')
    check('apps/web/src/application/files')
  })
})
