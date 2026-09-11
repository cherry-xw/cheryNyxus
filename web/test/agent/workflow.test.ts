import { describe, expect, it } from 'vitest'
import {
  acceptWorkflow,
  replayFrames,
  replaySnapshot,
} from '../../src/features/agent/workbench/runtime-diagram/model'
import type { WorkflowFact, WorkflowSnapshot, WorkflowUpdated } from '@chery/protocol'
const base: WorkflowSnapshot = {
  chatId: 'root',
  rootChatId: 'root',
  contextStageId: 'root:start',
  status: 'running',
  revision: 0,
  visitedNodeIds: [],
  dispatches: [],
  resources: { loadedSkillsComplete: false },
  phaseKnown: false,
  historyComplete: false,
}
describe('workflow playback', () => {
  it('rejects stale, wrong window and old-stream frames', () => {
    const current: WorkflowUpdated = { subscriptionId: 'one', streamId: 'stream', snapshot: base }
    expect(acceptWorkflow(current, current, current, 'root')).toBe(false)
    const fresh = { ...current, snapshot: { ...base, revision: 1 } }
    expect(acceptWorkflow(current, fresh, current, 'root')).toBe(true)
    expect(acceptWorkflow(current, { ...fresh, streamId: 'old' }, current, 'root')).toBe(false)
    expect(acceptWorkflow(current, fresh, current, 'other')).toBe(false)
  })
  it('shows complete repeated tools before execution, preserves deterministic seek and live state', () => {
    const fact: WorkflowFact = {
      id: 'batch',
      nodeId: 'tools',
      label: 'tools',
      status: 'completed',
      orderKey: 1,
      orderQuality: 'reconstructed',
      batch: {
        id: 'batch',
        complete: true,
        calls: [
          { id: 'one', name: 'read', status: 'completed' },
          { id: 'two', name: 'read', status: 'rejected' },
        ],
      },
    }
    const frames = replayFrames([fact])
    expect(frames).toHaveLength(5)
    expect(frames[0]?.batch?.calls.map((call) => call.status)).toEqual(['pending', 'pending'])
    const final = replaySnapshot(base, frames, 4)
    expect(final.batch?.calls.map((call) => call.status)).toEqual(['completed', 'rejected'])
    expect(replaySnapshot(base, frames, 4)).toEqual(final)
    expect(base.batch).toBeUndefined()
    expect(replayFrames([{ ...fact, batch: { ...fact.batch!, complete: false } }])).toEqual([])
  })
  it('reveals skill resources only after the matching result and preserves all child boundaries', () => {
    const facts: WorkflowFact[] = [
      {
        id: 'batch',
        nodeId: 'tools',
        label: 'tools',
        status: 'completed',
        orderKey: 1,
        orderQuality: 'reconstructed',
        batch: {
          id: 'batch',
          complete: true,
          calls: [
            {
              id: 'one',
              name: 'skill',
              status: 'completed',
              resources: { loadedSkillCount: 1, loadedSkillsComplete: true },
            },
            {
              id: 'two',
              name: 'skill',
              status: 'completed',
              resources: { loadedSkillCount: 2, loadedSkillsComplete: true },
            },
          ],
        },
      },
    ]
    const frames = replayFrames(facts)
    expect(replaySnapshot(base, frames, 1).resources.loadedSkillCount).toBeUndefined()
    expect(replaySnapshot(base, frames, 2).resources.loadedSkillCount).toBe(1)
    expect(replaySnapshot(base, frames, 4).resources.loadedSkillCount).toBe(2)
    const dispatch = (id: string): WorkflowFact => ({
      id,
      nodeId: 'tools',
      label: id,
      status: 'completed',
      orderKey: 1,
      orderQuality: 'exact',
      dispatches: [{ id, name: id, status: 'waiting' }],
    })
    expect(replaySnapshot(base, [dispatch('a'), dispatch('b')], 1).dispatches).toHaveLength(2)
  })
})
