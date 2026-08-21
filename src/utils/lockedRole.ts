import { isDeepStrictEqual } from 'node:util'

export interface LockableRoleIdentity {
  id?: string
  brain?: string
  avatar?: string
  description?: string
  systemPrompt?: string
  permissions?: unknown
  lock?: boolean
}

export const CHERY_NYXUS_NAME = 'cheryNyxus'

const LOCKED_ROLE_IDENTITY_FIELDS = ['avatar', 'description', 'systemPrompt'] as const

/** 校验 config.save 没有删除或改写盘上已锁角色的身份字段。 */
export function validateLockedRoleEdits<T extends LockableRoleIdentity>(
  current: Readonly<Record<string, T>> | undefined,
  incoming: Readonly<Record<string, T>> | undefined,
): string[] {
  const errors: string[] = []
  for (const [name, role] of Object.entries(current ?? {})) {
    if (!role.lock && name !== CHERY_NYXUS_NAME) continue
    const next = incoming?.[name]
    if (!next) {
      errors.push(`roles.${name} 是锁定角色，不能删除或改名`)
      continue
    }
    if (name === CHERY_NYXUS_NAME) {
      // id 除外：稳定身份 id 由 ensureRoleIds 自动补全，盘上旧配置无 id / 前端带回 id 均合法。
      const { brain: _b, permissions: _p, id: _id, ...currentFixedFields } = role
      const { brain: _nb, permissions: _np, id: _nid, ...nextFixedFields } = next
      if (!isDeepStrictEqual(nextFixedFields, currentFixedFields))
        errors.push(`roles.${name} 是固定角色，除大脑外不能修改`)
      continue
    }
    if (!next.lock) errors.push(`roles.${name}.lock 不能取消`)
    for (const field of LOCKED_ROLE_IDENTITY_FIELDS) {
      if (next[field] !== role[field])
        errors.push(`roles.${name}.${field} 是锁定身份字段，不能修改`)
    }
  }
  return errors
}

interface FixedPresetLeader {
  leader: string
}

/** cheryNyxus 预设是固定入口的编制根：名称与组长不可变，其他字段照常可维护。 */
export function validateFixedPresetEdits<T extends FixedPresetLeader>(
  current: Readonly<Record<string, T>> | undefined,
  incoming: Readonly<Record<string, T>> | undefined,
): string[] {
  const preset = current?.[CHERY_NYXUS_NAME]
  if (!preset) return []
  const next = incoming?.[CHERY_NYXUS_NAME]
  if (!next) return [`presets.${CHERY_NYXUS_NAME} 是固定预设，不能删除或改名`]
  if (next.leader !== preset.leader)
    return [`presets.${CHERY_NYXUS_NAME}.leader 是固定组长，不能修改`]
  return []
}
