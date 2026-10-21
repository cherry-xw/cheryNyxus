import { reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import { AgentCommandLogEventSchema, AgentCommandUpdatedSchema, type AgentCommandRecord, type AgentCommandMethodMap,
  type CommandLogChunk, type CommandLogGap } from '@chery/protocol'
import { agentCommandsApi as api } from '@/services/agentCommandsApi'
import { mergeCommandChunks, mergeCommandGaps } from '@/domain/commands/logView'

type Query = AgentCommandMethodMap['agent.command.list']['params']
interface ListView { query: Query; ids: string[]; cursor: AgentCommandMethodMap['agent.command.list']['result']['nextCursor']; loading: boolean; error: string; request: number }
interface LogView { chunks: CommandLogChunk[]; gaps: CommandLogGap[]; cursor: number; initialized: boolean; follow: boolean;
  hasMore: boolean; loading: boolean; error: string; trimmed: boolean; refs: number; subscription?: string }
const message = (error: unknown) => error instanceof Error ? error.message : '命令信息读取失败'

export const useAgentCommandsStore = defineStore('agentCommands', () => {
  const records = reactive<Record<string, AgentCommandRecord>>({})
  const views = reactive<Record<string, ListView>>({})
  const logs = reactive<Record<string, LogView>>({})
  const online = ref(false)
  const subscriptionError = ref('')
  const targetRevision = ref(0)
  let epoch = 0
  let nextView = 0
  let subscription: string | undefined
  let subscribing = false
  const detailsOpening = new Set<string>()

  function upsert(record: AgentCommandRecord) {
    if (!records[record.commandId] || record.version >= records[record.commandId]!.version) records[record.commandId] = record
  }
  function createView(chatId?: string): string {
    const id = `commands:${++nextView}`
    views[id] = { query: { ...(chatId ? { chatId, includeChildren: true } : {}), scope: 'active', limit: 50 }, ids: [], cursor: null, loading: false, error: '', request: 0 }
    void ensureSubscription()
    if (subscription) void load(id)
    return id
  }
  function releaseView(id: string) {
    delete views[id]
    if (!Object.keys(views).length && subscription) {
      const old = subscription
      subscription = undefined
      void api.unsubscribe(old).catch(() => {})
    }
    prune()
  }
  function prune() {
    const retained = new Set(Object.values(views).flatMap(view => view.ids))
    for (const [id, log] of Object.entries(logs)) if (log.refs) retained.add(id)
    for (const id of Object.keys(records)) if (!retained.has(id)) delete records[id]
  }
  async function load(id: string, more = false) {
    const view = views[id]
    if (!view || more && view.loading || !online.value) return
    const generation = epoch
    const request = ++view.request
    view.loading = true
    view.error = ''
    try {
      const result = await api.list({ ...view.query, ...(more && view.cursor ? { before: view.cursor } : {}) })
      if (generation !== epoch || views[id] !== view || view.request !== request) return
      result.commands.forEach(upsert)
      view.ids = [...new Set([...(more ? view.ids : []), ...result.commands.map(item => item.commandId)])].slice(-500)
      view.cursor = result.nextCursor
      prune()
    } catch (error) { if (generation === epoch && views[id] === view && view.request === request) view.error = message(error) }
    finally { if (generation === epoch && view.request === request) view.loading = false }
  }
  async function ensureSubscription() {
    if (!online.value || subscription || subscribing || !Object.keys(views).length) return
    const generation = epoch
    subscribing = true
    try {
      const result = await api.subscribe({})
      if (generation !== epoch || !Object.keys(views).length) { if (generation === epoch) void api.unsubscribe(result.subscriptionId).catch(() => {}); return }
      subscription = result.subscriptionId
      subscriptionError.value = ''
      // Subscription precedes the snapshot so an opening window cannot miss a new command.
      await Promise.all(Object.keys(views).map(id => load(id)))
    } catch (error) { if (generation === epoch) subscriptionError.value = message(error) }
    finally { if (generation === epoch) subscribing = false }
  }
  function acquireLog(id: string) {
    const view = logs[id] ??= { chunks: [], gaps: [], cursor: 0, initialized: false, follow: true, hasMore: false,
      loading: false, error: '', trimmed: false, refs: 0 }
    view.refs++
    void openDetail(id)
  }
  function releaseLog(id: string) {
    const view = logs[id]
    if (!view || --view.refs > 0) return
    if (view.subscription) void api.unsubscribe(view.subscription).catch(() => {})
    delete logs[id]
    prune()
  }
  async function openDetail(id: string) {
    const view = logs[id]
    if (!view || !online.value || detailsOpening.has(id)) return
    const generation = epoch
    detailsOpening.add(id)
    try {
      if (!view.subscription) {
        const result = await api.subscribe({ commandId: id })
        if (generation !== epoch || logs[id] !== view) { if (generation === epoch) void api.unsubscribe(result.subscriptionId).catch(() => {}); return }
        view.subscription = result.subscriptionId
      }
      await readLog(id, view.initialized ? 'catchup' : 'latest')
    } catch (error) { if (generation === epoch) view.error = message(error) }
    finally { if (generation === epoch) detailsOpening.delete(id) }
  }
  async function readLog(id: string, mode: 'latest' | 'first' | 'older' | 'newer' | 'catchup' = 'latest') {
    const view = logs[id]
    if (!view || view.loading || !online.value) return
    const generation = epoch
    view.loading = true
    view.error = ''
    const backward = mode === 'latest' || mode === 'older'
    const cursor = mode === 'older' ? view.chunks[0]?.sequence : mode === 'first' ? 0 : mode === 'newer' ? view.chunks.at(-1)?.sequence : mode === 'catchup' ? view.cursor : undefined
    const previous = mode === 'catchup' || mode === 'latest' ? view.chunks : []
    if (mode !== 'catchup') view.follow = mode === 'latest'
    try {
      const page = await api.logs({ commandId: id, direction: backward ? 'backward' : 'forward', ...(cursor === undefined ? {} : { cursor }), limit: 16 })
      if (generation !== epoch || logs[id] !== view) return
      upsert(page.command)
      // Retain live chunks received while the read was pending; duplicate sequences collapse.
      const live = view.follow ? view.chunks.filter(chunk => chunk.sequence > (page.chunks.at(-1)?.sequence ?? cursor ?? 0)) : []
      const merged = mergeCommandChunks(mode === 'catchup' ? previous : [], [...page.chunks, ...live])
      view.chunks = merged.chunks
      view.trimmed = mode === 'catchup' ? view.trimmed || merged.trimmed : merged.trimmed
      view.gaps = mergeCommandGaps(merged.chunks, [...(mode === 'catchup' ? view.gaps : []), ...page.gaps])
      view.cursor = backward ? page.command.logSequence : page.nextCursor
      view.hasMore = page.hasMore
      view.initialized = true
    } catch (error) { if (generation === epoch) view.error = message(error) }
    finally { if (generation === epoch) view.loading = false }
  }
  async function stop(id: string) {
    const generation = epoch
    const result = await api.stop(id)
    if (generation !== epoch) return
    upsert(result.command)
    if (!result.accepted) throw new Error('当前进程没有该命令的执行句柄；停止结果未确认')
  }
  function apply(notification: unknown) {
    const event = notification as { type?: string; data?: unknown } | null
    if (event?.type === 'agent.command.updated') {
      const parsed = AgentCommandUpdatedSchema.safeParse(event.data)
      if (!parsed.success) return
      const { subscriptionId, command } = parsed.data
      if (subscriptionId !== subscription && subscriptionId !== logs[command.commandId]?.subscription) return
      upsert(command)
      // Refresh the relevant bounded pages instead of guessing descendant membership in the browser.
      for (const id of Object.keys(views)) if (subscriptionId === subscription) dirty.add(id)
      prune()
    } else if (event?.type === 'agent.command.log.chunk') {
      const parsed = AgentCommandLogEventSchema.safeParse(event.data)
      if (!parsed.success) return
      const view = logs[parsed.data.chunk.commandId]
      if (!view || view.subscription !== parsed.data.subscriptionId || !view.follow) return
      const merged = mergeCommandChunks(view.chunks, [parsed.data.chunk])
      view.chunks = merged.chunks
      view.gaps = mergeCommandGaps(merged.chunks, view.gaps)
      view.trimmed ||= merged.trimmed
    }
  }
  const dirty = new Set<string>()
  function connectionChanged(status: string) {
    epoch++
    online.value = status === 'connected'
    subscription = undefined
    subscribing = false
    detailsOpening.clear()
    for (const view of Object.values(views)) view.loading = false
    for (const view of Object.values(logs)) { view.subscription = undefined; view.loading = false }
    if (online.value) { void ensureSubscription(); for (const id of Object.keys(logs)) void openDetail(id) }
  }
  function poll() {
    if (!online.value) return
    void ensureSubscription()
    for (const id of dirty) if (!views[id]?.loading) { dirty.delete(id); void load(id) }
    for (const [id, view] of Object.entries(logs)) if (view.follow) {
      if (!view.subscription) void openDetail(id)
      else void readLog(id, view.initialized ? 'catchup' : 'latest')
    }
  }
  function resetTarget() {
    // Target changes close the old connection. Never send its IDs to a replacement server/account.
    connectionChanged('disconnected')
    for (const view of Object.values(views)) { view.ids = []; view.cursor = null; view.loading = false; view.error = '' }
    for (const id of Object.keys(logs)) delete logs[id]
    for (const id of Object.keys(records)) delete records[id]
    dirty.clear()
    subscriptionError.value = ''
    targetRevision.value++
  }
  return { records, views, logs, online, subscriptionError, targetRevision, createView, releaseView, load, acquireLog, releaseLog, readLog, stop,
    apply, connectionChanged, resetTarget, poll }
})
