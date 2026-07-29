import { describe, expect, it } from 'vitest'
import { validateFixedPresetEdits, validateLockedRoleEdits } from '@/utils/lockedRole.js'
import type { RoleConfig } from '@/utils/config.js'

const locked: RoleConfig = {
  brain: 'brain-a',
  avatar: 'cat',
  description: 'fixed identity',
  senseGroup: 'leader',
  systemPrompt: 'prompt/leader.md',
  lock: true,
}

describe('validateLockedRoleEdits', () => {
  it('rejects all cheryNyxus field changes', () => {
    const next = { ...locked, brain: 'brain-b', senseGroup: 'other', skills: ['skill-a'] }
    expect(validateLockedRoleEdits({ cheryNyxus: locked }, { cheryNyxus: next })).toEqual([
      'roles.cheryNyxus 是固定角色，不能修改',
    ])
  })

  it('rejects deleting or unlocking a locked role', () => {
    expect(validateLockedRoleEdits({ housekeeper: locked }, {})).toEqual([
      'roles.housekeeper 是锁定角色，不能删除或改名',
    ])
    expect(
      validateLockedRoleEdits({ housekeeper: locked }, { housekeeper: { ...locked, lock: false } }),
    ).toContain('roles.housekeeper.lock 不能取消')
  })

  it.each(['avatar', 'description', 'systemPrompt'] as const)(
    'rejects changing locked identity field %s',
    (field) => {
      const next = { ...locked, [field]: 'changed' }
      expect(validateLockedRoleEdits({ housekeeper: locked }, { housekeeper: next })).toContain(
        `roles.housekeeper.${field} 是锁定身份字段，不能修改`,
      )
    },
  )

  it('keeps the identity-only behavior for other locked roles', () => {
    const next = { ...locked, brain: 'brain-b' }
    expect(validateLockedRoleEdits({ housekeeper: locked }, { housekeeper: next })).toEqual([])
  })
})

describe('validateFixedPresetEdits', () => {
  const current = {
    cheryNyxus: { leader: 'cheryNyxus', roles: ['cheryNyxus'] },
  }

  it('rejects deleting, renaming, or changing the fixed leader', () => {
    expect(validateFixedPresetEdits(current, {})).toEqual([
      'presets.cheryNyxus 是固定预设，不能删除或改名',
    ])
    expect(
      validateFixedPresetEdits(current, {
        cheryNyxus: { leader: 'coordinator', roles: ['cheryNyxus'] },
      }),
    ).toEqual(['presets.cheryNyxus.leader 是固定组长，不能修改'])
  })

  it('allows changing non-fixed preset fields', () => {
    expect(
      validateFixedPresetEdits(current, {
        cheryNyxus: { leader: 'cheryNyxus', roles: ['cheryNyxus', 'housekeeper'] },
      }),
    ).toEqual([])
  })
})
