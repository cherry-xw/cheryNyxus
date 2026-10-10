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

describe('compact history', () => {
  it('keeps the context-compaction marker on a staged assistant summary', () => {
    const stream = makeStream()
    accumulateStaged(stream, {
      type: 'content_end',
      role: 'assistant',
      content: 'compressed summary',
      msgId: 'compact-summary',
      contextCompaction: true,
      contextCompactionTokens: 128,
    })

    expect(stream.history).toEqual([
      expect.objectContaining({
        msgId: 'compact-summary',
        contextCompaction: true,
        contextCompactionTokens: 128,
      }),
    ])
  })
})
