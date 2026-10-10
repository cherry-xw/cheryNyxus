import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createChat, deleteChat, getChat } from '@/db/chat.js'
import { getSoulDb } from '@/db/index.js'
import {
  ensureConversationTask,
  getConversationTask,
  listBranchFamilyChatIds,
  listConversationBranches,
} from '@/db/conversationBranch.js'
import { handleChatDelete } from '@/service/chat/handler.js'
import type { HandlerContext } from '@/service/message/router.js'

const cleanup: string[] = []

afterEach(() => {
  for (const chatId of cleanup.splice(0).reverse()) {
    if (getChat(chatId)) deleteChat(chatId)
  }
})

describe('chat.delete', () => {
  it('returns the authoritative set of recursively deleted chats', async () => {
    const rootChatId = randomUUID()
    const childChatId = randomUUID()
    const grandchildChatId = randomUUID()
    cleanup.push(rootChatId, childChatId, grandchildChatId)
    createChat(rootChatId)
    createChat(childChatId, {}, rootChatId)
    createChat(grandchildChatId, {}, childChatId)

    const result = await handleChatDelete({} as HandlerContext, { chatId: rootChatId })

    expect(new Set(result.deletedChatIds)).toEqual(
      new Set([rootChatId, childChatId, grandchildChatId]),
    )
    expect(getChat(rootChatId)).toBeUndefined()
    expect(getChat(childChatId)).toBeUndefined()
    expect(getChat(grandchildChatId)).toBeUndefined()
  })

  it('cascades every branch root in the same task family when the original is deleted', async () => {
    const rootChatId = randomUUID()
    const continuationChatId = randomUUID()
    const detailChatId = randomUUID()
    const branchChildChatId = randomUUID()
    cleanup.push(rootChatId, continuationChatId, detailChatId, branchChildChatId)
    createChat(rootChatId)
    createChat(continuationChatId)
    createChat(detailChatId)
    createChat(branchChildChatId, {}, continuationChatId)

    const { task } = ensureConversationTask(rootChatId, {})
    const now = Date.now()
    getSoulDb().prepare(
      `INSERT INTO conversation_branches
       (branch_id, task_id, chat_id, kind, source_branch_id, runtime_snapshot_json, created_at, updated_at)
       VALUES (?, ?, ?, 'continuation', ?, '{}', ?, ?)`,
    ).run('family-continuation', task.taskId, continuationChatId, task.activeBranchId, now, now)
    getSoulDb().prepare(
      `INSERT INTO conversation_branches
       (branch_id, task_id, chat_id, kind, source_branch_id, runtime_snapshot_json, created_at, updated_at)
       VALUES (?, ?, ?, 'detail', ?, '{}', ?, ?)`,
    ).run('family-detail', task.taskId, detailChatId, task.activeBranchId, now, now)

    const result = await handleChatDelete({} as HandlerContext, { chatId: rootChatId })

    expect(new Set(result.deletedChatIds)).toEqual(
      new Set([rootChatId, continuationChatId, detailChatId, branchChildChatId]),
    )
    expect(getChat(rootChatId)).toBeUndefined()
    expect(getChat(continuationChatId)).toBeUndefined()
    expect(getChat(detailChatId)).toBeUndefined()
    expect(getChat(branchChildChatId)).toBeUndefined()
    // 整条链路删除后分支表与任务表一并回收，无孤儿 task 行
    expect(listConversationBranches(task.taskId)).toHaveLength(0)
    expect(getConversationTask(task.taskId)).toBeUndefined()
  })

  it('cascades the whole family when deleting a branch root directly', async () => {
    const rootChatId = randomUUID()
    const continuationChatId = randomUUID()
    cleanup.push(rootChatId, continuationChatId)
    createChat(rootChatId)
    createChat(continuationChatId)
    const { task } = ensureConversationTask(rootChatId, {})
    const now = Date.now()
    getSoulDb().prepare(
      `INSERT INTO conversation_branches
       (branch_id, task_id, chat_id, kind, source_branch_id, runtime_snapshot_json, created_at, updated_at)
       VALUES (?, ?, ?, 'continuation', ?, '{}', ?, ?)`,
    ).run('family-continuation-b', task.taskId, continuationChatId, task.activeBranchId, now, now)

    const result = await handleChatDelete({} as HandlerContext, { chatId: continuationChatId })

    expect(new Set(result.deletedChatIds)).toEqual(new Set([rootChatId, continuationChatId]))
    expect(getChat(rootChatId)).toBeUndefined()
    expect(getChat(continuationChatId)).toBeUndefined()
  })

  it('leaves a never-branched root untouched by the family cascade', async () => {
    const rootChatId = randomUUID()
    const childChatId = randomUUID()
    cleanup.push(rootChatId, childChatId)
    createChat(rootChatId)
    createChat(childChatId, {}, rootChatId)

    expect(listBranchFamilyChatIds(rootChatId)).toEqual([])
    const result = await handleChatDelete({} as HandlerContext, { chatId: rootChatId })

    expect(new Set(result.deletedChatIds)).toEqual(new Set([rootChatId, childChatId]))
  })
})
