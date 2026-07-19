/** 必须与后端 src/utils/roleAvatar.ts 顺序一致，确保旧配置的默认头像前后端相同。 */
export const ROLE_AVATAR_POOL = [
  "🧭", "🛠️", "🔬", "🎨", "🧠", "🛰️", "📚", "🧩",
  "🦊", "🐼", "🐙", "🦉", "🐱", "🐶", "🤖", "🧙",
] as const;

export const CAREER_AVATARS = ["⚔️", "🛡️", "🏹", "🧪", "💻", "✍️", "🎯", "🪄"] as const;

function roleAvatarHash(value: string): number {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) hash = (hash * 33) ^ value.charCodeAt(i);
  return hash >>> 0;
}

export function defaultRoleAvatar(roleType: string): string {
  return ROLE_AVATAR_POOL[roleAvatarHash(roleType) % ROLE_AVATAR_POOL.length]!;
}

export function resolveRoleAvatar(roleType: string, configured?: string): string {
  return configured?.trim() || defaultRoleAvatar(roleType);
}

export function validateRoleAvatar(value: string): string | null {
  const avatar = value.trim();
  if (!avatar) return "头像不能为空";
  if (avatar.length > 24) return "头像太长了";
  if (/\p{Cc}|\p{Cs}|[\r\n\t]/u.test(avatar) || /\s/u.test(avatar)) return "头像不能包含空白或控制字符";
  return null;
}

