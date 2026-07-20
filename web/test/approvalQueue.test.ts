import { describe, expect, it } from 'vitest'
import { removeApprovalById } from '../src/stores/agents/actions/approvalActions'
import type { ApprovalState, StreamState } from '../src/stores/agents/types'

function approval(id: string): ApprovalState {
  return { approvalId: id, senseName: 'execute_command', waitTime: 1000, createdAt: 0 }
}

function makeStream(): StreamState {
  return {
    thinking: '',
    content: '',
    isWorking: false,
    history: [],
    historyLoaded: false,
    historyDirty: true,
    approval: approval('current'),
    approvalQueue: [approval('queued-1'), approval('queued-2')],
    questionBatches: [],
    runningTools: [],
  }
}

describe('approval queue removal', () => {
  it('expires the current approval and promotes the queue head', () => {
    const stream = makeStream()
    expect(removeApprovalById(stream, 'current')).toBe(true)
    expect(stream.approval?.approvalId).toBe('queued-1')
    expect(stream.approvalQueue.map((item) => item.approvalId)).toEqual(['queued-2'])
  })

  it('removes a queued approval without replacing the current item', () => {
    const stream = makeStream()
    expect(removeApprovalById(stream, 'queued-1')).toBe(true)
    expect(stream.approval?.approvalId).toBe('current')
    expect(stream.approvalQueue.map((item) => item.approvalId)).toEqual(['queued-2'])
  })
})
