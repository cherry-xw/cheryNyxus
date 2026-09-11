import { describe, expect, it, vi } from 'vitest'
import type {
  WorkflowHistoryResponse,
  WorkflowOccurrence,
  WorkflowStepEvent,
} from '@chery/protocol'
import type { RootTimelineSnapshot, TimelineNode } from '../../src/services/agentApi'
import type { HeaderSelection } from '../../src/features/agent/workbench/runtime-diagram/headerGraph'
import { readWorkflowHistoryPages } from '../../src/features/agent/workbench/runtime-diagram/workflowHistoryLoader'
import {
  projectReplayTimeline,
  projectWorkflowStepDetails,
} from '../../src/features/agent/workbench/runtime-diagram/workflowStepDetails'
import type { WorkflowClientState } from '../../src/features/agent/workbench/runtime-diagram/workflowState'

function occurrence(id: string, overrides: Partial<WorkflowOccurrence> = {}): WorkflowOccurrence {
  return {
    occurrenceId: id,
    rootChatId: 'root',
    chatId: 'root',
    contextStageId: 'root:start',
    runId: 'run-1',
    iteration: 0,
    attempt: 0,
    kind: 'model',
    label: '模型交互',
    status: 'succeeded',
    anchors: [],
    startedAt: 1,
    updatedAt: 2,
    firstSequence: 1,
    lastSequence: 2,
    orderQuality: 'exact',
    ...overrides,
  }
}

function selection(slotOccurrences: WorkflowOccurrence[] = []): HeaderSelection {
  return {
    headerId: 'header:root',
    chatId: 'root',
    templateNodeId: 'model',
    title: '模型交互',
    scope: { runId: 'run-1', iteration: 0, attempt: 0 },
    recorded: true,
    complete: true,
    detail: '调用模型并等待响应。',
    slot: {
      nodeId: 'model',
      status: 'succeeded',
      statusText: '已完成',
      occurrences: slotOccurrences,
      occurrence: slotOccurrences.at(-1),
    },
  }
}

function history(overrides: Partial<WorkflowHistoryResponse> = {}): WorkflowHistoryResponse {
  return {
    chatId: 'root',
    contextStageId: 'root:start',
    boundary: 7,
    upperSequence: 7,
    stages: [{ id: 'root:start', label: '开始', quality: 'exact' }],
    facts: [],
    complete: true,
    historyComplete: true,
    resources: { loadedSkillsComplete: true },
    occurrences: [],
    gaps: [],
    ...overrides,
  }
}

function timelineNode(id: string, orderKey: number): TimelineNode {
  return {
    id,
    rootChatId: 'root',
    sourceChatId: 'root',
    kind: 'message',
    actor: { kind: 'agent', chatId: 'root' },
    direction: 'agent-to-user',
    visibility: 'conversation',
    content: id,
    orderKey,
    createdAt: orderKey,
    updatedAt: orderKey,
    status: 'committed',
  }
}

function timeline(): RootTimelineSnapshot {
  const nodes = [timelineNode('first', 1), timelineNode('second', 2), timelineNode('third', 3)]
  return {
    rootChatId: 'root',
    view: 'tree',
    revision: 3,
    nodes,
    edges: [
      {
        id: 'first-second',
        rootChatId: 'root',
        fromNodeId: 'first',
        toNodeId: 'second',
        kind: 'sequence',
        orderKey: 1,
        sourceChatId: 'root',
        targetChatId: 'root',
      },
      {
        id: 'second-third',
        rootChatId: 'root',
        fromNodeId: 'second',
        toNodeId: 'third',
        kind: 'sequence',
        orderKey: 2,
        sourceChatId: 'root',
        targetChatId: 'root',
      },
    ],
    activeRuns: [{ rootChatId: 'root', chatId: 'root', runId: 'run-1', status: 'running' }],
    pendingInputs: [],
    generations: [],
    capturedEventSeq: 3,
  }
}

