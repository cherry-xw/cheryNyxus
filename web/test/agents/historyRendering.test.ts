import { describe, expect, it } from 'vitest'
import { accumulateStaged } from '../../src/stores/agents/data/streamAccumulator'
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

describe('history rendering guards', () => {
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
})
