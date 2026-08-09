import { describe, expect, it } from 'vitest'
import {
  ensureActiveQuestion,
  findQuestion,
  replaceQuestionBatches,
  type QuestionBatchPayload,
} from '../../src/stores/agents/actions/questionBatch'
import type { StreamState } from '../../src/stores/agents/types'

function stream(): StreamState {
  return {
    thinking: '',
    content: '',
    isWorking: false,
    history: [],
    historyLoaded: false,
    historyDirty: true,
    approvalQueue: [],
    questionBatches: [],
    runningTools: [],
  }
}

function batch(): QuestionBatchPayload {
  return {
    batchId: 'batch-1',
    assistantMessageId: 'assistant-1',
    createdAt: 1,
    questions: [
      {
        questionId: 'q2',
        position: 1,
        question: 'second',
        options: [],
        multiSelect: true,
        createdAt: 2,
      },
      {
        questionId: 'q1',
        position: 0,
        question: 'first',
        options: [],
        multiSelect: false,
        createdAt: 1,
      },
    ],
  }
}

describe('question batch projection', () => {
  it('sorts questions and selects the first pending question', () => {
    const state = stream()
    replaceQuestionBatches(state, [batch()])

    expect(state.questionBatches[0]?.questions.map((q) => q.questionId)).toEqual(['q1', 'q2'])
    expect(state.activeQuestionId).toBe('q1')
    expect(findQuestion(state, 'q2')?.question.multiSelect).toBe(true)
  })

  it('preserves local answers across an authoritative refresh and advances focus', () => {
    const state = stream()
    replaceQuestionBatches(state, [batch()])
    const first = state.questionBatches[0]!.questions[0]!
    first.localStatus = 'ready'
    first.draftAnswer = { selectedLabels: ['yes'] }
    state.activeQuestionId = undefined

    replaceQuestionBatches(state, [batch()])
    ensureActiveQuestion(state)

    expect(state.questionBatches[0]!.questions[0]!.draftAnswer?.selectedLabels).toEqual(['yes'])
    expect(state.activeQuestionId).toBe('q2')
  })
})
