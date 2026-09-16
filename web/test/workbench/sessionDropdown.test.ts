import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentApi, type ChatSummary } from '../../src/services/agentApi'
import {
  SESSION_PAGE_SIZE,
  useSessionDropdown,
} from '../../src/features/agent/workbench/useSessionDropdown'

function summary(id: string): ChatSummary {
  return { chatId: id, updatedAt: 0 }
}

function page(ids: string[], total: number) {
  return { chats: ids.map(summary), total }
}

describe('useSessionDropdown', () => {
  afterEach(() => vi.restoreAllMocks())

  it('loads the first page on open and reports hasMore', async () => {
    const list = vi
      .spyOn(agentApi, 'listChatsPaged')
      .mockResolvedValue(page(Array.from({ length: SESSION_PAGE_SIZE }, (_, i) => `s-${i}`), 35))
    const dropdown = useSessionDropdown({ presetId: 'preset-1' })

    await dropdown.open()

    expect(list).toHaveBeenCalledWith({
      scope: 'preset',
      presetId: 'preset-1',
      includePreview: true,
      limit: SESSION_PAGE_SIZE,
      offset: 0,
    })
    expect(dropdown.items.value).toHaveLength(SESSION_PAGE_SIZE)
    expect(dropdown.total.value).toBe(35)
    expect(dropdown.hasMore.value).toBe(true)
    expect(dropdown.loading.value).toBe(false)
  })

  it('appends pages without duplicates and stops when total is exhausted', async () => {
    const list = vi
      .spyOn(agentApi, 'listChatsPaged')
      .mockResolvedValueOnce(page(Array.from({ length: SESSION_PAGE_SIZE }, (_, i) => `s-${i}`), 25))
      .mockResolvedValueOnce(page(Array.from({ length: 5 }, (_, i) => `s-${i + SESSION_PAGE_SIZE}`), 25))
    const dropdown = useSessionDropdown({ presetName: 'research' })

    await dropdown.open()
    await dropdown.loadMore()
    await dropdown.loadMore()

    expect(list).toHaveBeenCalledTimes(2)
    expect(dropdown.items.value).toHaveLength(25)
    expect(dropdown.hasMore.value).toBe(false)
    // 去重：模拟分页边界返回重复 chatId 不追加
    const ids = new Set(dropdown.items.value.map((c) => c.chatId))
    expect(ids.size).toBe(25)
  })

  it('deduplicates overlapping pages at the boundary', async () => {
    vi.spyOn(agentApi, 'listChatsPaged')
      .mockResolvedValueOnce(page(['a', 'b', 'c'], 4))
      .mockResolvedValueOnce(page(['c', 'd'], 4))
    const dropdown = useSessionDropdown({ presetId: 'p' })

    await dropdown.open()
    await dropdown.loadMore()

    expect(dropdown.items.value.map((c) => c.chatId)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('records an error and keeps the list state on failure', async () => {
    const list = vi
      .spyOn(agentApi, 'listChatsPaged')
      .mockRejectedValueOnce(new Error('网络错误'))
      .mockResolvedValueOnce(page(['a'], 1))
    const dropdown = useSessionDropdown({ presetId: 'p' })

    await dropdown.open()
    expect(dropdown.error.value).toBe('网络错误')
    expect(dropdown.items.value).toEqual([])

    await dropdown.open()
    expect(dropdown.error.value).toBeUndefined()
    expect(dropdown.items.value.map((c) => c.chatId)).toEqual(['a'])
    expect(list).toHaveBeenCalledTimes(2)
  })
})
