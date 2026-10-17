import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFileDraftLeases } from '@/application/files/draftLeases'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('浏览器文件草稿保留', () => {
  it('草稿不依赖面板挂载持续续期，并纳入后完成的上传和适配版本', async () => {
    const api = { contextKey: () => 'backend:owner', retainDraft: vi.fn().mockResolvedValue({}) }
    const leases = createFileDraftLeases(api)
    const refs = [{ assetId: 'file', assetVersionId: 'original' }]
    try {
      leases.set('closed-panel', api.contextKey(), () => refs)
      const leaseId = api.retainDraft.mock.calls[0]![0]
      refs.push({ assetId: 'file', assetVersionId: 'adapted' })
      await vi.advanceTimersByTimeAsync(6 * 60_000)
      expect(api.retainDraft).toHaveBeenCalledTimes(7)
      expect(api.retainDraft.mock.lastCall).toEqual([leaseId, refs])
      leases.drop('closed-panel')
      expect(api.retainDraft.mock.lastCall).toEqual([leaseId, []])
      const calls = api.retainDraft.mock.calls.length
      await vi.advanceTimersByTimeAsync(60_000)
      expect(api.retainDraft).toHaveBeenCalledTimes(calls)
    } finally { leases.dispose() }
  })

  it('后端或身份改变时不向新身份续期旧草稿，恢复原身份后才继续', async () => {
    let context = 'one'
    const api = { contextKey: () => context, retainDraft: vi.fn().mockResolvedValue({}) }
    const leases = createFileDraftLeases(api)
    try {
      leases.set('first', context, () => [{ assetId: 'private-one', assetVersionId: 'one' }])
      context = 'two'
      leases.set('first', 'one', () => [{ assetId: 'private-one', assetVersionId: 'one' }])
      await vi.advanceTimersByTimeAsync(120_000)
      expect(api.retainDraft).toHaveBeenCalledTimes(1)
      leases.set('second', context, () => [{ assetId: 'private-two', assetVersionId: 'two' }])
      await vi.advanceTimersByTimeAsync(60_000)
      expect(api.retainDraft.mock.calls.slice(1).flatMap(call => call[1])).toEqual([
        { assetId: 'private-two', assetVersionId: 'two' }, { assetId: 'private-two', assetVersionId: 'two' },
      ])
      context = 'one'
      await vi.advanceTimersByTimeAsync(60_000)
      expect(api.retainDraft.mock.lastCall?.[1]).toEqual([{ assetId: 'private-one', assetVersionId: 'one' }])
    } finally { leases.dispose() }
  })

  it('已解除草稿的迟到失败不覆盖当前界面提示', async () => {
    let fail!: (reason: Error) => void
    const api = { contextKey: () => 'owner', retainDraft: vi.fn().mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
      .mockResolvedValue({}) }
    const leases = createFileDraftLeases(api)
    const onError = vi.fn()
    try {
      leases.set('draft', 'owner', () => [{ assetId: 'file', assetVersionId: 'one' }], onError)
      leases.drop('draft')
      fail(new Error('old response'))
      await Promise.resolve()
      expect(onError).not.toHaveBeenCalled()
    } finally { leases.dispose() }
  })
})
