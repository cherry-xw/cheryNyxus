import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createChat, getChat } from '@/db/chat.js'
import { createSpawnTask, appendChatEvent } from '@/db/delivery.js'
import { ensureActiveChatEpoch } from '@/db/epoch.js'
import { createTreePause, addTreePauseTarget } from '@/db/treeControl.js'
import { getSoulDb } from '@/db/index.js'
import { handleChatDelete } from '@/service/chat/handler.js'
import type { HandlerContext } from '@/service/message/router.js'
import { logger } from '@/utils/logger/index.js'

describe('chat physical deletion', () => {
  it('cascades descendants and removes task/event/tree-control/epoch ownership rows', async () => {
    const root = randomUUID()
    const child = randomUUID()
    const pauseId = randomUUID()
    createChat(root)
    const epoch = ensureActiveChatEpoch({ chatId: root, revisionId: 'revision-delete' }).epoch
    createChat(child, { type: 'coder' }, root)
    createSpawnTask({
      childChatId: child,
      parentChatId: root,
      type: 'coder',
      prompt: 'work',
      brain: 'brain',
      senseGroup: 'tools',
      epochId: epoch.epochId,
    })
    createTreePause(pauseId, root)
    addTreePauseTarget(pauseId, child, 'run-child')
    appendChatEvent(root, { kind: 'notification', type: 'test', data: {}, chatId: root })

    const result = await handleChatDelete({ log: logger } as HandlerContext, { chatId: root })

    expect(result.deletedChatIds).toEqual([child, root])
    expect(getChat(root)).toBeUndefined()
    expect(getChat(child)).toBeUndefined()
    const db = getSoulDb()
    for (const [table, where, value] of [
      ['spawn_tasks', 'parent_chat_id', root],
      ['root_events', 'root_chat_id', root],
      ['tree_control_operations', 'root_chat_id', root],
      ['tree_control_targets', 'pause_id', pauseId],
      ['chat_epochs', 'root_chat_id', root],
    ] as const) {
      const row = db
        .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where} = ?`)
        .get(value) as { count: number }
      expect(row.count, table).toBe(0)
    }
  })
})
