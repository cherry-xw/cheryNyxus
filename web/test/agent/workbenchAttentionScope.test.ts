import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { belongsToWorkspace, resolveWorkspaceRootChatId } from '../../src/features/agent/attention/interactionScope'
import { workflowEdgePulseOpacity, type WorkflowMotionEdge } from '../../src/features/agent/workbench/runtime-diagram/motionPolicy'

describe('workbench attention and participation feedback', () => {
  it('uses the timeline root to classify current-page pending work', () => {
    expect(resolveWorkspaceRootChatId('canonical-root', 'selected-child')).toBe('canonical-root')
    expect(resolveWorkspaceRootChatId(undefined, 'selected-root')).toBe('selected-root')
  })

  it('refreshes persistent pending work when the workbench enters a connected root', () => {
    const controller = readFileSync(
      'web/src/features/agent/workbench/useWorkbenchDialogController.ts',
      'utf8',
    )
    expect(controller).toContain('[attentionRootChatId, () => connection.status]')
    expect(controller).toContain('void interactions.refresh()')
    expect(controller).toContain('{ immediate: true }')
  })

  it('keeps root-owned questions without preset metadata visible, without leaking other roots', () => {
    const requests = [
      { presetId: undefined, rootChatId: 'current' },
      { presetId: 'preset', rootChatId: 'previous-session' },
      { presetId: 'other', rootChatId: 'other-root' },
    ]
    expect(requests.filter((item) => belongsToWorkspace(item, 'preset', 'current'))).toEqual(requests.slice(0, 1))
    expect(requests.filter((item) => belongsToWorkspace(item, undefined, 'current'))).toEqual(requests.slice(0, 1))
    expect(requests.filter((item) => belongsToWorkspace(item))).toHaveLength(3)
    expect(requests.filter((item) => !belongsToWorkspace(item, undefined, 'current'))).toEqual(requests.slice(1))
    expect(requests.filter((item) => belongsToWorkspace(item, 'preset'))).toEqual([requests[1]])
  })

  it('retains weaker pulses after completion and leaves unevidenced paths neutral', () => {
    const edge: WorkflowMotionEdge = {
      id: 'edge', sourceId: 'input', targetId: 'model', family: 'header',
      points: [{ x: 0, y: 0 }, { x: 40, y: 0 }], evidenced: true,
      targetStatus: 'running', sequence: 1,
    }
    const active = workflowEdgePulseOpacity(edge)
    const completed = workflowEdgePulseOpacity({ ...edge, targetStatus: 'succeeded' })
    expect(active).toBeGreaterThan(completed)
    expect(completed).toBeGreaterThan(0)
    expect(workflowEdgePulseOpacity({ ...edge, evidenced: false })).toBe(0)
  })
})
