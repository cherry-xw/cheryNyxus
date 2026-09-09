import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import type { WorkflowOpenResponse, WorkflowUpdated } from '@chery/protocol'

const fixture = vi.hoisted(() => ({
  cleanup: [] as Array<() => void>,
  update: undefined as ((event: WorkflowUpdated) => void) | undefined,
  status: undefined as ((connected: boolean) => void) | undefined,
  open: vi.fn(),
  close: vi.fn(),
  history: vi.fn(),
}))
vi.mock('vue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue')>()),
  onBeforeUnmount: (callback: () => void) => fixture.cleanup.push(callback),
}))
vi.mock('@/application/backend/public', () => ({
  workflowApi: {
    open: fixture.open,
    close: fixture.close,
    history: fixture.history,
    connected: () => true,
    onUpdate: (callback: typeof fixture.update) => {
      fixture.update = callback
      return () => {
        fixture.update = undefined
      }
    },
    onStatus: (callback: typeof fixture.status) => {
      fixture.status = callback
      return () => {
        fixture.status = undefined
      }
    },
  },
}))
import { useWorkflowController } from '../../src/features/agent/workbench/runtime-diagram/useWorkflowController'

const response = (chatId = 'root', revision = 0): WorkflowOpenResponse => ({
  subscriptionId: `lease:${chatId}`,
  streamId: `stream:${chatId}`,
  snapshot: {
    chatId,
    rootChatId: chatId,
    contextStageId: `${chatId}:start`,
    revision,
    status: 'running',
    visitedNodeIds: [],
    dispatches: [],
    resources: { loadedSkillsComplete: true, loadedSkillCount: 0 },
    phaseKnown: false,
    historyComplete: true,
  },
})
const scopes: ReturnType<typeof effectScope>[] = []
function controller(chatId = ref('root'), suspended = ref(false)) {
  const scope = effectScope()
  scopes.push(scope)
  return scope.run(() => useWorkflowController(chatId, suspended))!
}
async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve()
  await nextTick()
}
afterEach(async () => {
  fixture.cleanup.splice(0).forEach((cleanup) => cleanup())
  scopes.splice(0).forEach((scope) => scope.stop())
  await flush()
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('workflow controller without DOM or execution APIs', () => {
  it('serializes rapid opens so a stale response cannot close the new lease', async () => {
    let resolveFirst!: (value: WorkflowOpenResponse) => void
    fixture.open.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve
        }),
    )
    fixture.open.mockResolvedValue(response('other'))
    const target = ref('root')
    const state = controller(target)
    await flush()
    target.value = 'other'
    await flush()
    expect(fixture.open).toHaveBeenCalledTimes(1)
    resolveFirst(response())
    await flush()
    expect(fixture.close).toHaveBeenCalledWith('lease:root')
    expect(fixture.open).toHaveBeenCalledTimes(2)
    expect(state.live.value?.snapshot.chatId).toBe('other')
    expect(fixture.close).not.toHaveBeenCalledWith('lease:other')
  })

  it('merges pre-response updates and isolates live state during timer-driven replay', async () => {
    vi.useFakeTimers()
    fixture.open.mockImplementation(async () => {
      fixture.update?.(response('root', 2))
      return response()
    })
    fixture.history.mockResolvedValue({
      chatId: 'root',
      contextStageId: 'root:start',
      boundary: 1,
      stages: [{ id: 'root:start', label: 'start', quality: 'exact' }],
      complete: true,
      historyComplete: true,
      resources: { loadedSkillCount: 9, loadedSkillsComplete: true },
      facts: ['input', 'model', 'result'].map((nodeId, i) => ({
        id: String(i),
        nodeId,
        label: nodeId,
        status: 'completed',
        orderKey: i,
        orderQuality: 'exact',
      })),
    })
    const suspended = ref(false)
    const state = controller(ref('root'), suspended)
    await flush()
    expect(state.live.value?.snapshot.revision).toBe(2)
    await state.loadHistory()
    expect(state.snapshot.value?.resources.loadedSkillCount).toBe(0)
    state.play()
    await vi.advanceTimersByTimeAsync(700)
    expect(state.cursor.value).toBe(1)
    fixture.update?.(response('root', 3))
    expect(state.snapshot.value?.revision).toBe(0)
    suspended.value = true
    await nextTick()
    await vi.advanceTimersByTimeAsync(5000)
    expect(state.cursor.value).toBe(1)
    expect(state.playing.value).toBe(false)
    state.returnLive()
    expect(state.snapshot.value?.revision).toBe(3)
  })

  it('rejects incomplete pagination and ignores history after target changes', async () => {
    fixture.open.mockImplementation(async ({ chatId }) => response(chatId))
    fixture.history.mockResolvedValue({ facts: [], complete: false })
    const target = ref('root')
    const state = controller(target)
    await flush()
    await state.loadHistory()
    expect(state.historyError.value).toContain('历史分页未完成')
    expect(state.history.value).toBeUndefined()
    expect(state.playing.value).toBe(false)
    let resolveHistory!: (value: unknown) => void
    fixture.history.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveHistory = resolve
        }),
    )
    const pendingHistory = state.loadHistory()
    target.value = 'other'
    await flush()
    resolveHistory({ facts: [], complete: true, chatId: 'root' })
    await pendingHistory
    expect(state.history.value).toBeUndefined()
    expect(state.live.value?.snapshot.chatId).toBe('other')
  })
})
