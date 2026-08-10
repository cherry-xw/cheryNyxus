import { getMonthlyDb, getSoulDb } from './index.js'
import { safeJsonParse } from '@/utils/json.js'

export const LEGACY_QUESTION_PLACEHOLDER = '(等待用户回答…)'

export interface QuestionOption {
  label: string
  description?: string
}

export interface QuestionBatchItemInput {
  questionId: string
  question: string
  header?: string
  options: QuestionOption[]
  multiSelect: boolean
  createdAt: number
}

export interface PendingQuestionItemSnapshot extends QuestionBatchItemInput {
  position: number
}

export interface PendingQuestionBatchSnapshot {
  batchId: string
  assistantMessageId: string
  createdAt: number
  questions: PendingQuestionItemSnapshot[]
}

export interface QuestionStateSnapshot {
  snapshotSeq: number
  pendingQuestionBatches: PendingQuestionBatchSnapshot[]
}

export interface QuestionBatchAnswerInput {
  questionId: string
  selectedLabels: string[]
  freeText?: string
  cancelled?: boolean
}

export interface CompletedQuestionBatch {
  batchId: string
  chatId: string
  alreadyCompleted: boolean
  answers: Array<{
    questionId: string
    answerText: string
    cancelled: boolean
  }>
}

interface QuestionBatchRow {
  batch_id: string
  chat_id: string
  assistant_message_id: string
  status: 'pending' | 'completed'
  created_at: number
  completed_at: number | null
}

interface QuestionItemRow {
  question_id: string
  batch_id: string
  position: number
  question: string
  header: string | null
  options_json: string
  multi_select: number
  status: 'pending' | 'answered' | 'cancelled'
  answer_json: string | null
  answer_text: string | null
  created_at: number
  answered_at: number | null
}

interface LegacyMessageRow {
  id: string
  role: string
  content: string | null
  sense_calls: string | null
  revoked: number
  created_at: number
}

function monthlyDbForChat(chatId: string) {
  const chat = getSoulDb().prepare('SELECT messages_month FROM chats WHERE id = ?').get(chatId) as
    { messages_month: string } | undefined
  if (!chat) throw new Error(`Chat ${chatId} not found`)
  return getMonthlyDb(chat.messages_month)
}

function normalizeOptions(value: unknown): QuestionOption[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((option) => {
    if (!option || typeof option !== 'object') return []
    const raw = option as { label?: unknown; description?: unknown }
    if (typeof raw.label !== 'string' || !raw.label.trim()) return []
    return [
      {
        label: raw.label,
        ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
      },
    ]
  })
}

function parseQuestionArguments(
  argumentsJson: string,
): Omit<QuestionBatchItemInput, 'questionId' | 'createdAt'> | null {
  const args = safeJsonParse<Record<string, unknown> | null>(argumentsJson, null)
  if (!args || typeof args.question !== 'string') return null
  const options = normalizeOptions(args.options)
  if (options.length === 0) return null
  return {
    question: args.question,
    ...(typeof args.header === 'string' ? { header: args.header } : {}),
    options,
    multiSelect: args.multiSelect === true,
  }
}

function insertQuestionBatch(
  db: ReturnType<typeof getMonthlyDb>,
  chatId: string,
  assistantMessageId: string,
  questions: QuestionBatchItemInput[],
): void {
  if (questions.length === 0) return
  const createdAt = Math.min(...questions.map((question) => question.createdAt))
  db.prepare(
    `INSERT INTO question_batches
      (batch_id, chat_id, assistant_message_id, status, created_at)
     VALUES (?, ?, ?, 'pending', ?)
     ON CONFLICT(batch_id) DO NOTHING`,
  ).run(assistantMessageId, chatId, assistantMessageId, createdAt)

  const batch = db
    .prepare('SELECT status FROM question_batches WHERE batch_id = ? AND chat_id = ?')
    .get(assistantMessageId, chatId) as { status: string } | undefined
  if (!batch || batch.status !== 'pending') return

  const insertItem = db.prepare(
    `INSERT INTO question_items
      (question_id, batch_id, position, question, header, options_json, multi_select, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
     ON CONFLICT(question_id) DO UPDATE SET
       position = excluded.position,
       question = excluded.question,
       header = excluded.header,
       options_json = excluded.options_json,
       multi_select = excluded.multi_select
     WHERE question_items.status = 'pending'`,
  )
  questions.forEach((question, position) => {
    insertItem.run(
      question.questionId,
      assistantMessageId,
      position,
      question.question,
      question.header ?? null,
      JSON.stringify(question.options),
      question.multiSelect ? 1 : 0,
      question.createdAt,
    )
  })
}

