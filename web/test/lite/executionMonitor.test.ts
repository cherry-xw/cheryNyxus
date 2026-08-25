import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  agentApi,
  type ExecutionStep,
  type GraphToolCall,
  type RootTimelineSnapshot,
  type TimelineNode,
  type TimelineNodeDetailResponse,
} from '../../src/services/agentApi'
import {
  classifyToolType,
  createLiteExecutionClock,
  FINAL_PREVIEW_CHAR_LIMIT,
  finalContentPreview,
  firstParagraph,
  projectLiteExecution,
  projectLiteHistory,
  toolTypeEmoji,
} from '../../src/features/lite/executionMonitor'
import {
  createLiteDetailSectionState,
  mergeDetailSectionPage,
} from '../../src/features/lite/detailSections'
import { useLiteCanonicalView } from '../../src/features/lite/useLiteCanonicalView'
import { useLiteStore } from '../../src/features/lite/liteStore'
import { createEmptySession } from '../../src/stores/chats/hydration'
import { useChatSessionsStore } from '../../src/stores/chats'
import {
  selectExecutionReadModel,
  type ExecutionReadModel,
} from '../../src/stores/chats/executionReadModel'

function step(input: Partial<ExecutionStep> & Pick<ExecutionStep, 'id' | 'kind' | 'startedAt'>) {
  return {
    runId: 'run-1',
    chatId: 'root',
    name: input.kind === 'tool' ? 'search' : 'model response',
    status: 'running' as const,
    ...input,
    isRoot: input.chatId === undefined || input.chatId === 'root',
    agentLabel: input.chatId === 'child' ? 'child agent' : 'root agent',
  }
}

function model(overrides: Partial<ExecutionReadModel> = {}): ExecutionReadModel {
  return {
    rootChatId: 'root',
    currentQuestion: { id: 'question', content: 'Do the work', createdAt: 98_000 },
    status: 'running',
    runId: 'run-1',
    startedAt: 98_000,
    steps: [],
    agents: [],
    ...overrides,
  }
}

function detailResponse(
  fields: Partial<TimelineNode>,
  hasMore: boolean,
): TimelineNodeDetailResponse {
  return {
    rootChatId: 'root',
    node: {
      id: 'node-1',
      rootChatId: 'root',
      sourceChatId: 'root',
      kind: 'message',
      actor: { kind: 'agent', chatId: 'root' },
      direction: 'agent-to-user',
      visibility: 'conversation',
      content: '',
      orderKey: 1,
      createdAt: 1,
      updatedAt: 1,
      status: 'committed',
      ...fields,
    },
    refs: [],
    hasMore,
  }
}

function messageNode(
  rootChatId: string,
  sourceChatId: string,
  id: string,
  actor: 'user' | 'agent',
  content: string,
  orderKey: number,
): TimelineNode {
  return {
    id,
    rootChatId,
    sourceChatId,
    sourceMessageId: id,
    kind: 'message',
    actor:
      actor === 'user'
        ? { kind: 'user', actorId: 'human' }
        : { kind: 'agent', chatId: sourceChatId },
    target:
      actor === 'user' ? { kind: 'agent', chatId: rootChatId } : { kind: 'user', actorId: 'human' },
    direction: actor === 'user' ? 'user-to-agent' : 'agent-to-user',
    visibility: 'conversation',
    content,
    orderKey,
    createdAt: orderKey,
    updatedAt: orderKey,
    status: 'committed',
  }
}

function timeline(nodes: TimelineNode[]): RootTimelineSnapshot {
  return {
    rootChatId: 'root',
    view: 'conversation',
    revision: 1,
    nodes,
    edges: [],
    activeRuns: [],
    pendingInputs: [],
    generations: [],
    capturedEventSeq: 1,
  }
}

