import type { ConfigDto } from '@/application/backend/public'

/** 固定预设名：其成员角色（除组长外）视为公共角色（存量兼容种子，无需改配置文件）。 */
export const CHERY_NYXUS_PRESET = 'cheryNyxus'

/**
 * 角色是否公共角色：
 * - 显式 `scope: 'public'`（非锁定）；
 * - 或存量兼容——固定预设（cheryNyxus）的成员角色（如 explanation），
 *   排除锁定角色（curator / roleArchitect / roleAcceptance 等系统锁定角色，lock 只代表不可删改，
 *   不代表共享）与固定预设自身组长（cheryNyxus，组长是预设私有编成核心，且历史存在跨预设组长引用）。
 * 影子角色不算公共角色；组长不能是公共角色。
 */
export function isPublicRole(
  roles: ConfigDto['roles'] | undefined,
  presets: ConfigDto['presets'] | undefined,
  name: string,
): boolean {
  const role = roles?.[name]
  if (!role || role.kind === 'shadow' || role.lock) return false
  if (role.scope === 'public') return true
  const fixed = presets?.[CHERY_NYXUS_PRESET]
  if (!fixed?.roles?.includes(name)) return false
  return name !== fixed.leader
}

/** 公共角色池（普通模式）。 */
export function listPublicRoles(draft: ConfigDto): string[] {
  return Object.keys(draft.roles ?? {}).filter((name) =>
    isPublicRole(draft.roles, draft.presets, name),
  )
}

/**
 * 是否固定预设内置种子公共角色：无显式 scope、由固定预设成员推导出来的公共角色
 * （如 explanation，不含组长与锁定系统角色）。属系统模板，禁止删除。
 */
export function isSeedPublicRole(
  roles: ConfigDto['roles'] | undefined,
  presets: ConfigDto['presets'] | undefined,
  name: string,
): boolean {
  const role = roles?.[name]
  if (!role || role.scope === 'public' || role.kind === 'shadow' || role.lock) return false
  const fixed = presets?.[CHERY_NYXUS_PRESET]
  if (!fixed?.roles?.includes(name)) return false
  return name !== fixed.leader
}
