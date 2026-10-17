import { describe, expect, it } from 'vitest'
import { accumulateStaged, fillSenseResultInHistory } from '../../src/stores/agents/data/streamAccumulator'
import type { MessagePart } from '@chery/protocol'
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
  const parts: MessagePart[] = [{ type: 'asset', partId: 'output-1', assetId: 'asset-1', assetVersionId: 'version-1', variant: 'original', usage: 'content' }]

  it('preserves file-only results during replay and repeated live delivery', () => {
    const stream = makeStream()
    stream.history.push({ role: 'assistant', content: '', senseCalls: [{ id: 'call-1', name: 'generate', status: 'done' }] })
    accumulateStaged(stream, { type: 'content_end', role: 'sense', id: 'call-1', content: '', parts })
    expect(stream.history[0]?.senseCalls?.[0]?.parts).toEqual(parts)
    fillSenseResultInHistory(stream, 'call-1', '', { parts })
    expect(stream.history[0]?.senseCalls).toHaveLength(1)
    expect(stream.history[0]?.senseCalls?.[0]?.parts).toEqual(parts)
  })

  it('never attaches unmatched file results to another pending tool', () => {
    const stream = makeStream()
    stream.history.push({ role: 'assistant', content: '', senseCalls: [{ id: 'other-call', name: 'read', status: 'running' }] })
    accumulateStaged(stream, { type: 'content_end', role: 'sense', id: 'missing-call', content: '', parts })
    expect(stream.history[0]?.senseCalls?.[0]?.parts).toBeUndefined()
    expect(stream.history[0]?.senseCalls?.[0]?.result).toBeUndefined()
  })

  it.each(['user', 'assistant', 'role'] as const)('preserves ordered files in %s messages without interpreting URLs', (role) => {
    const stream = makeStream()
    const text = '/api/media/ordinary.png'
    const ordered: MessagePart[] = [{ type: 'text', partId: 'before', text }, ...parts, { type: 'text', partId: 'after', text: '之后' }]
    accumulateStaged(stream, { type: 'content_end', role, msgId: 'message', content: text })
    accumulateStaged(stream, { type: 'content_end', role, msgId: 'message', content: text, parts: ordered })
    expect(stream.history).toHaveLength(1)
    expect(stream.history[0]?.parts).toEqual(ordered)
    expect(stream.history[0]?.content).toBe(text)
    expect(stream.history[0]).not.toHaveProperty('mediaAssets')
  })

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