describe('Lite execution monitor', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('ticks root, model and tool timers once per second and seals terminal durations', () => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
    const clock = createLiteExecutionClock()
    clock.start()
    vi.advanceTimersByTime(1_000)

    const running = projectLiteExecution(
      model({
        steps: [
          step({ id: 'turn-1', kind: 'model', startedAt: 98_500 }),
          step({ id: 'tool-1', kind: 'tool', startedAt: 99_000 }),
        ],
      }),
      clock.now.value,
    )
    expect(running.elapsedMs).toBe(3_000)
    expect(running.steps.map((item) => item.elapsedMs)).toEqual([2_500, 2_000])

    const completedModel = model({
      status: 'completed',
      completedAt: 101_200,
      steps: [
        step({
          id: 'turn-1',
          kind: 'model',
          status: 'completed',
          startedAt: 98_500,
          completedAt: 100_500,
        }),
        step({
          id: 'tool-1',
          kind: 'tool',
          status: 'completed',
          startedAt: 99_000,
          completedAt: 101_000,
        }),
      ],
    })
    vi.advanceTimersByTime(10_000)
    const completed = projectLiteExecution(completedModel, clock.now.value)
    expect(completed.elapsedMs).toBe(3_200)
    expect(completed.steps.map((item) => item.elapsedMs)).toEqual([2_000, 2_000])
    expect(completed.steps.every((item) => !item.expanded)).toBe(true)
    clock.stop()
  })

  it('collapses a sequential terminal step while the next node starts timing', () => {
    const view = projectLiteExecution(
      model({
        steps: [
          step({
            id: 'tool-1',
            kind: 'tool',
            status: 'completed',
            startedAt: 10,
            completedAt: 20,
          }),
          step({ id: 'turn-2', kind: 'model', startedAt: 20 }),
        ],
      }),
      35,
    )
    expect(view.steps[0]).toMatchObject({ active: false, expanded: false, elapsedMs: 10 })
    expect(view.steps[1]).toMatchObject({ active: true, expanded: true, elapsedMs: 15 })
  })

  it('keeps parallel child-agent nodes active at the same time', () => {
    const view = projectLiteExecution(
      model({
        steps: [
          step({ id: 'turn-child', chatId: 'child', kind: 'model', startedAt: 100 }),
          step({ id: 'tool-root', kind: 'tool', startedAt: 110 }),
        ],
      }),
      150,
    )
    expect(view.activeSteps).toHaveLength(2)
    expect(view.activeSteps.map((item) => item.agentLabel)).toEqual(['child agent', 'root agent'])
  })

  it('shows only the last root final response and previews its first paragraph', () => {
    const root = createEmptySession('root')
    const child = createEmptySession('child', { parentChatId: 'root' })
    const execution = selectExecutionReadModel({
      rootChatId: 'root',
      sessionsById: { root, child },
      timeline: timeline([
        messageNode('root', 'root', 'question', 'user', 'Question', 100),
        messageNode('root', 'root', 'intermediate', 'agent', 'Intermediate', 120),
        messageNode('root', 'child', 'child-final', 'agent', 'Child result', 140),
        messageNode('root', 'root', 'final', 'agent', 'First paragraph\n\nRest', 160),
      ]),
    })
    const view = projectLiteExecution(execution, 170)
    expect(execution.finalResponse?.id).toBe('final')
    expect(view.finalPreview).toBe('First paragraph')
    expect(view.finalHasMore).toBe(true)
    expect(firstParagraph('One line')).toBe('One line')
  })

  it('bounds a long single-paragraph final preview and reports remaining content', () => {
    const content = 'x'.repeat(FINAL_PREVIEW_CHAR_LIMIT + 50)
    const preview = finalContentPreview(content)

    expect(preview.content).toHaveLength(FINAL_PREVIEW_CHAR_LIMIT)
    expect(preview.content.endsWith('…')).toBe(true)
    expect(preview.hasMore).toBe(true)
    expect(
      projectLiteExecution(
        model({
          status: 'completed',
          completedAt: 110,
          finalResponse: {
            id: 'final',
            content,
            createdAt: 100,
            updatedAt: 110,
          },
        }),
        120,
      ).finalHasMore,
    ).toBe(true)
  })

  it('does not offer more content for a complete short single paragraph', () => {
    const preview = finalContentPreview('Complete answer')
    const view = projectLiteExecution(
      model({
        status: 'completed',
        completedAt: 110,
        finalResponse: {
          id: 'final',
          content: 'Complete answer',
          createdAt: 100,
          updatedAt: 110,
        },
      }),
      120,
    )

    expect(preview).toEqual({ content: 'Complete answer', hasMore: false })
    expect(view.finalHasMore).toBe(false)
  })

  it('marks a segmented final response as having more after its first paragraph', () => {
    expect(finalContentPreview('First paragraph\n\nSecond paragraph')).toEqual({
      content: 'First paragraph',
      hasMore: true,
    })
  })

  it.each([
    ['completion', 'completed', 'completed'],
    ['error/failure', 'failed', 'failed'],
    ['resumable abort', 'paused', 'cancelled'],
    ['abort', 'cancelled', 'cancelled'],
  ] as const)(
    'seals a late running step after root %s',
    (_scenario, rootStatus, expectedStepStatus) => {
      vi.useFakeTimers()
      vi.setSystemTime(200_000)
      const clock = createLiteExecutionClock()
      clock.start()
      const terminalModel = model({
        status: rootStatus,
        completedAt: 150_000,
        steps: [step({ id: 'late', kind: 'tool', startedAt: 149_000 })],
      })

      const sealed = projectLiteExecution(terminalModel, clock.now.value)
      vi.advanceTimersByTime(30_000)
      const later = projectLiteExecution(terminalModel, clock.now.value)

      expect(sealed.activeSteps).toEqual([])
      expect(sealed.steps[0]).toMatchObject({
        status: expectedStepStatus,
        active: false,
        expanded: false,
        elapsedMs: 1_000,
      })
      expect(later.steps[0]?.elapsedMs).toBe(1_000)
      expect(later.elapsedMs).toBe(sealed.elapsedMs)
      clock.stop()
    },
  )

  it('does not request node details while constructing the first-screen view', () => {
    const request = vi.spyOn(agentApi, 'getTimelineNode')
    const lite = useLiteCanonicalView(
      () => 'window-a',
      () => 'root',
    )
    void lite.execution
    void lite.finalMessage
    void lite.leanTimeline
    expect(request).not.toHaveBeenCalled()
  })

  it('locates an approval tool call in its canonical owning node without an anchor', () => {
    const chats = useChatSessionsStore()
    const owner = messageNode('root', 'root', 'assistant-owner', 'agent', '', 120)
    owner.toolCalls = [
      {
        callId: 'approval-1',
        index: 0,
        name: 'write_file',
        arguments: '{"path":"a"}',
        status: 'pending',
      },
    ]
    chats.rootTimelines['root:conversation'] = timeline([
      messageNode('root', 'root', 'question', 'user', 'Question', 100),
      owner,
    ])
    const lite = useLiteCanonicalView(
      () => 'window-a',
      () => 'root',
    )

    expect(lite.detailNodeIdForToolCall('approval-1')).toBe('assistant-owner')
  })
})

