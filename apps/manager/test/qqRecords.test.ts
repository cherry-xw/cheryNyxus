import { describe, expect, it, vi } from 'vitest'
import { useQq } from '../../../plugins/qq/ui/useQq'
import { QQDefaultConfig, type QQEntry, type QQEntryDetail } from '../../../packages/protocol/src/qq'
import type { managerRequest } from '../../../packages/manager-ui/src/api'

const entry: QQEntry = {
  requestId: 'request-1', eventId: 'event-1', target: 'a'.repeat(64), targetId: '123', senderId: '456', senderName: '测试发送者', conversationType: 'group', state: 'completed', acceptedAt: 1, policyRevision: 0, preset: 'test', inputPreview: '测试消息', replyPreview: '已有回复', messageCount: 1, attachmentCount: 0,
  delivery: { pending: 0, inflight: 0, sent: 1, unknown: 0, failed: 0 },
}
const full: QQEntryDetail = { ...entry, messages: [{ eventId: 'event-1', senderId: '456', senderName: '测试发送者', content: '测试消息', contentTruncated: false, attachments: [] }], reply: '已有回复', replyTruncated: false, deliveries: [], deliveriesTruncated: false }
function fixture() {
  const request = vi.fn(async (path: string) => {
    if (path.endsWith('/config')) return { data: { config: structuredClone(QQDefaultConfig), baseRevision: 0, apply: { state: 'applied', revision: 0 } } }
    if (path.endsWith('/catalog')) return { data: { presets: [], tools: [] } }
    if (path.endsWith('/status')) return { data: {} }
    if (path.includes('/entry?')) return { data: structuredClone(full) }
    return { data: { entries: [structuredClone(entry)] } }
  })
  return { request, qq: useQq(request as typeof managerRequest) }
}

describe('QQ record loading and draft isolation', () => {
  it('does not eagerly download queue, history or details when opening settings', async () => {
    const { qq, request } = fixture()
    await qq.load()
    expect(qq.state.ready).toBe(true)
    expect(request.mock.calls.map(([path]) => path).sort()).toEqual(['/api/modules/capabilities/catalog', '/api/modules/qq/config', '/api/modules/qq/status'])
  })
  it('fetches details only on request, caches until refresh and preserves the settings draft', async () => {
    const { qq, request } = fixture()
    await qq.load()
    qq.state.config.pokeEnabled = !qq.state.config.pokeEnabled
    const draft = JSON.stringify(qq.state.config)
    await qq.refresh('history')
    expect(qq.state.history?.entries[0].inputPreview).toBe('测试消息')
    expect(qq.state.details).toEqual({})
    await qq.detail(entry.requestId); await qq.detail(entry.requestId)
    expect(qq.state.details[entry.requestId].reply).toBe('已有回复')
    expect(request.mock.calls.filter(([path]) => path.includes('/entry?'))).toHaveLength(1)
    await qq.refresh('queue')
    expect(qq.state.details).toEqual({})
    expect(JSON.stringify(qq.state.config)).toBe(draft)
    expect(qq.dirty.value).toBe(true)
  })
  it('keeps a malformed response distinct from an empty queue and does not discard the draft', async () => {
    const { qq, request } = fixture()
    await qq.read(); qq.add('users', '123')
    request.mockResolvedValueOnce({ data: { entries: [{ requestId: 'incomplete' }] } } as any)
    await qq.refresh('queue')
    expect(qq.state.queue).toBeNull()
    expect(qq.state.queueError).not.toBe('')
    expect(qq.state.config.users).toEqual(['123'])
    expect(qq.state.ready).toBe(true)
  })
  it('rejects mismatched details instead of showing another request', async () => {
    const { qq, request } = fixture()
    request.mockResolvedValueOnce({ data: { ...full, requestId: 'other' } } as any)
    await qq.detail(entry.requestId)
    expect(qq.state.details[entry.requestId]).toBeUndefined()
    expect(qq.state.detailErrors[entry.requestId]).toContain('不匹配')
    expect(qq.state.detailsLoading[entry.requestId]).toBe(false)
  })
  it('ignores stale detail responses after refreshing and permits a fresh expansion', async () => {
    const { qq, request } = fixture()
    let resolveOld!: (value: any) => void
    request.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
    const pending = qq.detail(entry.requestId)
    await qq.refresh('history')
    await qq.detail(entry.requestId)
    resolveOld({ data: { ...full, reply: '过期回复' } })
    await pending
    expect(qq.state.details[entry.requestId].reply).toBe('已有回复')
    expect(qq.state.detailsLoading[entry.requestId]).toBe(false)
  })
})