/** Persist one complete assistant question batch. The assistant message id is the durable batch id. */
export function createQuestionBatch(
  chatId: string,
  assistantMessageId: string,
  questions: QuestionBatchItemInput[],
): PendingQuestionBatchSnapshot | undefined {
  const db = monthlyDbForChat(chatId)
  const write = db.transaction(() => insertQuestionBatch(db, chatId, assistantMessageId, questions))
  write()
  return getPendingQuestionBatches(chatId).find((batch) => batch.batchId === assistantMessageId)
}

/**
 * One-time compatibility bridge for conversations created before question batches were persisted.
 * Only assistant calls whose sense result is still the legacy placeholder are recovered.
 */
export function backfillLegacyPendingQuestionBatches(chatId: string): void {
  const db = monthlyDbForChat(chatId)
  const migrated = db
    .prepare('SELECT legacy_backfill_version FROM question_projection_meta WHERE chat_id = ?')
    .get(chatId) as { legacy_backfill_version: number } | undefined
  if ((migrated?.legacy_backfill_version ?? 0) >= 1) return

  const backfill = db.transaction(() => {
    const messages = db
      .prepare(
        'SELECT id, role, content, sense_calls, revoked, created_at FROM messages WHERE chat_id = ? ORDER BY created_at ASC',
      )
      .all(chatId) as LegacyMessageRow[]
    const senseById = new Map(
      messages
        .filter((message) => message.role === 'sense' && message.revoked === 0)
        .map((message) => [message.id, message]),
    )

    for (const assistant of messages) {
      if (assistant.role !== 'assistant' || assistant.revoked !== 0 || !assistant.sense_calls)
        continue
      const exists = db
        .prepare('SELECT 1 FROM question_batches WHERE batch_id = ? AND chat_id = ?')
        .get(assistant.id, chatId)
      if (exists) continue

      const calls = safeJsonParse<Array<{ id?: unknown; name?: unknown; arguments?: unknown }>>(
        assistant.sense_calls,
        [],
      )
      const pending: QuestionBatchItemInput[] = []
      for (const call of calls) {
        if (
          call.name !== 'ask_user_question' ||
          typeof call.id !== 'string' ||
          typeof call.arguments !== 'string'
        )
          continue
        const sense = senseById.get(call.id)
        if (!sense || sense.content !== LEGACY_QUESTION_PLACEHOLDER) continue
        const parsed = parseQuestionArguments(call.arguments)
        if (!parsed) continue
        pending.push({
          questionId: call.id,
          ...parsed,
          createdAt: assistant.created_at,
        })
      }
      if (pending.length > 0) insertQuestionBatch(db, chatId, assistant.id, pending)
    }
    db.prepare(
      `INSERT INTO question_projection_meta (chat_id, legacy_backfill_version)
       VALUES (?, 1)
       ON CONFLICT(chat_id) DO UPDATE SET legacy_backfill_version = excluded.legacy_backfill_version`,
    ).run(chatId)
  })
  backfill()
}

function readPendingQuestionBatches(
  db: ReturnType<typeof getMonthlyDb>,
  chatId: string,
): PendingQuestionBatchSnapshot[] {
  const batches = db
    .prepare(
      `SELECT batch_id, chat_id, assistant_message_id, status, created_at, completed_at
     FROM question_batches
     WHERE chat_id = ? AND status = 'pending'
     ORDER BY created_at ASC`,
    )
    .all(chatId) as QuestionBatchRow[]
  const readItems = db.prepare(
    `SELECT question_id, batch_id, position, question, header, options_json, multi_select,
            status, answer_json, answer_text, created_at, answered_at
     FROM question_items
     WHERE batch_id = ? AND status = 'pending'
     ORDER BY position ASC`,
  )
  return batches.flatMap((batch) => {
    const items = readItems.all(batch.batch_id) as QuestionItemRow[]
    if (items.length === 0) return []
    return [
      {
        batchId: batch.batch_id,
        assistantMessageId: batch.assistant_message_id,
        createdAt: batch.created_at,
        questions: items.map((item) => ({
          questionId: item.question_id,
          position: item.position,
          question: item.question,
          ...(item.header ? { header: item.header } : {}),
          options: safeJsonParse<QuestionOption[]>(item.options_json, []),
          multiSelect: item.multi_select === 1,
          createdAt: item.created_at,
        })),
      },
    ]
  })
}