describe('Lite detail lazy pagination', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('maintains independent, continuous offsets for content and thinking', () => {
    const empty = createLiteDetailSectionState()
    const contentOne = mergeDetailSectionPage(
      empty,
      'content',
      detailResponse({ content: 'abc' }, true),
      0,
    )
    const thinkingOne = mergeDetailSectionPage(
      empty,
      'thinking',
      detailResponse({ thinking: '1234' }, true),
      0,
    )
    const contentTwo = mergeDetailSectionPage(
      contentOne,
      'content',
      detailResponse({ content: 'def' }, false),
      contentOne.offset,
    )

    expect(contentTwo).toMatchObject({ text: 'abcdef', offset: 6, hasMore: false })
    expect(thinkingOne).toMatchObject({ text: '1234', offset: 4, hasMore: true })
  })

  it('continues after a limit-sized page even when an older server omits hasMore', () => {
    const page = mergeDetailSectionPage(
      createLiteDetailSectionState(),
      'content',
      detailResponse({ content: 'abcd' }, false),
      0,
      4,
    )
    const end = mergeDetailSectionPage(
      page,
      'content',
      detailResponse({ content: '' }, false),
      page.offset,
      4,
    )

    expect(page).toMatchObject({ offset: 4, hasMore: true })
    expect(end).toMatchObject({ text: 'abcd', offset: 4, hasMore: false })
  })

  it('appends paged tool argument and result chunks without duplicates or gaps', () => {
    const call = {
      callId: 'call-1',
      index: 0,
      name: 'write_file',
      arguments: '{"pa',
      result: 'o',
      status: 'completed' as const,
    }
    const one = mergeDetailSectionPage(
      createLiteDetailSectionState(),
      'toolCalls',
      detailResponse({ toolCalls: [call] }, true),
      0,
    )
    const two = mergeDetailSectionPage(
      one,
      'toolCalls',
      detailResponse(
        {
          toolCalls: [{ ...call, arguments: 'th":1}', result: 'k' }],
        },
        false,
      ),
      one.offset,
    )

    expect(one.offset).toBe(4)
    expect(two.offset).toBe(10)
    expect(two.toolCalls[0]).toMatchObject({ arguments: '{"path":1}', result: 'ok' })
  })

  it('isolates cached detail payloads by window and root', () => {
    const store = useLiteStore()
    const secret = mergeDetailSectionPage(
      createLiteDetailSectionState(),
      'content',
      detailResponse({ content: 'window-a secret' }, false),
      0,
    )
    store.patchDetailSection('window-a', 'root-a', 'node-1', 'content', secret)

    expect(store.rootUi('window-a', 'root-a')?.detailCache['node-1']?.content.text).toBe(
      'window-a secret',
    )
    expect(store.rootUi('window-a', 'root-b')).toBeUndefined()
    expect(store.rootUi('window-b', 'root-a')).toBeUndefined()
  })

  it('bounds the per-root lazy detail cache', () => {
    const store = useLiteStore()
    for (let index = 0; index < 13; index += 1) {
      store.ensureNodeDetail('window-a', 'root-a', `node-${index}`)
    }

    const cache = store.rootUi('window-a', 'root-a')?.detailCache ?? {}
    expect(Object.keys(cache)).toHaveLength(12)
    expect(cache['node-0']).toBeUndefined()
    expect(cache['node-12']).toBeDefined()
  })

  it('keeps internal payloads out of summaries and exposes accessible detail controls', async () => {
    const [view, drawer] = await Promise.all([
      readFile(resolve('src/features/lite/LiteView.vue'), 'utf8'),
      readFile(resolve('src/features/lite/DetailDrawer.vue'), 'utf8'),
    ])

    expect(view).not.toContain('approvalEntries')
    expect(view).not.toContain('payload.arguments')
    expect(view).not.toContain('payload.result')
    expect(view).not.toContain('lite-actions')
    // 上半部运行历史列表（需求 1c）+ 顶部时间瀑布流（需求：放在节点区顶部）+ 底部 tab 栏（需求 1a/1b）
    expect(view).toContain('projectLiteHistory(')
    expect(view).toContain('lite-history-row')
    expect(view).toContain('lite-cluster')
    expect(view).toContain('lite-trajectory')
    expect(view).toContain('LiteScrollbar')
    expect(view).toContain('activePendingTab')
    expect(view).toContain('lite-pending-tab')
    expect(view).toContain('remainingLabel(')
    expect(view).toContain('detailReturnFocus.value?.focus()')
    expect(view).toContain('<button')
    // 详情抽屉（需求 3）：单节点详情 + 遮罩，点击遮罩关闭；不含轨迹/节点列表
    expect(drawer).toContain('lite-drawer-mask')
    expect(drawer).toContain('lite-tool-call')
    expect(drawer).not.toContain('lite-trajectory')
    expect(drawer).not.toContain('lite-node-list')
    expect(drawer).toContain('sections: [section]')
    expect(drawer).toContain("event.key === 'Escape'")
    expect(drawer).toContain("event.key !== 'Tab'")
    expect(drawer).toContain('aria-modal="true"')
  })
})

