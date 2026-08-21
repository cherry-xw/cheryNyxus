import { getSoulDb } from '@/db/index.js'
import { updateChatMetadata } from '@/db/chat.js'
import type { RoleConfig } from '@/utils/config.js'
import { logger } from '@/utils/logger/index.js'

/**
 * 角色改名迁移（config.save 触点，见 docs/db.md「角色改名迁移」）。
 *
 * 前提：角色带稳定 id（ensureRoleIds），设置页改名移动整个 value 对象（id 随行），
 * 故「同 id 不同名」即改名。DB 中按名字引用角色的位置只有两处：
 *   - chats.metadata.type / metadata.spawnTypes（角色名快照）
 *   - spawn_tasks.type（session.runtime.set 回灌按 type 匹配子 chat）
 * 本模块把两处旧名原子改写为新名，使改名对历史 chat 的关联与显示不可见。
 * preset 改名不迁移：presetId 稳定 + 读取侧（getChatPreset）ID 优先已覆盖。
 */

/** 比对保存前后的 roles，返回同 id 不同名的改名清单（from=旧名, to=新名）。 */
export function detectRoleRenames(
  before: Record<string, RoleConfig> | undefined,
  after: Record<string, RoleConfig> | undefined,
): Array<{ from: string; to: string }> {
  if (!before || !after) return []
  const byId = new Map<string, string>()
  for (const [name, role] of Object.entries(after)) {
    if (role.id) byId.set(role.id, name)
  }
  const renames: Array<{ from: string; to: string }> = []
  for (const [name, role] of Object.entries(before)) {
    const to = role.id ? byId.get(role.id) : undefined
    if (to && to !== name) renames.push({ from: name, to })
  }
  return renames
}

/**
 * 迁移单个角色改名：spawn_tasks.type + chats.metadata（type / spawnTypes）。
 * 幂等：旧名无引用时 0 行命中，静默通过（不算错误）。
 */
export function migrateRoleRename(from: string, to: string): void {
  const db = getSoulDb()
  const now = Date.now()

  // 1. spawn_tasks.type（findChildChatsWithType 按 type 匹配回灌的关联键）
  const taskResult = db
    .prepare('UPDATE spawn_tasks SET type = ?, updated_at = ? WHERE type = ?')
    .run(to, now, from)

  // 2. chats.metadata：type 命中或 spawnTypes 数组含旧名的行（json_each 展开数组定位）
  const rows = db
    .prepare(
      `SELECT id, metadata FROM chats
       WHERE metadata IS NOT NULL AND (
         json_extract(metadata, '$.type') = ?
         OR EXISTS (SELECT 1 FROM json_each(json_extract(metadata, '$.spawnTypes')) je
                    WHERE je.value = ?)
       )`,
    )
    .all(from, from) as { id: string; metadata: string }[]

  let chatCount = 0
  for (const row of rows) {
    try {
      const meta = JSON.parse(row.metadata) as Record<string, unknown>
      const patch: Record<string, unknown> = {}
      if (meta.type === from) patch.type = to
      if (Array.isArray(meta.spawnTypes) && meta.spawnTypes.includes(from)) {
        patch.spawnTypes = meta.spawnTypes.map((t) => (t === from ? to : t))
      }
      if (Object.keys(patch).length === 0) continue
      updateChatMetadata(row.id, patch)
      chatCount++
    } catch (err) {
      // 单行 metadata 脏数据不阻断整体迁移；fail loud 记日志（规则12）
      logger.event('role.rename.skip', { chatId: row.id, error: (err as Error).message })
    }
  }

  logger.event('role.rename.migrated', {
    from,
    to,
    spawnTasks: taskResult.changes,
    chats: chatCount,
  })
}
