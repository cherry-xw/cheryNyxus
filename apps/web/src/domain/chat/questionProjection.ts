import type { QuestionBatchState, QuestionItemState } from './projectionTypes'

export interface QuestionProjectionSource {
  questionBatches: QuestionBatchState[]
  activeQuestionId?: string
}

export function flattenQuestionItems(
  source: QuestionProjectionSource | undefined,
): QuestionItemState[] {
  return source?.questionBatches.flatMap((batch) => batch.questions) ?? []
}

export function findQuestion(
  source: QuestionProjectionSource | undefined,
  questionId: string | undefined,
): { batch: QuestionBatchState; question: QuestionItemState } | undefined {
  if (!source || !questionId) return undefined
  for (const batch of source.questionBatches) {
    const question = batch.questions.find((item) => item.questionId === questionId)
    if (question) return { batch, question }
  }
  return undefined
}
