import type { QuestionBatchState, QuestionItemState, StreamState } from './types'

export interface QuestionBatchPayload {
  batchId: string
  assistantMessageId: string
  createdAt: number
  questions: Array<{
    questionId: string
    position: number
    question: string
    header?: string
    options: Array<{ label: string; description?: string }>
    multiSelect: boolean
    createdAt: number
  }>
}

function toBatchState(
  payload: QuestionBatchPayload,
  previous?: QuestionBatchState,
): QuestionBatchState {
  const previousItems = new Map(
    previous?.questions.map((question) => [question.questionId, question]),
  )
  return {
    batchId: payload.batchId,
    assistantMessageId: payload.assistantMessageId,
    createdAt: payload.createdAt,
    status: previous?.status ?? 'pending',
    questions: [...payload.questions]
      .sort((a, b) => a.position - b.position)
      .map((question): QuestionItemState => {
        const old = previousItems.get(question.questionId)
        return {
          ...question,
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

export function flattenQuestionItems(stream: StreamState | undefined): QuestionItemState[] {
  return stream?.questionBatches.flatMap((batch) => batch.questions) ?? []
}

export function findQuestion(
  stream: StreamState | undefined,
  questionId: string | undefined,
): { batch: QuestionBatchState; question: QuestionItemState } | undefined {
  if (!stream || !questionId) return undefined
  for (const batch of stream.questionBatches) {
    const question = batch.questions.find((item) => item.questionId === questionId)
    if (question) return { batch, question }
  }
  return undefined
}

export function ensureActiveQuestion(stream: StreamState): void {
  if (findQuestion(stream, stream.activeQuestionId)) return
  stream.activeQuestionId =
    stream.questionBatches
      .flatMap((batch) => batch.questions)
      .find((question) => question.localStatus === 'pending')?.questionId ??
    stream.questionBatches[0]?.questions[0]?.questionId
}

/** Snapshot is authoritative: batches absent from it are removed, while matching local drafts survive. */
export function replaceQuestionBatches(
  stream: StreamState,
  payloads: QuestionBatchPayload[],
): void {
  const previous = new Map(stream.questionBatches.map((batch) => [batch.batchId, batch]))
  stream.questionBatches = payloads
    .map((payload) => toBatchState(payload, previous.get(payload.batchId)))
    .sort((a, b) => a.createdAt - b.createdAt)
  ensureActiveQuestion(stream)
}

export function upsertQuestionBatch(stream: StreamState, payload: QuestionBatchPayload): void {
  const index = stream.questionBatches.findIndex((batch) => batch.batchId === payload.batchId)
  const next = toBatchState(payload, index >= 0 ? stream.questionBatches[index] : undefined)
  if (index >= 0) stream.questionBatches.splice(index, 1, next)
  else stream.questionBatches.push(next)
  stream.questionBatches.sort((a, b) => a.createdAt - b.createdAt)
  ensureActiveQuestion(stream)
}

export function removeQuestionBatch(stream: StreamState, batchId: string): void {
  stream.questionBatches = stream.questionBatches.filter((batch) => batch.batchId !== batchId)
  ensureActiveQuestion(stream)
}