describe('projectLiteHistory run-history projection', () => {
  function userNode(
    id: string,
    content: string,
    orderKey: number,
    createdAt = orderKey,
  ): TimelineNode {
    return {
      id,
      rootChatId: 'root',
      sourceChatId: 'root',
      sourceMessageId: id,
      kind: 'message',
      actor: { kind: 'user', actorId: 'human' },
      target: { kind: 'agent', chatId: 'root' },
      direction: 'user-to-agent',
      visibility: 'conversation',
      content,
      orderKey,
      createdAt,
      updatedAt: createdAt,
      status: 'committed',
    }
  }
  function modelNode(
    id: string,
    content: string,
    orderKey: number,
    createdAt = orderKey,
  ): TimelineNode {
    return {
      id,
      rootChatId: 'root',
      sourceChatId: 'root',
      sourceMessageId: id,
      kind: 'message',
      actor: { kind: 'agent', chatId: 'root' },
      target: { kind: 'user', actorId: 'human' },
      direction: 'agent-to-user',
      visibility: 'conversation',
      content,
      orderKey,
      createdAt,
      updatedAt: createdAt + 4_000,
      status: 'committed',
    }
  }
  function toolBatch(
    id: string,
    orderKey: number,
    calls: Array<Partial<GraphToolCall> & { name: string }>,
  ): TimelineNode {
    return {
      id,
      rootChatId: 'root',
      sourceChatId: 'root',
      sourceMessageId: id,
      kind: 'tool-batch',
      actor: { kind: 'agent', chatId: 'root' },
      direction: 'internal',
      visibility: 'detail',
      content: '',
      toolCalls: calls.map((call, index) => ({
        callId: `call-${index}`,
        index,
        status: 'completed' as const,
        arguments: '',
        ...call,
      })),
      orderKey,
      createdAt: orderKey,
      updatedAt: orderKey,
      status: 'committed',
    }
  }

  const emptyModel: ExecutionReadModel = {
    rootChatId: 'root',
    status: 'completed',
    completedAt: 10_000,
    steps: [],
    agents: [],
  }

  it('lists user question, tool runs and model responses in order from the start node', () => {
    const view = projectLiteHistory(
      [
        userNode('q1', '问题一', 10),
        toolBatch('batch-1', 20, [{ name: 'search' }]),
        modelNode('m1', '回答一', 30),
        userNode('q2', '问题二', 40),
        modelNode('m2', '回答二', 50),
      ],
      emptyModel,
      100,
    )
    expect(view.nodes.map((node) => node.kind)).toEqual(['user', 'tool', 'model', 'user', 'model'])
    expect(view.nodes.map((node) => node.label)).toEqual([
      '用户问题',
      'search',
      '模型响应',
      '用户问题',
      '模型响应',
    ])
    expect(view.nodes.map((node) => node.roundIndex)).toEqual([0, 0, 0, 1, 1])
  })

  it('collapses everything except user messages and the round-final message (需求 3d-1)', () => {
    const view = projectLiteHistory(
      [
        userNode('q1', '问题一', 10),
        toolBatch('batch-1', 20, [{ name: 'search' }, { name: 'read' }]),
        toolBatch('batch-2', 30, [{ name: 'write' }]),
        modelNode('m1', '回答一', 40),
      ],
      emptyModel,
      100,
    )
    const byId = new Map(view.nodes.map((node) => [node.nodeId, node]))
    expect(byId.get('q1')?.collapsed).toBe(false)
    expect(byId.get('batch-1')?.collapsed).toBe(true)
    expect(byId.get('batch-2')?.collapsed).toBe(true)
    expect(byId.get('m1')?.collapsed).toBe(false)
    expect(byId.get('m1')?.isRoundFinal).toBe(true)
    // 折叠的工具节点仍携带工具名标签（参考历史抽屉「折叠工具调用状态」）
    expect(byId.get('batch-1')?.toolNames).toEqual(['search', 'read'])
  })

  it('marks only running tool nodes as active and seals terminal durations (需求 2)', () => {
    const running = projectLiteHistory(
      [
        userNode('q1', '问题一', 10, 0),
        toolBatch('batch-1', 20, [{ name: 'search', status: 'pending' }]),
      ],
      {
        rootChatId: 'root',
        status: 'running',
        runId: 'run-1',
        startedAt: 0,
        steps: [
          {
            id: 'step-tool',
            runId: 'run-1',
            chatId: 'root',
            kind: 'tool',
            name: 'search',
            status: 'running',
            startedAt: 20,
          },
        ],
        agents: [],
      },
      60,
    )
    const tool = running.nodes.find((node) => node.kind === 'tool')
    expect(tool?.active).toBe(true)
    expect(tool?.status).toBe('running')
    expect(tool?.elapsedMs).toBe(40)

    const terminal = projectLiteHistory(
      [userNode('q1', '问题一', 10, 0), toolBatch('batch-1', 20, [{ name: 'search' }])],
      {
        rootChatId: 'root',
        status: 'completed',
        completedAt: 90,
        steps: [
          {
            id: 'step-tool',
            runId: 'run-1',
            chatId: 'root',
            kind: 'tool',
            name: 'search',
            status: 'completed',
            startedAt: 20,
            completedAt: 60,
          },
        ],
        agents: [],
      },
      200,
    )
    const done = terminal.nodes.find((node) => node.kind === 'tool')
    expect(done?.active).toBe(false)
    expect(done?.status).toBe('completed')
    // 终态节点耗时固定，不再随 now 增长（不对未运行节点做进行时计时）
    expect(done?.elapsedMs).toBe(40)
  })

  it('synthesizes in-flight running steps with no committed node as placeholder nodes (需求 3 进行中节点)', () => {
    const view = projectLiteHistory(
      [userNode('q1', '问题一', 10), toolBatch('batch-1', 20, [{ name: 'search' }])],
      {
        rootChatId: 'root',
        status: 'running',
        runId: 'run-1',
        startedAt: 0,
        steps: [
          {
            id: 'turn-9',
            runId: 'run-1',
            chatId: 'root',
            kind: 'model',
            name: '模型响应',
            status: 'running',
            startedAt: 200,
          },
          {
            id: 'step-late',
            runId: 'run-1',
            chatId: 'root',
            kind: 'tool',
            name: 'web_search',
            status: 'running',
            startedAt: 260,
          },
          {
            id: 'step-search',
            runId: 'run-1',
            chatId: 'root',
            kind: 'tool',
            name: 'search',
            status: 'completed',
            startedAt: 20,
            completedAt: 40,
          },
        ],
        agents: [],
      },
      300,
    )
    const byId = new Map(view.nodes.map((node) => [node.nodeId, node]))
    const inflightModel = byId.get('inflight:turn-9')
    expect(inflightModel).toBeDefined()
    expect(inflightModel?.kind).toBe('model')
    expect(inflightModel?.status).toBe('running')
    expect(inflightModel?.active).toBe(true)
    expect(inflightModel?.label).toBe('正在生成回答…')
    expect(inflightModel?.startedAt).toBe(200)
    expect(inflightModel?.elapsedMs).toBe(100)
    expect(inflightModel?.isRoundFinal).toBe(true)
    // 进行中的模型回合占一行（full 行）
    expect(
      view.rows.some((row) => row.kind === 'full' && row.node?.nodeId === 'inflight:turn-9'),
    ).toBe(true)
    // 无已提交节点的运行中工具 step 也合成占位（工具类型归类）
    const inflightTool = byId.get('inflight:step-late')
    expect(inflightTool?.kind).toBe('tool')
    expect(inflightTool?.toolType).toBe('web')
    expect(inflightTool?.status).toBe('running')
    expect(inflightTool?.active).toBe(true)
    // 已匹配到已提交节点的 step 不重复合成占位
    expect(byId.has('inflight:step-search')).toBe(false)
    // 已提交工具节点仍由匹配 step 驱动状态（此处 step 已终态 → completed）
    expect(byId.get('batch-1')?.status).toBe('completed')
    // 按 startedAt 排序：q1(10) < batch-1(20) < turn-9(200) < step-late(260)
    expect(view.nodes.map((node) => node.nodeId)).toEqual([
      'q1',
      'batch-1',
      'inflight:turn-9',
      'inflight:step-late',
    ])
  })

  it('ignores bookkeeping nodes (return/dispatch/system) in the run history', () => {
    const view = projectLiteHistory(
      [
        userNode('q1', '问题一', 10),
        {
          id: 'dispatch-1',
          rootChatId: 'root',
          sourceChatId: 'root',
          kind: 'dispatch',
          actor: { kind: 'agent', chatId: 'root' },
          direction: 'parent-to-child',
          visibility: 'detail',
          content: '',
          orderKey: 15,
          createdAt: 15,
          updatedAt: 15,
          status: 'committed',
        },
        modelNode('m1', '回答一', 30),
      ],
      emptyModel,
      100,
    )
    expect(view.nodes.map((node) => node.nodeId)).toEqual(['q1', 'm1'])
  })

  it('builds full/cluster rows: user and round-final on their own line, middle nodes clustered', () => {
    const view = projectLiteHistory(
      [
        userNode('q1', '问题一', 10),
        toolBatch('batch-1', 20, [{ name: 'search' }]),
        modelNode('think-1', '思考', 25, 22),
        toolBatch('batch-2', 30, [{ name: 'write' }]),
        modelNode('m1', '回答一', 40),
        userNode('q2', '问题二', 50),
        modelNode('m2', '回答二', 60),
      ],
      emptyModel,
      100,
    )
    expect(view.rows.map((row) => row.kind)).toEqual(['full', 'cluster', 'full', 'full', 'full'])
    expect(view.rows[0].node?.nodeId).toBe('q1')
    expect(view.rows[1].kind).toBe('cluster')
    expect((view.rows[1].nodes ?? []).map((node) => node.nodeId)).toEqual([
      'batch-1',
      'think-1',
      'batch-2',
    ])
    expect(view.rows[2].node?.nodeId).toBe('m1')
    expect(view.rows[3].node?.nodeId).toBe('q2')
    expect(view.rows[3].node?.kind).toBe('user')
    expect(view.rows[4].node?.nodeId).toBe('m2')
    expect(view.rows[4].node?.isRoundFinal).toBe(true)
  })

  it('uses Chinese tool names and per-tool icons when toolMeta is supplied', () => {
    const view = projectLiteHistory(
      [userNode('q1', '问题一', 10), toolBatch('batch-1', 20, [{ name: 'search' }])],
      emptyModel,
      100,
      (name) => (name === 'search' ? { label: '搜索', icon: '🔍' } : undefined),
    )
    const tool = view.nodes.find((node) => node.kind === 'tool')
    expect(tool?.toolNames).toEqual(['搜索'])
    expect(tool?.label).toBe('搜索')
    expect(tool?.icon).toBe('🔍')
  })

  it('never matches a user node to an execution step (its timing stays static)', () => {
    const view = projectLiteHistory(
      [userNode('q1', '问题一', 10, 0), toolBatch('batch-1', 20, [{ name: 'search' }])],
      {
        rootChatId: 'root',
        status: 'running',
        runId: 'run-1',
        startedAt: 0,
        steps: [
          {
            id: 'step-model',
            runId: 'run-1',
            chatId: 'root',
            kind: 'model',
            name: '',
            status: 'running',
            startedAt: 5,
          },
        ],
        agents: [],
      },
      60,
    )
    const user = view.nodes.find((node) => node.kind === 'user')
    // 用户节点仍是终态，且 active=false（需求 2：不对未运行节点做进行时计时）
    expect(user?.active).toBe(false)
    expect(user?.status).toBe('completed')
    expect(user?.elapsedMs).toBe(0)
  })
})

