/**
 * 角色改名迁移 + chat metadata ID 优先读取（docs/db.md「角色改名迁移」「chat metadata 字段语义」）单测。
 *
 * 覆盖：
 * - migrateRoleRename：spawn_tasks.type + chats.metadata（type / spawnTypes）旧名原子改写
 * - getChatType：roleId 优先反查当前名（角色改名后不 stale）；roleId 失效回退名字链
 * - getChatPreset：presetId 优先反查当前名；旧数据回退 metadata.preset
 *
 * 环境复用 flows/fixtures（setup.ts 指向 CHERY_DIR）：loadConfig 后 config.roles 内
 * reviewer / explanation 均已被 ensureRoleIds 自动补全稳定 id。
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createChat, deleteChat, getChat, getChatPreset, getChatType } from '@/db/chat.js'
import { createSpawnTask, getSpawnTaskByChild } from '@/db/delivery.js'
import { migrateRoleRename } from '@/service/config/roleRename.js'
import config, { legacyRoleId } from '@/utils/config.js'

const cleanupChats: string[] = []

afterEach(() => {
  for (const chatId of cleanupChats.splice(0).reverse()) {
    if (getChat(chatId)) deleteChat(chatId)
  }
})

const chatMeta = (chatId: string): Record<string, unknown> => {
  const chat = getChat(chatId)
  return chat?.metadata ? (JSON.parse(chat.metadata) as Record<string, unknown>) : {}
}

describe('migrateRoleRename', () => {
  it('spawn_tasks.type + chats.metadata（type/spawnTypes）旧名原子改写', () => {
    const reviewerId = config.roles?.reviewer?.id ?? legacyRoleId('reviewer')
    const parentChatId = randomUUID()
    const childChatId = randomUUID()
    cleanupChats.push(parentChatId, childChatId)
    createChat(parentChatId, { preset: 'detail-test', spawnTypes: ['reviewer', 'explanation'] })
    createChat(
      childChatId,
      { type: 'reviewer', spawnTypes: ['reviewer', 'explanation'], roleId: reviewerId },
      parentChatId,
    )
    createSpawnTask({
      childChatId,
      parentChatId,
      type: 'reviewer',
      prompt: '测试任务',
      brain: 'mock_content',
      senseGroup: 'auto_senses',
    })

    migrateRoleRename('reviewer', 'reviewer_new')

    // spawn_tasks.type 改写
    expect(getSpawnTaskByChild(childChatId)?.type).toBe('reviewer_new')
    // 子 chat metadata.type 改写（roleId 不动，ID 优先读取仍指向同角色）
    expect(chatMeta(childChatId).type).toBe('reviewer_new')
    expect(chatMeta(childChatId).roleId).toBe(reviewerId)
    // spawnTypes 数组内旧名逐项改写（父 + 子）
    expect(chatMeta(parentChatId).spawnTypes).toEqual(['reviewer_new', 'explanation'])
    expect(chatMeta(childChatId).spawnTypes).toEqual(['reviewer_new', 'explanation'])
  })

  it('旧名无引用时幂等静默通过', () => {
    expect(() => migrateRoleRename('no-such-role', 'no-such-role-new')).not.toThrow()
  })
})

describe('getChatType roleId 优先', () => {
  it('roleId 反查当前名：角色改名后返回新名', () => {
    const reviewerId = config.roles?.reviewer?.id ?? legacyRoleId('reviewer')
    const chatId = randomUUID()
    cleanupChats.push(chatId)
    createChat(chatId, { roleId: reviewerId })

    expect(getChatType(chatId)).toBe('reviewer')

    // 模拟改名：同 id 换键（module 级 config 对象就地变更，测试后还原）
    const roles = config.roles ?? {}
    const original = { ...roles }
    const reviewerCfg = roles.reviewer
    delete roles.reviewer
    roles.reviewer_renamed = reviewerCfg
    try {
      expect(getChatType(chatId)).toBe('reviewer_renamed')
    } finally {
      config.roles = original
    }
  })

  it('roleId 失效（角色已删）回退名字链：metadata.type 旧名仍可用', () => {
    const chatId = randomUUID()
    cleanupChats.push(chatId)
    createChat(chatId, { roleId: 'role-deleted0000000', type: 'explanation' })
    expect(getChatType(chatId)).toBe('explanation')
  })

  it('旧数据（无 roleId）走 metadata.type / preset.leader 回退', () => {
    const childChatId = randomUUID()
    const mainChatId = randomUUID()
    cleanupChats.push(childChatId, mainChatId)
    createChat(childChatId, { type: 'explanation' }, mainChatId)
    createChat(mainChatId, { preset: 'detail-test' })
    expect(getChatType(childChatId)).toBe('explanation')
    expect(getChatType(mainChatId)).toBe('reviewer')
  })
})

describe('getChatPreset presetId 优先', () => {
  it('presetId 反查当前名：预设改名后返回新名', () => {
    const presetId = config.presets?.['detail-test']?.id
    expect(presetId).toBeTruthy()
    const chatId = randomUUID()
    cleanupChats.push(chatId)
    createChat(chatId, { presetId: presetId!, preset: 'detail-test' })

    const presets = config.presets ?? {}
    const original = { ...presets }
    const presetCfg = presets['detail-test']
    delete presets['detail-test']
    presets['detail-test-renamed'] = presetCfg
    try {
      expect(getChatPreset(chatId)).toBe('detail-test-renamed')
    } finally {
      config.presets = original
    }
  })

  it('旧数据（无 presetId）回退 metadata.preset 名', () => {
    const chatId = randomUUID()
    cleanupChats.push(chatId)
    createChat(chatId, { preset: 'detail-test' })
    expect(getChatPreset(chatId)).toBe('detail-test')
  })
})
