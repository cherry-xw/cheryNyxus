import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'

// decide/answer 在错误路径之前就抛出，不会真正走到 resume；mock 掉以隔离 Agent 启动。
vi.mock('@/service/chat/send.js', () => ({ launchDetachedResume: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/service/chat/wake.js', () => ({ resolveQuestionBatch: vi.fn().mockResolvedValue(undefined) }))

import { createChat, deleteChat } from '@/db/chat.js'
import { upsertPendingInteraction, transitionInteraction } from '@/db/interaction.js'
import { claimRequest } from '@/db/delivery.js'
import { createRouter } from '@/service/message/router.js'
import { registerInteractionHandlers } from '@/service/interaction/handler.js'
import { Method, ErrorCode } from '@/service/message/types.js'
import { logger } from '@/utils/logger/index.js'

const chats: string[] = []
afterEach(() => {
  for (const chatId of chats.splice(0).reverse()) deleteChat(chatId)
})

const ctx = { connectionId: 'test', log: logger }

/** dispatch 并断言错误响应的 code。 */
async function expectErrorCode(params: Record<string, unknown>): Promise<string> {
  const router = createRouter()
  registerInteractionHandlers(router)
  const result = (await router.handle(
    { id: randomUUID(), method: Method.INTERACTION_APPROVAL_DECIDE, params },
    ctx,
  )) as { success: boolean; error?: { code: string } }
  expect(result.success).toBe(false)
  return result.error!.code
}

describe('D13 interaction error codes', () => {
  it('expectedRevision mismatch surfaces INTERACTION_STALE', async () => {
    const chatId = randomUUID()
    chats.push(chatId)
    createChat(chatId)
    upsertPendingInteraction({
      interactionId: 'approval-stale',
      kind: 'approval',
      chatId,
      payload: { senseName: 'bash', arguments: '{}' },
    })
    const code = await expectErrorCode({
      interactionId: 'approval-stale',
      action: 'reject',
      expectedRevision: 999, // 过期
      commandId: randomUUID(),
    })
    expect(code).toBe(ErrorCode.INTERACTION_STALE)
  })

  it('already-completed approval surfaces INTERACTION_ALREADY_RESOLVED', async () => {
    const chatId = randomUUID()
    chats.push(chatId)
    createChat(chatId)
    upsertPendingInteraction({
      interactionId: 'approval-done',
      kind: 'approval',
      chatId,
      payload: { senseName: 'bash', arguments: '{}' },
    })
    const completed = transitionInteraction('approval-done', ['pending'], 'completed', {
      action: 'accept',
    })
    expect(completed?.status).toBe('completed')
    const code = await expectErrorCode({
      interactionId: 'approval-done',
      action: 'accept',
      expectedRevision: completed!.revision,
      commandId: randomUUID(),
    })
    expect(code).toBe(ErrorCode.INTERACTION_ALREADY_RESOLVED)
  })

  it('commandId reuse with different params surfaces COMMAND_CONFLICT', async () => {
    const chatId = randomUUID()
    chats.push(chatId)
    createChat(chatId)
    upsertPendingInteraction({
      interactionId: 'approval-conflict',
      kind: 'approval',
      chatId,
      payload: { senseName: 'bash', arguments: '{}' },
    })
    // 预置幂等层指纹（模拟一次仍在处理中的同 commandId 命令；失败路径会 abandon，
    // 故此处直接以 claimRequest 建立 active 行——同 commandId 不同参数 = mismatch）。
    const seeded = claimRequest('cmd-dup', Method.INTERACTION_APPROVAL_DECIDE, {
      interactionId: 'approval-conflict',
      action: 'accept',
      expectedRevision: 999,
    })
    expect(seeded.state).toBe('new')
    // 同一 commandId 但参数不同（action 变化）→ 指纹不匹配 → COMMAND_CONFLICT
    const code = await expectErrorCode({
      interactionId: 'approval-conflict',
      action: 'reject',
      expectedRevision: 999,
      commandId: 'cmd-dup',
    })
    expect(code).toBe(ErrorCode.COMMAND_CONFLICT)
  })
})