export function getPendingQuestionBatches(chatId: string): PendingQuestionBatchSnapshot[] {
  backfillLegacyPendingQuestionBatches(chatId)
  return readPendingQuestionBatches(monthlyDbForChat(chatId), chatId)
}

/** Read the question projection and its event cursor in one SQLite snapshot. */
export function getQuestionStateSnapshot(chatId: string): QuestionStateSnapshot {
  backfillLegacyPendingQuestionBatches(chatId)
  const db = monthlyDbForChat(chatId)
  const read = db.transaction(() => {
    const seq = db
      .prepare(
        'SELECT COALESCE(MAX(chat_seq), 0) AS snapshotSeq FROM chat_events WHERE chat_id = ?',
      )
      .get(chatId) as { snapshotSeq: number }
    return {
      snapshotSeq: seq.snapshotSeq,
      pendingQuestionBatches: readPendingQuestionBatches(db, chatId),
    }
  })
  return read()
}

export function hasPendingQuestionBatches(chatId: string): boolean {
  backfillLegacyPendingQuestionBatches(chatId)
  const db = monthlyDbForChat(chatId)
  return Boolean(
    db
      .prepare("SELECT 1 FROM question_batches WHERE chat_id = ? AND status = 'pending' LIMIT 1")
      .get(chatId),
  )
}

export function getPendingQuestionAttention(chatId: string): Array<{
  batchId: string
  questionId: string
  header?: string
  question: string
  createdAt: number
}> {
  backfillLegacyPendingQuestionBatches(chatId)
  const db = monthlyDbForChat(chatId)
  const rows = db
    .prepare(
      `SELECT qi.batch_id, qi.question_id, qi.header, qi.question, qi.created_at
       FROM question_items qi
       JOIN question_batches qb ON qb.batch_id = qi.batch_id
       WHERE qb.chat_id = ? AND qb.status = 'pending' AND qi.status = 'pending'
       ORDER BY qi.created_at ASC, qi.position ASC`,
    )
    .all(chatId) as Array<{
      batch_id: string
      question_id: string
      header: string | null
      question: string
      created_at: number
    }>
  return rows.map((row) => ({
    batchId: row.batch_id,
    questionId: row.question_id,
    ...(row.header ? { header: row.header } : {}),
    question: row.question.slice(0, 160),
    createdAt: row.created_at,
  }))
}

function normalizeAnswer(
  item: QuestionItemRow,
  answer: QuestionBatchAnswerInput,
): {
  answerText: string
  answerJson: string
  status: 'answered' | 'cancelled'
} {
  const selectedLabels = [...new Set(answer.selectedLabels)]
  const freeText = answer.freeText?.trim()
  const cancelled = answer.cancelled === true
  const options = safeJsonParse<QuestionOption[]>(item.options_json, [])
  const allowed = new Set(options.map((option) => option.label))

  if (selectedLabels.some((label) => !allowed.has(label))) {
    throw new Error(`Question "${item.question_id}" contains an unknown option`)
  }
  if (!item.multi_select && selectedLabels.length > 1) {
    throw new Error(`Question "${item.question_id}" is single-select`)
  }
  if (!cancelled && selectedLabels.length === 0 && !freeText) {
    throw new Error(`Question "${item.question_id}" has no answer`)
  }

  const answerText = cancelled
    ? '(用户取消了此问题)'
    : `用户回答: ${[...selectedLabels, ...(freeText ? [`其他: ${freeText}`] : [])].join(', ')}`
  return {
    answerText,
    answerJson: JSON.stringify({
      selectedLabels,
      ...(freeText ? { freeText } : {}),
      ...(cancelled ? { cancelled: true } : {}),
    }),
    status: cancelled ? 'cancelled' : 'answered',
  }
}

