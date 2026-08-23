import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getSoulDb } from '@/db/index.js'
import { handleChatInputSubmit } from '@/service/chat/handler.js'
import type { HandlerContext } from '@/service/message/router.js'

describe('chat.input.submit command lifecycle', () => {
  it('releases a claimed idempotency record when validation fails after claim', async () => {
    const commandId = randomUUID()
    const input = {
      chatId: `missing-${randomUUID()}`,
      commandId,
      clientMessageId: randomUUID(),
      messageId: randomUUID(),
      content: 'hello',
    }
    const context = { requestId: commandId, connectionId: 'input-command-test' } as HandlerContext

    await expect(handleChatInputSubmit(context, input)).rejects.toThrow('这个会话不见了')
    expect(
      getSoulDb().prepare('SELECT status FROM request_journal WHERE request_id = ?').get(commandId),
    ).toBeUndefined()

    // Reusing the same command id repeats real validation instead of getting
    // stuck forever as COMMAND_CONFLICT/active after a reconnect retry.
    await expect(handleChatInputSubmit(context, input)).rejects.toThrow('这个会话不见了')
  })
})