describe('classifyToolType tool-type classification (需求 5 配色)', () => {
  it('maps known tool raw names to display types and falls back to other', () => {
    expect(classifyToolType('execute_command')).toBe('exec')
    expect(classifyToolType('bash')).toBe('exec')
    expect(classifyToolType('read_file')).toBe('read')
    expect(classifyToolType('search_codebase')).toBe('read')
    expect(classifyToolType('write_file')).toBe('write')
    expect(classifyToolType('config_manage')).toBe('write')
    expect(classifyToolType('web_search')).toBe('web')
    expect(classifyToolType('spawn_role')).toBe('dispatch')
    expect(classifyToolType('whatever_custom')).toBe('other')
  })
})

describe('toolTypeEmoji tool-type emoji marker (需求 5 工具小块标记)', () => {
  it('maps every tool type to a distinct emoji and falls back for unknown/missing', () => {
    expect(toolTypeEmoji('exec')).toBe('⚙️')
    expect(toolTypeEmoji('read')).toBe('📖')
    expect(toolTypeEmoji('write')).toBe('✍️')
    expect(toolTypeEmoji('web')).toBe('🌐')
    expect(toolTypeEmoji('dispatch')).toBe('📨')
    expect(toolTypeEmoji('other')).toBe('🧩')
    expect(toolTypeEmoji(undefined)).toBe('🧩')
  })
})