/** Validate and complete every still-pending item in one batch transaction. */
export function completeQuestionBatch(
  chatId: string,
  batchId: string,
  answers: QuestionBatchAnswerInput[],
): CompletedQuestionBatch {
  backfillLegacyPendingQuestionBatches(chatId)
  const db = monthlyDbForChat(chatId)
  const complete = db.transaction((): CompletedQuestionBatch => {
    const batch = db
      .prepare('SELECT * FROM question_batches WHERE batch_id = ? AND chat_id = ?')
      .get(batchId, chatId) as QuestionBatchRow | undefined
    if (!batch) throw new Error(`Question batch "${batchId}" not found`)
    if (batch.status === 'completed') {
      return { batchId, chatId, alreadyCompleted: true, answers: [] }
    }

    const items = db
      .prepare(
        "SELECT * FROM question_items WHERE batch_id = ? AND status = 'pending' ORDER BY position ASC",
      )
      .all(batchId) as QuestionItemRow[]
    const answerById = new Map<string, QuestionBatchAnswerInput>()
    for (const answer of answers) {
      if (answerById.has(answer.questionId))
        throw new Error(`Duplicate answer for question "${answer.questionId}"`)
      answerById.set(answer.questionId, answer)
    }
    if (
      answerById.size !== items.length ||
      items.some((item) => !answerById.has(item.question_id))
    ) {
      throw new Error(`Question batch "${batchId}" requires answers for every pending question`)
    }

    const completedAt = Date.now()
    const completedAnswers = items.map((item) => {
      const answer = answerById.get(item.question_id)!
      const normalized = normalizeAnswer(item, answer)
      const messageUpdate = db
        .prepare("UPDATE messages SET content = ? WHERE id = ? AND chat_id = ? AND role = 'sense'")
        .run(normalized.answerText, item.question_id, chatId)
      if (messageUpdate.changes !== 1) {
        throw new Error(
          `Sense message "${item.question_id}" was not found for question batch "${batchId}"`,
        )
      }
      const itemUpdate = db
        .prepare(
          `UPDATE question_items
         SET status = ?, answer_json = ?, answer_text = ?, answered_at = ?
         WHERE question_id = ? AND batch_id = ? AND status = 'pending'`,
        )
        .run(
          normalized.status,
          normalized.answerJson,
          normalized.answerText,
          completedAt,
          item.question_id,
          batchId,
        )
      if (itemUpdate.changes !== 1)
        throw new Error(`Question "${item.question_id}" is no longer pending`)
      return {
        questionId: item.question_id,
        answerText: normalized.answerText,
        cancelled: normalized.status === 'cancelled',
      }
    })

    const batchUpdate = db
      .prepare(
        "UPDATE question_batches SET status = 'completed', completed_at = ? WHERE batch_id = ? AND status = 'pending'",
      )
      .run(completedAt, batchId)
    if (batchUpdate.changes !== 1)
      throw new Error(`Question batch "${batchId}" is no longer pending`)
    return { batchId, chatId, alreadyCompleted: false, answers: completedAnswers }
  })
  return complete()
}

export function findPendingQuestionBatchByQuestionId(
  questionId: string,
): { chatId: string; batchId: string; pendingCount: number } | undefined {
  const chats = getSoulDb().prepare('SELECT id, messages_month FROM chats').all() as Array<{
    id: string
    messages_month: string
  }>
  for (const chat of chats) {
    backfillLegacyPendingQuestionBatches(chat.id)
    const db = getMonthlyDb(chat.messages_month)
    const row = db
      .prepare(
        `SELECT b.chat_id AS chatId, b.batch_id AS batchId,
        (SELECT COUNT(*) FROM question_items pending
         WHERE pending.batch_id = b.batch_id AND pending.status = 'pending') AS pendingCount
       FROM question_items i
       JOIN question_batches b ON b.batch_id = i.batch_id
       WHERE i.question_id = ? AND i.status = 'pending' AND b.status = 'pending'`,
      )
      .get(questionId) as { chatId: string; batchId: string; pendingCount: number } | undefined
    if (row) return row
  }
  return undefined
}
