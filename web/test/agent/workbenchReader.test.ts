import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { reactive, shallowReactive } from 'vue'
import { cloneReplayTimeline } from '../../src/features/agent/workbench/runtime-diagram/workflowStepDetails'
import type { RootTimelineSnapshot, TimelineNode } from '../../src/services/agentApi'
import {
  buildNyxusReaderEntries,
  projectNyxusReaderGraph,
  resolveNyxusReaderSelection,
} from '../../src/features/pets/nyxus/public'
import { readComponentSource } from '../helpers/componentSource'

describe('replay snapshot capture', () => {
  it.each([reactive, shallowReactive])(
    'detaches reactive timelines and nested tool content',
    (wrap) => {
      const source = timeline()
      source.nodes = reactive(source.nodes)
      const live = wrap(source)
      const snapshot = cloneReplayTimeline(live)!
      expect(snapshot).toEqual(JSON.parse(JSON.stringify(live)))
      const body = snapshot.nodes[0]!.content
      live.nodes[0]!.content = 'live delta after replay started'
      live.nodes[2]!.toolCalls![0]!.result = 'new result'
      live.capturedEventSeq += 1
      expect(snapshot.nodes[0]!.content).toBe(body)
      expect(snapshot.nodes[2]!.toolCalls![0]!.result).toBe('ok')
      expect(snapshot.capturedEventSeq).not.toBe(live.capturedEventSeq)
      snapshot.nodes[0]!.content = 'replay edit'
      expect(live.nodes[0]!.content).toBe('live delta after replay started')
    },
  )
  it('allows an absent timeline', () => {
    expect(cloneReplayTimeline(undefined)).toBeUndefined()
  })
})

function message(
  id: string,
  sourceMessageId: string,
  sourceChatId: string,
  orderKey: number,
): TimelineNode {
  return {
    id,
    sourceMessageId,
    rootChatId: 'root',
    sourceChatId,
    branchId: sourceChatId === 'root' ? 'main' : 'child',
    kind: 'message',
    actor: { kind: 'agent', chatId: sourceChatId },
    direction: 'agent-to-user',
    visibility: 'conversation',
    content: `content:${id}`,
    orderKey,
    createdAt: orderKey,
    updatedAt: orderKey,
    status: 'committed',
    taskId: 'task',
  }
}

function timeline(): RootTimelineSnapshot {
  const rootMessage = message('root-message', 'shared-source', 'root', 1)
  const childMessage = message('child-message', 'shared-source', 'child-chat', 2)
  const toolBatch: TimelineNode = {
    id: 'tool-batch',
    batchId: 'batch-id',
    sourceMessageId: 'tool-message',
    rootChatId: 'root',
    sourceChatId: 'root',
    branchId: 'main',
    kind: 'tool-batch',
    actor: { kind: 'agent', chatId: 'root' },
    direction: 'internal',
    visibility: 'detail',
    content: '',
    toolCalls: [
      {
        callId: 'call-id',
        index: 0,
        name: 'read_file',
        arguments: '{}',
        result: 'ok',
        status: 'completed',
      },
    ],
    orderKey: 3,
    createdAt: 3,
    updatedAt: 3,
    status: 'committed',
    taskId: 'task',
  }
  return {
    rootChatId: 'root',
    taskId: 'task',
    activeBranchId: 'main',
    branches: [
      { branchId: 'main', chatId: 'root', kind: 'original', createdAt: 1, taskId: 'task' },
      {
        branchId: 'child',
        chatId: 'child-chat',
        kind: 'detail',
        createdAt: 2,
        taskId: 'task',
      },
    ],
    view: 'tree',
    revision: 3,
    nodes: [rootMessage, childMessage, toolBatch],
    edges: [
      {
        id: 'root-to-tool',
        rootChatId: 'root',
        fromNodeId: rootMessage.id,
        toNodeId: toolBatch.id,
        kind: 'sequence',
        orderKey: 1,
        sourceChatId: 'root',
        targetChatId: 'root',
        taskId: 'task',
        branchId: 'main',
      },
    ],
    activeRuns: [],
    pendingInputs: [],
    generations: [],
    capturedEventSeq: 3,
  }
}

describe('workbench content reader projection', () => {
  it('resolves durable node, message and tool-call anchors with chat scoping', () => {
    const entries = buildNyxusReaderEntries(projectNyxusReaderGraph(timeline(), 'none', 'root'))

    const root = resolveNyxusReaderSelection(entries, {
      nodeId: 'shared-source',
      sourceChatId: 'root',
    })
    const child = resolveNyxusReaderSelection(entries, {
      nodeId: 'shared-source',
      sourceChatId: 'child-chat',
    })
    const call = resolveNyxusReaderSelection(entries, {
      nodeId: 'call-id',
      sourceChatId: 'root',
    })

    expect(root?.entryId).not.toBe(child?.entryId)
    expect(call).toMatchObject({ entryId: 'tool-batch', callId: 'call-id' })
    expect(
      resolveNyxusReaderSelection(entries, { nodeId: 'missing', sourceChatId: 'root' }),
    ).toBeUndefined()
  })

  it('keeps the Pixi tree mounted while auxiliary panels change locally', async () => {
    const [workbench, runtime, reader] = await Promise.all([
      readComponentSource(resolve('web/src/features/agent/workbench/WorkbenchDialog.vue'), 'utf8'),
      readComponentSource(
        resolve('web/src/features/agent/workbench/runtime-diagram/RuntimeDiagram.vue'),
        'utf8',
      ),
      readComponentSource(
        resolve('web/src/features/pets/nyxus/components/NyxusContentReader.vue'),
        'utf8',
      ),
    ])

    expect(workbench.match(/<RuntimeDiagram\b/g)).toHaveLength(1)
    expect(workbench.match(/<MessageBranchTree\b/g)).toHaveLength(1)
    expect(workbench).toContain('v-if="currentAttentionCount && !attentionCollapsed"')
    expect(workbench).toContain('@click="toggleAttentionWindow"')
    expect(workbench).not.toContain('workspaceBrowserOpen')
    expect(workbench).toContain('v-bind="runtimeDiagramProps"')
    expect(workbench).toContain("v-if=\"sidePanel === 'workflow'\"")
    expect(workbench).toContain("v-else-if=\"sidePanel === 'reader'\"")
    expect(workbench).toContain('focusNonce: treeFocusNonce.value')
    expect(runtime).toContain('const worldCenter =')
    expect(runtime).toContain('cloneReplayTimeline(props.timeline)')
    expect(runtime).toContain('<WorkflowStepDetails')
    expect(runtime).toContain('@select-content="selectStepContent"')
    expect(reader).toContain('<NodePaperStack')
    expect(workbench).toContain('v-bind="treeProps"')
  })
})
