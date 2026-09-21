import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const PUBLIC_ROLE = resolve(
  import.meta.dirname,
  '../../src/features/agent/settings/tabs/agent/publicRole.ts',
)

describe('public role detection (public vs system-locked vs private)', () => {
  it('excludes locked system roles (curator / roleArchitect / roleAcceptance) from public roles', async () => {
    const src = await readFile(PUBLIC_ROLE, 'utf8')

    expect(src).toContain("role.kind === 'shadow' || role.lock")
    expect(src).toContain('系统锁定角色')
    expect(src).toContain('curator / roleArchitect / roleAcceptance')
  })

  it('treats explicit scope:public as public only when not locked', async () => {
    const src = await readFile(PUBLIC_ROLE, 'utf8')

    expect(src).toContain("if (role.scope === 'public') return true")
    expect(src).toContain("!role || role.kind === 'shadow' || role.lock")
  })

  it('keeps the fixed preset leader out of the public pool', async () => {
    const src = await readFile(PUBLIC_ROLE, 'utf8')

    expect(src).toContain('return name !== fixed.leader')
    expect(src).toContain('CHERY_NYXUS_PRESET')
  })

  it('keeps seed public role protection for the fixed-preset explain role only', async () => {
    const src = await readFile(PUBLIC_ROLE, 'utf8')

    expect(src).toContain('isSeedPublicRole')
    expect(src).toContain("role.scope === 'public' || role.kind === 'shadow' || role.lock")
    expect(src).toContain('如 explanation')
  })
})
