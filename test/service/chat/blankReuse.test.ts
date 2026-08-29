import { randomUUID } from 'node:crypto'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { bootstrapAgentRuntime } from '@/agent/bootstrap.js'
import config from '@/utils/config.js'
import { addMessage, deleteChat } from '@/db/chat.js'
import { handleChatCreate } from '@/service/chat/handler.js'
import { clearChatRuntime } from '@/service/chat/runtime.js'
import type { ChatCreateResponseData } from '@/service/message/types.js'
import type { HandlerContext } from '@/service/message/router.js'
import { logger } from '@/utils/logger/index.js'

const cleanup: string[] = []
const originalRoles = config.roles
const originalPresets = config.presets

beforeAll(async () => {
  await bootstrapAgentRuntime()
})

afterEach(() => {
  config.roles = originalRoles
  config.presets = originalPresets
  for (const chatId of cleanup.splice(0).reverse()) {
    clearChatRuntime(chatId)
    deleteChat(chatId)
  }
})

/**
 * chat.create 空白复用（默认启用，skipBlankReuse 显式关闭）：预设路径 + 主 chat + 未显式
 * 指定 chatId 时，命中同预设 turnCount===0 的最近 root 会话直接返回其 chatId（reused:true）。
 * 契约见 docs/interaction.md「chat.create」与 docs/protocol.md 方法表。
 */
describe('chat.create blank root reuse', () => {
  it('reuses blank root of the same preset, creates fresh once non-blank or opt-out', async () => {
    config.roles = {
      ...originalRoles,
      blankReuseLeader: {
        id: 'role-blank-reuse',
        brain: 'mock_content',
        senseGroup: 'auto_senses',
        mcpServers: [],
      },
    }
    config.presets = {
      ...originalPresets,
      blankReusePreset: {
        id: 'preset-blank-reuse',
        leader: 'blankReuseLeader',
        roles: ['blankReuseLeader'],
      },
    }
    const ctx = { log: logger } as HandlerContext

    // 无既有会话 → 正常新建，无 reused 标记
    const first = await handleChatCreate(ctx, { preset: 'blankReusePreset' })
    cleanup.push(first.chatId)
    expect(first.reused).toBeUndefined()

    // 同预设仍存在空白 root → 复用最近一条，不新建
    const second = await handleChatCreate(ctx, { preset: 'blankReusePreset' })
    cleanup.push(second.chatId)
    expect(second.reused).toBe(true)
    expect(second.chatId).toBe(first.chatId)

    // 首条 user 消息后不再是空白 → 新建
    addMessage(randomUUID(), first.chatId, { role: 'user', content: 'hello' })
    const third = await handleChatCreate(ctx, { preset: 'blankReusePreset' })
    cleanup.push(third.chatId)
    expect(third.reused).toBeUndefined()
    expect(third.chatId).not.toBe(first.chatId)

    // skipBlankReuse: true 显式关闭检查 → 即使存在空白也强制新建
    const fourth = await handleChatCreate(ctx, {
      preset: 'blankReusePreset',
      skipBlankReuse: true,
    })
    cleanup.push(fourth.chatId)
    expect(fourth.reused).toBeUndefined()
    expect(fourth.chatId).not.toBe(first.chatId)

    // 显式指定 chatId → 跳过复用（调用方指定了目标身份）
    const explicitId = randomUUID()
    const fifth = await handleChatCreate(ctx, {
      preset: 'blankReusePreset',
      chatId: explicitId,
    })
    cleanup.push(fifth.chatId)
    expect(fifth.reused).toBeUndefined()
    expect(fifth.chatId).toBe(explicitId)
  })
})
