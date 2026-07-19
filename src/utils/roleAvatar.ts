/** 角色默认头像池。顺序是协议的一部分：前端使用同一顺序按角色名稳定映射。 */
export const ROLE_AVATAR_POOL = [
  "🧭", "🛠️", "🔬", "🎨", "🧠", "🛰️", "📚", "🧩",
  "🦊", "🐼", "🐙", "🦉", "🐱", "🐶", "🤖", "🧙",
] as const;

/** DJB2 变体；与前端 roleAvatar.ts 保持一致。 */
export function roleAvatarHash(value: string): number {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) hash = (hash * 33) ^ value.charCodeAt(i);
  return hash >>> 0;
}

export function defaultRoleAvatar(roleType: string): string {
  return ROLE_AVATAR_POOL[roleAvatarHash(roleType) % ROLE_AVATAR_POOL.length]!;
}

/** 显式头像允许一个 Emoji（含 ZWJ 序列）或很短的职业字形。 */
export function validateRoleAvatar(value: string): string | null {
  const avatar = value.trim();
  if (!avatar) return "头像不能为空";
  if (avatar.length > 24) return "头像过长（最多 24 个 UTF-16 字符）";
  if (/\p{Cc}|\p{Cs}|[\r\n\t]/u.test(avatar)) return "头像包含不可显示字符";
  if (/\s/u.test(avatar)) return "头像不能包含空白字符";
  return null;
}

export function resolveRoleAvatar(roleType: string, configured?: string): string {
  return configured?.trim() || defaultRoleAvatar(roleType);
}

