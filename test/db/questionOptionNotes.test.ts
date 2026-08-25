/**
 * question 每选项补充描述（optionNotes）单测：契约与持久化。
 *
 * 需求：单选/多选每个选项在选中后都可附加一段补充描述（label → note）。
 * 契约：
 *  - QuestionBatchAnswerInput 新增可选 optionNotes（Record<label, note>），向后兼容（旧字段 selectedLabels 仍 string[]）。
 *  - normalizeAnswer 仅保留「已选且非空白」的 note；取消选中的选项 note 被丢弃。
 *  - answerText 以「label（补充: note）」拼接；answerJson 持久化 optionNotes。
 *  - 未传 optionNotes 的旧答案路径保持原行为（无 note 拼接）。
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { addMessage, createChat, deleteChat } from '@/db/chat.js'
import { getMonthlyDb, getSoulDb } from '@/db/index.js'
import { completeQuestionBatch, createQuestionBatch } from '@/db/question.js'
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

function getMonthlyDbFor(chatId: string) {
  const chat = getSoulDb().prepare('SELECT messages_month FROM chats WHERE id = ?').get(chatId) as {
    messages_month: string
  }
  return getMonthlyDb(chat.messages_month)
}

function makeQuestion(
  questionId: string,
  multiSelect: boolean,
  labels: string[],
): QuestionBatchItemInput {
  return {
    questionId,
    question: '请选择',
    options: labels.map((label) => ({ label })),
    multiSelect,
    createdAt: Date.now(),
  }
}

/** completeQuestionBatch 会 UPDATE messages（role='sense'）落答案文本，故须先插 sense 消息。 */
function insertSenseMessages(chatId: string, questionIds: string[]): void {
  for (const questionId of questionIds) {
    addMessage(questionId, chatId, { role: 'sense', content: '(等待用户回答…)' })
  }
}

function answerRow(chatId: string, questionId: string) {
  return getMonthlyDbFor(chatId)
    .prepare('SELECT answer_json, answer_text, status FROM question_items WHERE question_id = ?')
    .get(questionId) as { answer_json: string; answer_text: string; status: string }
}

describe('question 每选项补充描述（optionNotes）', () => {
  it('多选：已选选项的 note 持久化到 answerJson 并拼接进 answerText', () => {
    const chatId = newChatId()
    createChat(chatId)
    const batchId = randomUUID()
    const qId = `${batchId}:q1`
    createQuestionBatch(chatId, batchId, [makeQuestion(qId, true, ['甲', '乙', '丙'])])
    insertSenseMessages(chatId, [qId])

    completeQuestionBatch(chatId, batchId, [
      {
        questionId: qId,
        selectedLabels: ['甲', '乙'],
        optionNotes: { 甲: 'A 补充', 乙: '  B 补充  ', 丙: '未选不该留' },
      },
    ])

    const row = answerRow(chatId, qId)
    expect(row.status).toBe('answered')
    const json = JSON.parse(row.answer_json)
    expect(json.selectedLabels).toEqual(['甲', '乙'])
    expect(json.optionNotes).toEqual({ 甲: 'A 补充', 乙: 'B 补充' })
    expect(row.answer_text).toBe('用户回答: 甲（补充: A 补充）, 乙（补充: B 补充）')
    // 未选选项的 note 被丢弃
    expect(json.optionNotes['丙']).toBeUndefined()
  })

  it('单选：单选项 note 持久化；切到其他选项后旧 note 不残留（前端已清理，后端按已选过滤）', () => {
    const chatId = newChatId()
    createChat(chatId)
    const batchId = randomUUID()
    const qId = `${batchId}:q1`
    createQuestionBatch(chatId, batchId, [makeQuestion(qId, false, ['是', '否'])])
    insertSenseMessages(chatId, [qId])

    completeQuestionBatch(chatId, batchId, [
      {
        questionId: qId,
        selectedLabels: ['否'],
        optionNotes: { 是: '旧选择补充', 否: 'N 补充' },
      },
    ])

    const row = answerRow(chatId, qId)
    const json = JSON.parse(row.answer_json)
    expect(json.selectedLabels).toEqual(['否'])
    expect(json.optionNotes).toEqual({ 否: 'N 补充' })
    expect(row.answer_text).toBe('用户回答: 否（补充: N 补充）')
  })

  it('空白 note 与未传 optionNotes 的旧路径均不产出 optionNotes 字段', () => {
    const chatId = newChatId()
    createChat(chatId)
    const batchId = randomUUID()
    const qA = `${batchId}:qA`
    const qB = `${batchId}:qB`
    createQuestionBatch(chatId, batchId, [
      makeQuestion(qA, false, ['是', '否']),
      makeQuestion(qB, false, ['红', '蓝']),
    ])
    insertSenseMessages(chatId, [qA, qB])

    completeQuestionBatch(chatId, batchId, [
      { questionId: qA, selectedLabels: ['是'], optionNotes: { 是: '   ' } },
      { questionId: qB, selectedLabels: ['红'] },
    ])

    expect(JSON.parse(answerRow(chatId, qA).answer_json)).toEqual({ selectedLabels: ['是'] })
    expect(answerRow(chatId, qA).answer_text).toBe('用户回答: 是')
    expect(JSON.parse(answerRow(chatId, qB).answer_json)).toEqual({ selectedLabels: ['红'] })
    expect(answerRow(chatId, qB).answer_text).toBe('用户回答: 红')
  })
})
