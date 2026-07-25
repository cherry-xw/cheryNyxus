import config from '@/utils/config.js'
import type { RoleMentionInfo } from '@/agent/prompt/index.js'
import { getChat, getChatPreset, getChatSpawnTypes } from '@/db/chat.js'

/**
 * 当前主会话可被用户 @ 的角色。编制快照是唯一权威来源：菜单、system prompt 与
 * spawn_role 的 roster gate 必须使用同一批角色，避免出现「能选但不能派」的情况。
 */
export function getChatMentionableRoles(chatId: string): RoleMentionInfo[] {
  const chat = getChat(chatId)
  if (!chat || chat.parent_chat_id) return []

  const presetName = getChatPreset(chatId)
  const preset = presetName ? config.presets?.[presetName] : undefined
  if (!preset) return []

  const roster = getChatSpawnTypes(chatId) ?? preset.roles ?? []
  return roster.flatMap((name) => {
    const role = config.roles?.[name]
    if (!role || name === preset.leader || !role.mentionable) return []
    return [{ name, description: role.description ?? `委派 ${name} 角色处理任务。` }]
  })
}
