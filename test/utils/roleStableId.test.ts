/**
 * 角色稳定身份 id（docs/utils/README.md「稳定身份 id」）单测：
 * - legacyRoleId 确定性生成（同 preset 模式）
 * - ensureRoleIds 补全 / 保留已有
 * - detectRoleRenames 同 id 不同名判定
 * - validateLockedRoleEdits 对 id 自动补全的容差（盘上无 id / 前端带回 id 均合法）
 */
import { describe, expect, it } from 'vitest'
import {
  ensureRoleIds,
  legacyPresetId,
  legacyRoleId,
  type RoleConfig,
} from '@/utils/config.js'
import { validateLockedRoleEdits } from '@/utils/lockedRole.js'
import { detectRoleRenames } from '@/service/config/roleRename.js'

describe('legacyRoleId', () => {
  it('确定性：同名字生成同 id，格式 role- + sha256 前 16 位', () => {
    expect(legacyRoleId('reviewer')).toBe(legacyRoleId('reviewer'))
    expect(legacyRoleId('reviewer')).toMatch(/^role-[a-zA-Z0-9_-]{8,}$/)
    expect(legacyRoleId('reviewer')).not.toBe(legacyRoleId('explanation'))
    // 与 preset id 命名空间隔离（前缀不同）
    expect(legacyRoleId('x')).not.toBe(legacyPresetId('x'))
  })
})

describe('ensureRoleIds', () => {
  it('补全缺失 id（按名字确定性生成）', () => {
    const roles: Record<string, RoleConfig> = {
      reviewer: { brain: 'mock_content', senseGroup: 'auto_senses' },
    }
    ensureRoleIds(roles)
    expect(roles.reviewer?.id).toBe(legacyRoleId('reviewer'))
  })

  it('保留已有 id（改名后不重新生成）', () => {
    const roles: Record<string, RoleConfig> = {
      renamed: { brain: 'mock_content', senseGroup: 'auto_senses', id: 'role-fixed000000000' },
    }
    ensureRoleIds(roles)
    expect(roles.renamed?.id).toBe('role-fixed000000000')
  })

  it('undefined -> no-op', () => {
    expect(() => ensureRoleIds(undefined)).not.toThrow()
  })
})

describe('detectRoleRenames', () => {
  const roleOf = (id?: string): RoleConfig =>
    id
      ? { brain: 'mock_content', senseGroup: 'auto_senses', id }
      : { brain: 'mock_content', senseGroup: 'auto_senses' }

  it('同 id 不同名 -> 识别为改名', () => {
    const id = legacyRoleId('reviewer')
    const before = { reviewer: roleOf(id) }
    const after = { reviewer_new: roleOf(id) }
    expect(detectRoleRenames(before, after)).toEqual([{ from: 'reviewer', to: 'reviewer_new' }])
  })

  it('无 id（旧数据）-> 不判定改名', () => {
    expect(detectRoleRenames({ reviewer: roleOf() }, { reviewer_new: roleOf() })).toEqual([])
  })

  it('名相同 / 一侧缺失 -> 不判定改名', () => {
    const id = legacyRoleId('reviewer')
    expect(detectRoleRenames({ reviewer: roleOf(id) }, { reviewer: roleOf(id) })).toEqual([])
    expect(detectRoleRenames(undefined, { reviewer: roleOf(id) })).toEqual([])
    expect(detectRoleRenames({ reviewer: roleOf(id) }, undefined)).toEqual([])
  })
})

describe('validateLockedRoleEdits 对 id 的容差', () => {
  const locked: RoleConfig = {
    brain: 'brain-a',
    avatar: 'cat',
    description: 'fixed identity',
    senseGroup: 'leader',
    systemPrompt: 'prompt/leader.md',
    lock: true,
  }

  it('cheryNyxus：盘上无 id / 前端带回 id 深比较均放行', () => {
    // 盘上无 id，前端草稿带自动补全的 id
    expect(
      validateLockedRoleEdits({ cheryNyxus: locked }, { cheryNyxus: { ...locked, id: legacyRoleId('cheryNyxus') } }),
    ).toEqual([])
    // 盘上带 id，前端草稿 id 缺失
    expect(
      validateLockedRoleEdits(
        { cheryNyxus: { ...locked, id: legacyRoleId('cheryNyxus') } },
        { cheryNyxus: locked },
      ),
    ).toEqual([])
  })
})
