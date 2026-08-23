import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  agentApi,
  type ExecutionStep,
  type RootTimelineSnapshot,
  type TimelineNode,
  type TimelineNodeDetailResponse,
} from '../../src/services/agentApi'
import {
  createLiteExecutionClock,
  FINAL_PREVIEW_CHAR_LIMIT,
  finalContentPreview,
  firstParagraph,
  projectLiteExecution,
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
    expect(view).toContain("step.kind === 'tool' ? step.name : '模型响应'")
    expect(view).toContain("monitor.finalHasMore ? '加载更多' : '查看详情'")
    expect(view).toContain("monitor.value.finalHasMore ? 'content' : null")
    expect(drawer).toContain('sections: [section]')
    expect(drawer).toContain("event.key === 'Escape'")
    expect(drawer).toContain("event.key !== 'Tab'")
    expect(drawer).toContain('aria-modal="true"')
    expect(view).toContain('detailReturnFocus.value?.focus()')
    expect(view).toContain('<button')
  })
})
