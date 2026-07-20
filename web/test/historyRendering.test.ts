import { describe, expect, it } from 'vitest'
import { dedupHistoryByMsgId } from '../src/stores/agents/data/historyMerge'
import {
  accumulateStaged,
  shouldAccumulateStagedHistory,
} from '../src/stores/agents/data/streamAccumulator'
import type { HistoryItem, StreamState } from '../src/stores/agents/types'

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

describe('history rendering guards', () => {
  it('does not treat live staged chunks as replay history', () => {
    expect(shouldAccumulateStagedHistory('run-1')).toBe(false)
    expect(shouldAccumulateStagedHistory(undefined)).toBe(true)
  })

  it('rebuilds replay thinking and content into one message', () => {
    const stream = makeStream()
    accumulateStaged(stream, {
      type: 'thinking_end',
      role: 'assistant',
      thinking: 'reasoning',
      msgId: 'message-1',
      createdAt: 10,
    })
    accumulateStaged(stream, {
      type: 'content_end',
      role: 'assistant',
      content: 'answer',
      msgId: 'message-1',
      createdAt: 10,
    })

    expect(stream.history).toHaveLength(1)
    expect(stream.history[0]).toMatchObject({ thinking: 'reasoning', content: 'answer' })
  })

  it('merges done and replay projections without mutating inputs', () => {
    const input: HistoryItem[] = [
      { role: 'assistant', content: '', thinking: 'think', msgId: 'message-1', createdAt: 20 },
      { role: 'assistant', content: 'final answer', msgId: 'message-1', createdAt: 22 },
    ]
    const before = structuredClone(input)
    const result = dedupHistoryByMsgId(input)

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ thinking: 'think', content: 'final answer', createdAt: 20 })
    expect(input).toEqual(before)
  })
})
