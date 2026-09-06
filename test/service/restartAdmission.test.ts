import { randomUUID } from 'node:crypto'
import { afterEach, beforeAll, expect, it } from 'vitest'
import { bootstrapAgentRuntime } from '@/agent/bootstrap.js'
import { createChat, deleteChat, listPendingInputs } from '@/db/chat.js'
import {
  ensureChat,
  clearChatRuntime,
  activateChatRun,
  releaseChatRun,
} from '@/service/chat/runtime.js'
import { handleChatInputSubmit } from '@/service/chat/handler.js'
import { setTreeConfigBoundary } from '@/service/config/treeBoundary.js'
import {
  configureRestartCoordinator,
  requestRestartWhenIdle,
  cancelPendingRestart,
} from '@/service/restartCoordinator.js'
import type { HandlerContext } from '@/service/message/router.js'

const chats: string[] = []
beforeAll(bootstrapAgentRuntime)
afterEach(() => {
  cancelPendingRestart()
  setTreeConfigBoundary({ retry: async () => {}, admission: () => undefined })
  for (const id of chats.splice(0)) {
    clearChatRuntime(id)
    deleteChat(id)
  }
})
function create() {
  const id = randomUUID()
  chats.push(id)
  createChat(id, { runtime: { brain: 'mock_content', senseGroup: 'auto_senses', mcpServers: [] } })
  return id
}
function drain() {
  configureRestartCoordinator({ isIdle: () => false, onRestartReady: () => {} })
  requestRestartWhenIdle()
}

it('rechecks restart admission after asynchronous tree preparation', async () => {
  const id = create()
  let finish!: () => void
  const pending = new Promise<void>((resolve) => {
    finish = resolve
  })
  setTreeConfigBoundary({ retry: () => pending, admission: () => 'preparing' })
  const building = ensureChat(id)
  drain()
  setTreeConfigBoundary({ retry: async () => {}, admission: () => undefined })
  finish()
  await expect(building).rejects.toThrow('安全重启')
})

it('allows existing work to continue but rejects new inputs before durable enqueue', async () => {
  const id = create()
  await ensureChat(id, { brain: 'mock_content', senseGroup: 'auto_senses', mcpServers: [] })
  activateChatRun(id, 'existing-run')
  drain()
  await expect(ensureChat(id)).resolves.toBeDefined()
  try {
    await expect(
      handleChatInputSubmit({ requestId: 'test' } as HandlerContext, {
        chatId: id,
        commandId: randomUUID(),
        clientMessageId: randomUUID(),
        messageId: randomUUID(),
        content: 'new work',
      }),
    ).rejects.toThrow('安全重启')
    expect(listPendingInputs(id)).toHaveLength(0)
  } finally {
    releaseChatRun(id, 'existing-run')
  }
})
