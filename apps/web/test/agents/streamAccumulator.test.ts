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

describe('stream accumulation', () => {
  it('removes reversed history and clears only the matching live bubble', () => {
    const stream = makeStream()
    stream.activeMessageId = 'failed-turn'
    stream.thinking = 'discarded thought'
    stream.content = 'discarded partial'
    accumulateStaged(stream, {
      type: 'content_end',
      role: 'assistant',
      content: 'discarded partial',
      msgId: 'failed-turn',
      createdAt: 1,
    })

    accumulateStaged(stream, { type: 'reverse', messageIds: ['failed-turn'] })

    expect(stream.history).toEqual([])
    expect(stream.activeMessageId).toBeUndefined()
    expect(stream.thinking).toBe('')
    expect(stream.content).toBe('')
  })
})
