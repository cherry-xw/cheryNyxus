import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentApi, type TaskCatalogItem } from '../../src/services/agentApi'
import { useTaskCatalogStore } from '../../src/stores/taskCatalog'

function item(taskKey: string): TaskCatalogItem {
  return {
    taskKey,
    originalChatId: taskKey,
    openChatId: taskKey,
    title: taskKey,
    status: 'idle',
    unreadResult: false,
    attentionKey: `attention-${taskKey}`,
    createdAt: 1,
    updatedAt: 1,
    branchCount: 1,
    matches: [],
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('task catalog store', () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => vi.restoreAllMocks())

  it('ignores a stale search response that arrives out of order', async () => {
    const first = deferred<Awaited<ReturnType<typeof agentApi.listTasks>>>()
    const second = deferred<Awaited<ReturnType<typeof agentApi.listTasks>>>()
    vi.spyOn(agentApi, 'listTasks')
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const store = useTaskCatalogStore()

    const oldRequest = store.search({ presetId: 'preset-1', query: '旧查询' })
    const newRequest = store.search({ presetId: 'preset-1', query: '新查询' })
    second.resolve({ items: [item('new')], total: 1, snapshotAt: 2 })
    await newRequest
    first.resolve({ items: [item('old')], total: 1, snapshotAt: 1 })
    await oldRequest

    expect(store.items.map((entry) => entry.taskKey)).toEqual(['new'])
    expect(store.snapshotAt).toBe(2)
  })

  it('deduplicates cursor pages and updates only the matching viewed result', async () => {
    const unread = {
      ...item('one'),
      latestResult: { resultId: 'result-1', status: 'completed' as const, completedAt: 2 },
      unreadResult: true,
    }
    vi.spyOn(agentApi, 'listTasks')
      .mockResolvedValueOnce({ items: [unread], total: 2, snapshotAt: 1, nextCursor: 'cursor-1' })
      .mockResolvedValueOnce({ items: [unread, item('two')], total: 2, snapshotAt: 1 })
    vi.spyOn(agentApi, 'markTaskResultViewed').mockResolvedValue({
      taskKey: 'one',
      resultId: 'result-1',
      viewed: true,
      viewedAt: 3,
    })
    const store = useTaskCatalogStore()

    await store.search({ presetId: 'preset-1', limit: 1 })
    await store.loadMore()
    expect(store.items.map((entry) => entry.taskKey)).toEqual(['one', 'two'])
    expect(await store.markResultViewed('one', 'result-1')).toBe(true)
    expect(store.items[0]?.unreadResult).toBe(false)
  })

  it('keeps concurrent workbench catalogs isolated', async () => {
    vi.spyOn(agentApi, 'listTasks').mockImplementation(async (query) => ({
      items: [item(query.presetId ?? 'unknown')],
      total: 1,
      snapshotAt: 1,
    }))
    const store = useTaskCatalogStore()

    await Promise.all([
      store.search({ presetId: 'preset-a' }, 'window-a'),
      store.search({ presetId: 'preset-b' }, 'window-b'),
    ])

    expect(store.stateFor('window-a').items.map((entry) => entry.taskKey)).toEqual(['preset-a'])
    expect(store.stateFor('window-b').items.map((entry) => entry.taskKey)).toEqual(['preset-b'])
  })

  it('keeps a task visible when archiving fails and removes it after a successful retry', async () => {
    vi.spyOn(agentApi, 'listTasks').mockResolvedValue({
      items: [item('one')],
      total: 1,
      snapshotAt: 1,
    })
    vi.spyOn(agentApi, 'archiveChat')
      .mockRejectedValueOnce(new Error('归档暂时不可用'))
      .mockResolvedValueOnce({ chatId: 'one', archivedChatIds: ['one'] })
    const store = useTaskCatalogStore()
    await store.search({ presetId: 'preset-1' }, 'window-1')

    await expect(store.archiveTask('one', 'one', 'window-1')).rejects.toThrow('归档暂时不可用')
    expect(store.stateFor('window-1').items).toHaveLength(1)

    await store.archiveTask('one', 'one', 'window-1')
    expect(store.stateFor('window-1').items).toHaveLength(0)
    expect(store.stateFor('window-1').total).toBe(0)
  })

  it('keeps the current snapshot visible when refreshing fails', async () => {
    vi.spyOn(agentApi, 'listTasks')
      .mockResolvedValueOnce({ items: [item('one')], total: 1, snapshotAt: 1 })
      .mockRejectedValueOnce(new Error('网络暂时不可用'))
    const store = useTaskCatalogStore()

    await store.search({ presetId: 'preset-1' }, 'window-1')
    await store.search({ presetId: 'preset-1', query: 'new' }, 'window-1')

    expect(store.stateFor('window-1').items.map((entry) => entry.taskKey)).toEqual(['one'])
    expect(store.stateFor('window-1').error).toBe('网络暂时不可用')
  })
})
