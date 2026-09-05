import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentApi, type TaskOverview } from '../../src/services/agentApi'
import { useTaskOverviewStore } from '../../src/stores/taskOverview'

function task(rootChatId: string, status: TaskOverview['status'], updatedAt: number): TaskOverview {
  return {
    rootChatId,
    title: rootChatId,
    status,
    updatedAt,
    pendingCount: status === 'needs_user' ? 1 : 0,
    hasFailure: status === 'failed',
    agents: [],
    recentEvents: [],
  }
}

describe('task overview store', () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => vi.restoreAllMocks())

  it('orders actionable tasks first and limits pins to three', async () => {
    vi.spyOn(agentApi, 'openTaskOverview').mockResolvedValue({
      subscriptionId: 'sub-1',
      revision: 0,
      tasks: [
        task('completed', 'completed', 50),
        task('running', 'running', 20),
        task('failed', 'failed', 30),
        task('waiting', 'needs_user', 10),
      ],
    })
    const store = useTaskOverviewStore()
    await store.open()

    expect(store.tasks.map((item) => item.rootChatId)).toEqual([
      'waiting',
      'failed',
      'running',
      'completed',
    ])
    expect(store.togglePin('waiting')).toBe(true)
    expect(store.togglePin('failed')).toBe(true)
    expect(store.togglePin('running')).toBe(true)
    expect(store.togglePin('completed')).toBe(false)
    expect(store.pinnedTasks).toHaveLength(3)
  })

  it('applies ordered changes and reopens on a revision gap', async () => {
    const close = vi.spyOn(agentApi, 'closeTaskOverview').mockResolvedValue({
      subscriptionId: 'sub-1',
      closed: true,
    })
    const open = vi
      .spyOn(agentApi, 'openTaskOverview')
      .mockResolvedValueOnce({ subscriptionId: 'sub-1', revision: 0, tasks: [] })
      .mockResolvedValueOnce({
        subscriptionId: 'sub-2',
        revision: 4,
        tasks: [task('recovered', 'running', 4)],
      })
    const store = useTaskOverviewStore()
    await store.open()
    store.applyChanged({
      subscriptionId: 'sub-1',
      revision: 1,
      changes: [{ type: 'upsert', rootChatId: 'one', task: task('one', 'running', 1) }],
    })
    expect(store.tasksByRoot.one?.status).toBe('running')

    store.applyChanged({ subscriptionId: 'sub-1', revision: 3, changes: [] })
    await vi.waitFor(() => expect(close).toHaveBeenCalledWith('sub-1'))
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(store.subscriptionId).toBe('sub-2'))
    expect(store.tasksByRoot.recovered).toBeDefined()
  })
})