describe('workflow step details and fixed history windows', () => {
  it('merges one immutable pagination window and rejects a changed boundary', async () => {
    const event: WorkflowStepEvent = {
      eventId: 'event-1',
      occurrenceId: 'model-1',
      rootChatId: 'root',
      chatId: 'root',
      sequence: 1,
      revision: 1,
      eventKind: 'started',
      kind: 'model',
      label: '模型交互',
      contextStageId: 'root:start',
      at: 1,
      status: 'running',
      orderQuality: 'exact',
    }
    const read = vi
      .fn()
      .mockResolvedValueOnce({ ...history(), complete: false, nextCursor: 'next', events: [event] })
      .mockResolvedValueOnce({ ...history(), events: [event] })
    const result = await readWorkflowHistoryPages({ chatId: 'root' }, read)
    expect(read).toHaveBeenLastCalledWith({ chatId: 'root', cursor: 'next' })
    expect(result?.events).toEqual([event])
    expect(result?.complete).toBe(true)

    const changed = vi
      .fn()
      .mockResolvedValueOnce({ ...history(), complete: false, nextCursor: 'next' })
      .mockResolvedValueOnce({ ...history(), boundary: 8, upperSequence: 8 })
    await expect(readWorkflowHistoryPages({ chatId: 'root' }, changed)).rejects.toThrow(
      '历史分页边界已变化',
    )

    const changedUpperSequence = vi
      .fn()
      .mockResolvedValueOnce({
        ...history(),
        upperSequence: undefined,
        complete: false,
        nextCursor: 'next',
      })
      .mockResolvedValueOnce({ ...history(), upperSequence: 1 })
    await expect(
      readWorkflowHistoryPages({ chatId: 'root' }, changedUpperSequence),
    ).rejects.toThrow('历史分页边界已变化')
  })

  it('keeps step instances in the selected chat and exposes only explicit anchors', () => {
    const selected = occurrence('selected', {
      anchors: [{ kind: 'message', id: 'answer', chatId: 'root' }],
    })
    const foreign = occurrence('foreign', { chatId: 'child' })
    const model = projectWorkflowStepDetails({
      selection: selection(),
      history: history({
        occurrences: [selected, foreign],
        gaps: [
          {
            gapId: 'root-gap',
            rootChatId: 'root',
            fromSequence: 3,
            toSequence: 4,
            reason: 'write-failed',
          },
        ],
        historyComplete: false,
      }),
      resolveAnchor: (target) => ({
        status: 'available',
        selection: target,
        graphNodeId: 'content:answer',
      }),
    })
    expect(model.instances.map((item) => item.id)).toEqual(['selected'])
    expect(model.instances[0]?.anchors[0]).toMatchObject({
      available: true,
      selection: { nodeId: 'answer', sourceChatId: 'root' },
    })
    expect(model.gapCount).toBe(1)
    expect(model.coverage).toContain('记录不完整')
  })

  it('labels unresolved anchors and legacy histories without selecting nearby content', () => {
    const anchored = occurrence('unresolved', {
      anchors: [{ kind: 'message', id: 'missing', chatId: 'root' }],
    })
    const unresolved = projectWorkflowStepDetails({
      selection: selection([anchored]),
      resolveAnchor: (target) => ({
        status: 'unavailable',
        selection: target,
        reason: 'missing-anchor',
      }),
    })
    expect(unresolved.instances[0]?.anchors[0]).toMatchObject({
      available: false,
      unavailableReason: '关联内容尚未同步到当前时间线',
    })

    const legacy = projectWorkflowStepDetails({
      selection: selection(),
      history: history({ occurrences: undefined, historyComplete: false }),
      resolveAnchor: (target) => ({
        status: 'unavailable',
        selection: target,
        reason: 'missing-anchor',
      }),
    })
    expect(legacy.legacy).toBe(true)
    expect(legacy.instances).toEqual([])
    expect(legacy.coverage).toContain('未记录')
  })

  it('grows a frozen replay timeline by explicit anchors and preserves canonical fallback on gaps', () => {
    const source = timeline()
    const state: WorkflowClientState = {
      rootChatId: 'root',
      revision: 1,
      upperSequence: 2,
      occurrences: {
        model: occurrence('model', {
          anchors: [{ kind: 'message', id: 'second', chatId: 'root' }],
        }),
      },
      recentEvents: [],
      gaps: [],
      hasEarlier: false,
      historyComplete: true,
    }
    const frame = projectReplayTimeline(source, state)
    expect(frame?.nodes.map((node) => node.id)).toEqual(['first', 'second'])
    expect(frame?.edges.map((edge) => edge.id)).toEqual(['first-second'])
    expect(frame?.activeRuns).toEqual([])
    expect(source.nodes.map((node) => node.id)).toEqual(['first', 'second', 'third'])

    const fallback = projectReplayTimeline(source, {
      ...state,
      gaps: [
        { gapId: 'gap', rootChatId: 'root', fromSequence: 1, toSequence: 2, reason: 'unknown' },
      ],
      historyComplete: false,
    })
    expect(fallback?.nodes).toHaveLength(3)
  })
})
