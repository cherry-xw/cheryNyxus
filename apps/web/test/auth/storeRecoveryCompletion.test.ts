import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { agentApi, type ChatOpenResponse, type RootTimelineSnapshot } from '../../src/services/agentApi'
import { useChatSessionsStore } from '../../src/stores/chats'
import { useInteractionsStore } from '../../src/stores/interactions'
function timeline(): RootTimelineSnapshot { return { rootChatId: 'same-root', view: 'conversation', revision: 1, capturedEventSeq: 1, nodes: [], edges: [], generations: [], activeRuns: [], pendingInputs: [] } }
function opened(): ChatOpenResponse { return { chatId: 'same-root', subscriptionId: 'old-subscription', eventSeq: 1, timelineRevision: 1, timelineChanged: true, rootTimeline: timeline(), state: { chatIds: ['same-root'], pendingInputs: [], activeTurns: [], runs: [] } } }
describe('F05 real store late-response/resource matrix', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.restoreAllMocks() })
  it('late root open cannot recreate subscription, timeline or chat after instance reset', async () => {
    let finish!: (v: ChatOpenResponse) => void
    vi.spyOn(agentApi, 'openChat').mockImplementation(() => new Promise((r) => { finish = r }))
    const close = vi.spyOn(agentApi, 'closeChat').mockResolvedValue(undefined), store = useChatSessionsStore()
    const pending = store.observeRootTimeline('same-root', 'conversation'), rejected = expect(pending).rejects.toThrow('过期'); await Promise.resolve(); store.resetTarget(); finish(opened()); await rejected
    expect(store.rootSubscriptions).toEqual({}); expect(store.rootTimeline('same-root')).toBeUndefined(); expect(store.sessionsById).toEqual({}); expect(close).not.toHaveBeenCalled() // never send old ID to replacement target
  })
  it('late chat session open cannot hydrate a reset instance', async () => {
    let finish!: (v: ChatOpenResponse) => void; vi.spyOn(agentApi, 'openChat').mockImplementation(() => new Promise((r) => { finish = r }))
    const store = useChatSessionsStore(), pending = store.openSession('same-root'), rejected = expect(pending).rejects.toThrow('过期'); await vi.waitFor(() => expect(finish).toBeTypeOf('function')); store.resetTarget(); finish(opened()); await rejected; expect(store.sessionsById).toEqual({})
  })
  it('late tree snapshot is discarded and fresh persisted snapshot can be read again', async () => {
    vi.spyOn(agentApi, 'openChat').mockResolvedValue(opened()); vi.spyOn(agentApi, 'closeChat').mockResolvedValue(undefined)
    let finish!: (v: RootTimelineSnapshot) => void
    const read = vi.spyOn(agentApi, 'getRootTimeline').mockImplementation(() => new Promise((r) => { finish = r }))
    const store = useChatSessionsStore(), pending = store.observeRootTimeline('same-root', 'tree'), rejected = expect(pending).rejects.toThrow('过期')
    await vi.waitFor(() => expect(finish).toBeTypeOf('function')); store.resetTarget(); finish({ ...timeline(), view: 'tree' }); await rejected
    expect(store.rootTimeline('same-root', 'tree')).toBeUndefined(); read.mockResolvedValue({ ...timeline(), revision: 2, view: 'tree' }); expect(await store.observeRootTimeline('same-root', 'tree')).toMatchObject({ revision: 2 })
  })
  it('late interaction inbox cannot restore old approvals after reset; next refresh restores current facts', async () => {
    let finish!: (v: any) => void
    const read = vi.spyOn(agentApi, 'listInteractionPage').mockImplementation(() => new Promise((r) => { finish = r })), store = useInteractionsStore()
    const pending = store.refresh(); store.resetTarget(); finish({ interactions: [{ interactionId: 'old', status: 'pending', payload: {} }] }); await pending; expect(store.records).toEqual({}); expect(store.loading).toBe(false)
    read.mockResolvedValue({ interactions: [], serverNow: Date.now() } as never); await store.refresh(); expect(store.records).toEqual({}); expect(read).toHaveBeenCalledTimes(2)
  })
})
