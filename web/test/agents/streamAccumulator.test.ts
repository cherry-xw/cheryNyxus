import { describe, expect, it } from 'vitest'
import { accumulateStaged } from '../../src/stores/agents/data/streamAccumulator'
import { replaceQuestionBatches } from '../../src/stores/agents/actions/questionBatch'
import type { StreamState } from '../../src/stores/agents/types'

function makeStream(): StreamState {
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

describe('question recovery projection', () => {
  it('keeps the ask call in history and restores interaction from the authoritative batch', () => {
    const stream = makeStream()
    accumulateStaged(stream, {
      type: 'thinking_end',
      role: 'assistant',
      thinking: 'asking',
      msgId: 'assistant-turn-1',
      createdAt: 100,
    })
    accumulateStaged(stream, {
      type: 'sense_end',
      role: 'assistant',
      msgId: 'assistant-turn-1',
      id: 'question-1',
      senseName: 'ask_user_question',
      arguments: JSON.stringify({ question: 'Continue?', options: [{ label: 'Yes' }] }),
    })
    replaceQuestionBatches(stream, [
      {
        batchId: 'batch-1',
        assistantMessageId: 'assistant-turn-1',
        createdAt: 100,
        questions: [
          {
            questionId: 'question-1',
            position: 0,
            question: 'Continue?',
            options: [{ label: 'Yes' }],
            multiSelect: false,
            createdAt: 100,
          },
        ],
      },
    ])

    expect(stream.history[0]?.senseCalls?.[0]).toMatchObject({
      id: 'question-1',
      name: 'ask_user_question',
    })
    expect(stream.activeQuestionId).toBe('question-1')
  })
})
