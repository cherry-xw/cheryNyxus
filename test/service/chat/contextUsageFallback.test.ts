/**
 * handleChatContextUsage（chat.contextUsage）重启场景回归测试。
 *
 * 背景：该 RPC 原先只认内存 chatRuntimes（getChatSelection）。后端重启后内存 runtime 丢失，
 * 即使 DB 已持久化 metadata.runtime（本就是为了「服务重启后 ensureChat 自动恢复」而写，
 * 见 runtime.ts configureRuntime），也会抛 RUNTIME_SELECTION_REQUIRED；
 * 前端工作台用量条一次性拉取失败后永久空白。
 *
 * 修复约定：内存 selection 缺失时回退 resolveChatRuntimeSelection（ephemeral 覆盖 → DB
 * metadata.runtime）；两者皆无（全新会话从未运行）保持原守卫。
 */
import { randomUUID } from 'node:crypto'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import config from '@/utils/config.js'
import { addMessage, createChat, deleteChat } from '@/db/chat.js'
import { handleChatContextUsage } from '@/service/chat/handler.js'
import { clearChatRuntime, getChatSelection } from '@/service/chat/runtime.js'
import { bootstrapForTests } from '../../agent/helpers/agentHarness.js'
import type { HandlerContext } from '@/service/message/router.js'

const cleanup: string[] = []

beforeAll(bootstrapForTests)

afterEach(() => {
  for (const id of cleanup.splice(0).reverse()) {
    clearChatRuntime(id)
    deleteChat(id)
  }
})

describe('handleChatContextUsage 内存 selection 回退（重启场景回归）', () => {
  it('无内存 runtime 但有持久化 metadata.runtime 时返回真实用量', async () => {
    const chatId = randomUUID()
    cleanup.push(chatId)
    createChat(chatId, {
      runtime: { brain: 'mock_content', senseGroup: 'auto_senses', mcpServers: [] },
    })
    addMessage('ctx-msg-1', chatId, { role: 'user', content: '请分析这段代码' })

    // 前置条件：从未在内存中建立 runtime（模拟后端重启后内存丢失）
    expect(getChatSelection(chatId)).toBeUndefined()

    const res = await handleChatContextUsage({} as HandlerContext, { chatId })
    expect(res.chatId).toBe(chatId)
    expect(res.contextBreakdown).toBeDefined()
    expect(res.contextUsed).toBeGreaterThan(0)
    expect(res.contextBreakdown!.conversation.tokens).toBeGreaterThan(0)
  })

  it('DB selection 提供 brain 上限时 usage/total 正常', async () => {
    const chatId = randomUUID()
    cleanup.push(chatId)
    createChat(chatId, {
      runtime: { brain: 'mock_content', senseGroup: 'auto_senses', mcpServers: [] },
    })
    addMessage('ctx-msg-2', chatId, { role: 'user', content: '分析这段代码的复杂度' })
    const brain = config.llm.brain['mock_content']
    const prevLimit = brain?.contextLimit
    try {
      if (brain) brain.contextLimit = 100_000
      const res = await handleChatContextUsage({} as HandlerContext, { chatId })
      expect(res.contextTotal).toBe(100_000)
      expect(res.contextUsage).toBeGreaterThan(0)
      expect(res.contextUsage).toBeLessThanOrEqual(1)
    } finally {
      if (brain) {
        if (prevLimit === undefined) delete brain.contextLimit
        else brain.contextLimit = prevLimit
      }
    }
  })

  it('两者皆无（全新会话从未运行）保持 RUNTIME_SELECTION_REQUIRED 守卫', async () => {
    const chatId = randomUUID()
    cleanup.push(chatId)
    createChat(chatId)
    await expect(handleChatContextUsage({} as HandlerContext, { chatId })).rejects.toMatchObject({
      code: 'RUNTIME_SELECTION_REQUIRED',
    })
  })
})
