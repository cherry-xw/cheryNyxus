import type { ChatInteractionState } from '../../types'
import type { QuestionBatchPayload, QuestionBatchState } from '@/domain/chat/projectionTypes'

export function removeApprovalById(s: ChatInteractionState, approvalId: string): boolean {
  let removed = false
  if (s.approval?.approvalId === approvalId) {
    s.approval = undefined
    removed = true
  }
  const before = s.approvalQueue.length
  s.approvalQueue = s.approvalQueue.filter((a) => a.approvalId !== approvalId)
  if (s.approvalQueue.length !== before) removed = true
  if (!s.approval && s.approvalQueue.length > 0) s.approval = s.approvalQueue.shift()
  return removed
}

// ---- 问题批次（操作 ChatInteractionState）----

function toBatchState(
  payload: QuestionBatchPayload,
  previous?: QuestionBatchState,
): QuestionBatchState {
  const prevItems = new Map(previous?.questions.map((q) => [q.questionId, q]))
  return {
    batchId: payload.batchId,
    assistantMessageId: payload.assistantMessageId,
    createdAt: payload.createdAt,
    status: previous?.status ?? 'pending',
    questions: [...payload.questions]
      .sort((a, b) => a.position - b.position)
      .map((q) => {
        const old = prevItems.get(q.questionId)
        return {
          ...q,
          localStatus: old?.localStatus ?? 'pending',
          ...(old?.draftAnswer
            ? {
                draftAnswer: {
                  ...old.draftAnswer,
                  selectedLabels: [...old.draftAnswer.selectedLabels],
                },
              }
            : {}),
        }
      }),
  }
}

function ensureActiveQuestion(s: ChatInteractionState): void {
  const exists = s.questionBatches.some((b) =>
    b.questions.some((q) => q.questionId === s.activeQuestionId),
  )
  if (exists) return
  s.activeQuestionId =
    s.questionBatches.flatMap((b) => b.questions).find((q) => q.localStatus === 'pending')
      ?.questionId ?? s.questionBatches[0]?.questions[0]?.questionId
}

export function upsertQuestionBatch(s: ChatInteractionState, payload: QuestionBatchPayload): void {
  const idx = s.questionBatches.findIndex((b) => b.batchId === payload.batchId)
  const next = toBatchState(payload, idx >= 0 ? s.questionBatches[idx] : undefined)
  if (idx >= 0) s.questionBatches.splice(idx, 1, next)
  else s.questionBatches.push(next)
  s.questionBatches.sort((a, b) => a.createdAt - b.createdAt)
  ensureActiveQuestion(s)
}

export function removeQuestionBatch(s: ChatInteractionState, batchId: string): void {
  s.questionBatches = s.questionBatches.filter((b) => b.batchId !== batchId)
  ensureActiveQuestion(s)
}

export function replaceQuestionBatches(s: ChatInteractionState, payloads: QuestionBatchPayload[]): void {
  const prev = new Map(s.questionBatches.map((b) => [b.batchId, b]))
  s.questionBatches = payloads
    .map((p) => toBatchState(p, prev.get(p.batchId)))
    .sort((a, b) => a.createdAt - b.createdAt)
  ensureActiveQuestion(s)
}

