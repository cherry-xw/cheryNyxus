/**
 * question 僵尸批清扫单测：batch pending 但零 pending item → 读时自愈标 completed。
 *
 * 契约（docs/interaction.md「提问态与继续的关系」）：
 *  - 孤立 pending 批（status='pending' 但零 status='pending' 的 item）视为僵尸，
 *    会被读时自愈清扫标 completed，不再阻塞 canResume（防"无卡片无按钮"硬死锁）。
 *  - 健康批（有 pending item）不被清扫。
 *  - sweepOrphanQuestionBatches 返回清扫批数；sweepOrphanQuestionBatchesAcrossRoots 跨所有 chat 清扫。
 *
 * 与 chatRecovery.test.ts 同款模式：复用 test/flows/fixtures 的真实 db（setup.ts 启动时清理），
 * afterEach 逐 chat 删除自愈。问题数据按 UUID key，无跨文件碰撞。
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createChat, deleteChat } from '@/db/chat.js'
import { getMonthlyDb, getSoulDb } from '@/db/index.js'
import {
  createQuestionBatch,
  getPendingQuestionBatches,
  hasPendingQuestionBatches,
  sweepOrphanQuestionBatches,
  sweepOrphanQuestionBatchesAcrossRoots,
} from '@/db/question.js'
import type { QuestionBatchItemInput } from '@/db/question.js'

const cleanupChats: string[] = []

afterEach(() => {
  for (const chatId of cleanupChats.splice(0).reverse()) deleteChat(chatId)
})

function newChatId(): string {
  const chatId = randomUUID()
  cleanupChats.push(chatId)
  return chatId
}

function makeQuestion(questionId: string, text = '是否继续？'): QuestionBatchItemInput {
  return {
    questionId,
    question: text,
    header: '等待确认',
    options: [{ label: '是' }, { label: '否' }],
    multiSelect: false,
    createdAt: Date.now(),
  }
}

/** 直接造孤儿批：batch 仍 pending，但把全部 item 置为非 pending（模拟中途被消费/中断的卡死态）。 */
function makeOrphanBatch(chatId: string, batchId: string): void {
  createQuestionBatch(chatId, batchId, [makeQuestion(`${batchId}:q1`)])
  getMonthlyDbFor(chatId)
    .prepare("UPDATE question_items SET status = 'answered' WHERE batch_id = ?")
    .run(batchId)
}

function getMonthlyDbFor(chatId: string) {
  const chat = getSoulDb()
    .prepare('SELECT messages_month FROM chats WHERE id = ?')
    .get(chatId) as { messages_month: string }
  return getMonthlyDb(chat.messages_month)
}

function batchStatus(chatId: string, batchId: string): string {
  const row = getMonthlyDbFor(chatId)
    .prepare('SELECT status FROM question_batches WHERE batch_id = ? AND chat_id = ?')
    .get(batchId, chatId) as { status: string } | undefined
  return row?.status ?? '(missing)'
}

describe('question 僵尸批清扫', () => {
  it('健康 pending 批（含 pending item）不被清扫', () => {
    const chatId = newChatId()
    createChat(chatId)
    const batchId = randomUUID()
    createQuestionBatch(chatId, batchId, [makeQuestion(`${batchId}:q1`)])

    expect(hasPendingQuestionBatches(chatId)).toBe(true)
    expect(sweepOrphanQuestionBatches(chatId)).toBe(0)
    expect(getPendingQuestionBatches(chatId).map((b) => b.batchId)).toEqual([batchId])
    expect(batchStatus(chatId, batchId)).toBe('pending')
  })

  it('孤儿批（pending 但零 pending item）被 sweep 标 completed 并返回计数', () => {
    const chatId = newChatId()
    createChat(chatId)
    const batchId = randomUUID()
    makeOrphanBatch(chatId, batchId)

    // 清扫前确认孤儿态真实存在（原始查询不触发自愈）
    const orphan = getMonthlyDbFor(chatId)
      .prepare(
        `SELECT 1 FROM question_batches b
         WHERE b.batch_id = ? AND b.status = 'pending'
           AND NOT EXISTS (
             SELECT 1 FROM question_items i
             WHERE i.batch_id = b.batch_id AND i.status = 'pending'
           )`,
      )
      .get(batchId) as { 1: number } | undefined
    expect(orphan).toBeDefined()

    expect(sweepOrphanQuestionBatches(chatId)).toBe(1)
    expect(batchStatus(chatId, batchId)).toBe('completed')
    expect(hasPendingQuestionBatches(chatId)).toBe(false)
  })

  it('读时自愈：孤儿批经 hasPendingQuestionBatches 直接收敛，不再阻塞 canResume', () => {
    const chatId = newChatId()
    createChat(chatId)
    const batchId = randomUUID()
    makeOrphanBatch(chatId, batchId)

    // 不先调 sweep，直接走 hasPendingQuestionBatches 读路径 → 内部自愈
    expect(hasPendingQuestionBatches(chatId)).toBe(false)
    expect(batchStatus(chatId, batchId)).toBe('completed')
  })

  it('孤儿批 + 健康批共存：仅清扫孤儿，健康批保持 pending', () => {
    const chatId = newChatId()
    createChat(chatId)
    const orphanId = randomUUID()
    const healthyId = randomUUID()
    // 先建健康批（createQuestionBatch 内部读 pending 批会触发读时自愈，故孤儿须后造，避免被提前清扫）
    createQuestionBatch(chatId, healthyId, [makeQuestion(`${healthyId}:q1`)])
    makeOrphanBatch(chatId, orphanId)

    expect(sweepOrphanQuestionBatches(chatId)).toBe(1)
    expect(batchStatus(chatId, orphanId)).toBe('completed')
    expect(batchStatus(chatId, healthyId)).toBe('pending')
    expect(hasPendingQuestionBatches(chatId)).toBe(true)
  })

  it('sweepOrphanQuestionBatchesAcrossRoots 跨所有 chat 清扫并返回总数', () => {
    const chatIdA = newChatId()
    const chatIdB = newChatId()
    createChat(chatIdA)
    createChat(chatIdB)
    makeOrphanBatch(chatIdA, randomUUID())
    makeOrphanBatch(chatIdB, randomUUID())

    expect(sweepOrphanQuestionBatchesAcrossRoots()).toBe(2)
    expect(hasPendingQuestionBatches(chatIdA)).toBe(false)
    expect(hasPendingQuestionBatches(chatIdB)).toBe(false)
  })
})
