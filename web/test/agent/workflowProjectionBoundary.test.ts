import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { WorkflowOccurrence } from '@chery/protocol'
import { topologyMatrixSnapshot } from '../fixtures/executionGraphFixtures'
import {
  projectWorkflowScene,
  resolveWorkflowSceneSelection,
} from '../../src/features/agent/workbench/runtime-diagram/workflowProjection'
import type { WorkflowClientState } from '../../src/features/agent/workbench/runtime-diagram/workflowState'

function occurrence(
  occurrenceId: string,
  sequence: number,
  overrides: Partial<WorkflowOccurrence> = {},
): WorkflowOccurrence {
  return {
    occurrenceId,
    rootChatId: 'root',
    chatId: 'root',
    contextStageId: 'root:start',
    kind: 'model',
    label: occurrenceId,
    status: 'succeeded',
    anchors: [],
    startedAt: 100 + sequence,
    updatedAt: 101 + sequence,
    endedAt: 101 + sequence,
    firstSequence: sequence,
    lastSequence: sequence,
    orderQuality: 'exact',
    ...overrides,
  }
}

function workflow(occurrences: WorkflowOccurrence[]): WorkflowClientState {
  return {
    rootChatId: 'root',
    revision: 8,
    upperSequence: 12,
    occurrences: Object.fromEntries(occurrences.map((item) => [item.occurrenceId, item])),
    recentEvents: [],
    gaps: [
      {
        gapId: 'observation-gap',
        rootChatId: 'root',
        fromSequence: 9,
        toSequence: 10,
        reason: 'write-failed',
      },
    ],
    hasEarlier: false,
    historyComplete: false,
  }
}

function resultSignature(scene: ReturnType<typeof projectWorkflowScene>) {
  return {
    nodes: scene.resultTree.nodes.map(({ id, laneId, order, node }) => ({
      id,
      laneId,
      order,
      kind: node.kind,
    })),
    edges: scene.resultTree.edges,
  }
}

describe('workflow projection boundary', () => {
  it('keeps canonical result nodes and fact edges unchanged across step histories and gaps', () => {
    const timeline = topologyMatrixSnapshot()
    const withoutSteps = projectWorkflowScene(undefined, timeline)
    const duplicateTimeline = structuredClone(timeline)
    duplicateTimeline.nodes.push(structuredClone(duplicateTimeline.nodes[0]!))
    const withDuplicateCanonicalFact = projectWorkflowScene(undefined, duplicateTimeline)
    const withSteps = projectWorkflowScene(
      workflow([
        occurrence('request-1', 1),
        occurrence('request-duplicate', 2, { kind: 'request' }),
        occurrence('tool-result', 3, {
          kind: 'tool-result',
          anchors: [{ kind: 'tool-call', id: 'spawn-a', chatId: 'root' }],
        }),
        occurrence('header-only-chat', 4, {
          chatId: 'observation-only-chat',
          branchId: undefined,
        }),
      ]),
      timeline,
    )

    expect(resultSignature(withSteps)).toEqual(resultSignature(withoutSteps))
    expect(resultSignature(withDuplicateCanonicalFact)).toEqual(resultSignature(withoutSteps))
    expect(withSteps.resultTree.nodes.some((node) => node.id.startsWith('header-step:'))).toBe(
      false,
    )
    expect(withSteps.resultTree.edges.every((edge) => edge.semantic === 'fact')).toBe(true)
    expect(withSteps.edges.some((edge) => edge.semantic === 'template')).toBe(true)
  })

  it('retains branch, dispatch and return content while isolating equal tool call IDs by chat', () => {
    const timeline = topologyMatrixSnapshot()
    const rootBatch = timeline.nodes.find((node) => node.id === 'root-spawn-batch')!
    const childBatch = timeline.nodes.find((node) => node.id === 'child-a-spawn-batch')!
    rootBatch.toolCalls![0]!.callId = 'shared-call'
    childBatch.toolCalls![0]!.callId = 'shared-call'
    const scene = projectWorkflowScene(undefined, timeline)

    expect(scene.resultTree.nodes.map((node) => node.node.kind)).toEqual(
      expect.arrayContaining(['dispatch', 'return']),
    )
    expect(
      resolveWorkflowSceneSelection(scene, { nodeId: 'shared-call', sourceChatId: 'root' }),
    ).toMatchObject({ status: 'available', renderedNodeId: 'content:root-spawn-batch' })
    expect(
      resolveWorkflowSceneSelection(scene, { nodeId: 'shared-call', sourceChatId: 'child-a' }),
    ).toMatchObject({ status: 'available', renderedNodeId: 'content:child-a-spawn-batch' })
    expect(
      resolveWorkflowSceneSelection(scene, { nodeId: 'shared-call', sourceChatId: 'child-b' }),
    ).toMatchObject({ status: 'unavailable', reason: 'chat-mismatch' })
  })

  it('represents a missing anchor as unavailable header detail without adding a result node', () => {
    const timeline = topologyMatrixSnapshot()
    const scene = projectWorkflowScene(
      workflow([
        occurrence('missing-anchor', 1, {
          status: 'waiting',
          endedAt: undefined,
          anchors: [{ kind: 'message', id: 'not-synced', chatId: 'root' }],
        }),
      ]),
      timeline,
    )
    const step = scene.headerFlow.headers.flatMap((header) => header.steps)[0]

    expect(step?.contentTarget).toMatchObject({
      status: 'unavailable',
      reason: 'missing-anchor',
    })
    expect(scene.resultTree.nodes.some((node) => node.id.includes('not-synced'))).toBe(false)
  })

  it('keeps the pure projection free of Vue and Vue Flow imports', async () => {
    const source = await readFile(
      resolve('web/src/features/agent/workbench/runtime-diagram/workflowProjection.ts'),
      'utf8',
    )
    expect(source).not.toContain('@vue-flow/core')
    expect(source).not.toMatch(/from ['"]vue['"]/) 
  })
})
