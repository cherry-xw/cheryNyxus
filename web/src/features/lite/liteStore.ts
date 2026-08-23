/**
 * 工作台 lite 极简 UI 状态（T33 L0 + T34 L1）。
 * 数据流契约：docs/web/mcu-lite-workbench-ui.md §3/§4.1/§4.7（v0.2 定稿）。
 * L1：hydration 链（chat.list→chat.open→interaction.list）+ 事件映射 + 游标分页。
 */
import { defineStore } from 'pinia'
import { LiteClient, type LiteConnectionState } from '@/services/liteClient'

/** LeanTimelineNode（服务端 liteProjection 同构，字段集 v1 冻结）。 */
export interface LeanTimelineNode {
  id: string
  kind: 'message' | 'return' | 'dispatch' | 'system'
  actorKind: 'user' | 'agent' | 'system'
  actorRoleType?: string
  direction: string
  orderKey: number
  status: 'committed' | 'revoked'
  createdAt: number
  summary: string
  contentLength: number
  toolNames?: string[]
  termination?: Record<string, unknown>
  contentHash?: string
}

/** 最终回复（done.finalMessage 即时终态，§4.1；同 id patch upsert 去重 F2）。 */
export interface LiteFinalMessage {
  msgId: string
  content: string
  contentLength: number
  contentHash?: string
  receivedAt: number
}

export type LiteHydrationPhase =
  | 'idle'
  | 'chat-list'
  | 'chat-open'
  | 'interaction-list'
  | 'ready'
  | 'failed'

interface LiteStoreState {
  /** windowId（presetId 维度）→ 视图激活态（per-window 独立，§2.1）。 */
  activeByWindow: Record<string, boolean>
  connection: LiteConnectionState
  hydration: LiteHydrationPhase
  hydrationError: string | null
  /** 当前会话（E 定案：仅当前会话，单 root）。 */
  rootChatId: string | null
  presetName: string | null
  leanTimeline: LeanTimelineNode[]
  /** 时间线 revision（chat.open 快照 + patch.baseRevision→revision 自愈，F9）。 */
  timelineRevision: number | null
  hasMoreOlder: boolean
  nextCursor: number | null
  nodeCount: number | null
  runningState: { runId: string; status: string; startedAt: number } | null
  finalMessage: LiteFinalMessage | null
  /** interaction.changed 失效信号（§3.2：无 seq 必重拉；L2 消费）。 */
  interactionsStale: boolean
  pendingInteractionIds: string[]
}

interface ChatSummary {
  chatId: string
  title?: string
  presetId?: string
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export const useLiteStore = defineStore('lite-workbench', {
  state: (): LiteStoreState => ({
    activeByWindow: {},
    connection: { phase: 'idle', reconnectAttempts: 0, receivedBytes: 0 },
    hydration: 'idle',
    hydrationError: null,
    rootChatId: null,
    presetName: null,
    leanTimeline: [],
    timelineRevision: null,
    hasMoreOlder: false,
    nextCursor: null,
    nodeCount: null,
    runningState: null,
    finalMessage: null,
    interactionsStale: false,
    pendingInteractionIds: [],
  }),
  getters: {
    isLiteActive(state): (windowId: string) => boolean {
      return (windowId) => !!state.activeByWindow[windowId]
    },
    isHydrated(state): boolean {
      return state.hydration === 'ready'
    },
    /** 主对话流节点（§4.1）：用户消息（user actor）+ 主 agent 回复（agent-to-user）。
     * 子 agent 节点（parent-to-child/child-to-parent）不进主流——展开区维度。 */
    mainStreamNodes(state): LeanTimelineNode[] {
      return state.leanTimeline
        .filter((n) => n.status === 'committed')
        .filter(
          (n) =>
            n.actorKind === 'user' ||
            (n.actorKind === 'agent' && n.direction === 'agent-to-user'),
        )
        .sort((a, b) => a.orderKey - b.orderKey)
    },
    /** 中间过程节点（工具/思考，agent 内部向）：状态行维度。 */
    processNodes(state): LeanTimelineNode[] {
      return state.leanTimeline
        .filter((n) => n.status === 'committed')
        .filter((n) => n.actorKind === 'agent' && n.direction !== 'agent-to-user')
        .sort((a, b) => a.orderKey - b.orderKey)
    },
    /** 子任务维度节点（§4.1 展开：派发/回传）。 */
    subTaskNodes(state): LeanTimelineNode[] {
      return state.leanTimeline
        .filter((n) => n.status === 'committed')
        .filter(
          (n) => n.direction === 'parent-to-child' || n.direction === 'child-to-parent',
        )
        .sort((a, b) => a.orderKey - b.orderKey)
    },
  },
  actions: {
    /** 激活/切换（per-window 持久化由组件层 localStorage 处理，§2.1）。 */
    setActive(windowId: string, active: boolean) {
      this.activeByWindow = { ...this.activeByWindow, [windowId]: active }
      if (active) void this.boot()
      else this.suspendView()
    },
    async boot() {
      if (!liteClient) {
        liteClient = new LiteClient({
          onState: (s) => {
            this.connection = s
          },
          onEvent: (event) => this.onLiteEvent(event),
        })
      }
      if (this.connection.phase !== 'connected' && this.connection.phase !== 'connecting') {
        await liteClient.connect()
      }
      if (this.hydration !== 'ready') void this.hydrate()
    },
    /** hydration 链（§3.2，与固件一致）：chat.list → chat.open → interaction.list。 */
    async hydrate() {
      if (!liteClient) return
      try {
        // 1. chat.list({stage})——响应不做 lite 投影（§3.2 注），lean 目录依赖 scope 省略 preview。
        this.hydration = 'chat-list'
        const listRes = await liteClient.client.rpc('chat.list', { scope: 'stage' })
        if (!listRes.success) throw new Error(listRes.error?.message ?? 'chat.list 失败')
        const chats = (listRes.data as { chats?: ChatSummary[] } | undefined)?.chats ?? []
        if (chats.length === 0) {
          this.hydration = 'ready'
          return // 无会话：空视图（E 定案：不提供会话创建，从完整视图进入）
        }
        const chat = chats[0]
        if (!chat) {
          this.hydration = 'ready'
          return
        }

        // 2. chat.open（knownRevision 命中短路重连判定，F9）
        this.hydration = 'chat-open'
        this.rootChatId = chat.chatId
        if (chat.title) this.presetName = chat.title
        const openParams: Record<string, unknown> = { rootChatId: chat.chatId }
        if (this.timelineRevision !== null) openParams.knownTimelineRevision = this.timelineRevision
        const openRes = await liteClient.client.rpc('chat.open', openParams)
        if (!openRes.success) throw new Error(openRes.error?.message ?? 'chat.open 失败')
        const data = asRecord(openRes.data) ?? {}
        if (data.timelineUnchanged) {
          // 重连短路（§4.8）：本地 leanTimeline 原样可用
        } else {
          const timeline = asRecord(data.rootTimeline)
          const nodes = Array.isArray(timeline?.nodes) ? (timeline!.nodes as LeanTimelineNode[]) : []
          this.leanTimeline = nodes
          this.timelineRevision =
            typeof data.revision === 'number'
              ? data.revision
              : typeof timeline?.revision === 'number'
                ? timeline!.revision
                : null
          this.nodeCount = typeof timeline?.nodeCount === 'number' ? timeline!.nodeCount : nodes.length
          this.hasMoreOlder = timeline?.hasMore === true
          this.nextCursor = typeof timeline?.nextCursor === 'number' ? timeline!.nextCursor : null
          const state = asRecord(data.state)
          this.runningState =
            state && Array.isArray(state.activeTurns) && state.activeTurns.length > 0
              ? {
                  runId: '',
                  status: 'running',
                  startedAt: Date.now(),
                }
              : null
        }

        // 3. interaction.list（serverNow 校准留 L2 交互消费；此处取数）
        this.hydration = 'interaction-list'
        const ilRes = await liteClient.client.rpc('interaction.list', { maxItems: 20 })
        if (!ilRes.success) throw new Error(ilRes.error?.message ?? 'interaction.list 失败')
        const il = asRecord(ilRes.data)
        const interactions = Array.isArray(il?.interactions)
          ? (il!.interactions as Array<Record<string, unknown>>)
          : []
        this.pendingInteractionIds = interactions
          .filter((i) => typeof i.interactionId === 'string')
          .map((i) => i.interactionId as string)
        this.interactionsStale = false

        this.hydration = 'ready'
        this.hydrationError = null
      } catch (err) {
        this.hydration = 'failed'
        this.hydrationError = err instanceof Error ? err.message : String(err)
      }
    },
    /** 加载更早（§4.7 游标分页）：chat.timeline.get({before: nextCursor, limit})。 */
    async loadOlder(): Promise<boolean> {
      if (!liteClient || !this.rootChatId || !this.hasMoreOlder || this.nextCursor === null) {
        return false
      }
      const res = await liteClient.client.rpc('chat.timeline.get', {
        rootChatId: this.rootChatId,
        before: this.nextCursor,
        limit: 20,
      })
      if (!res.success) return false
      const timeline = asRecord(asRecord(res.data)?.rootTimeline)
      if (!timeline || !Array.isArray(timeline.nodes)) return false
      const older = timeline.nodes as LeanTimelineNode[]
      // 按 id 去重合并（服务端排他下界保证无重叠，防御性处理）
      const seen = new Set(this.leanTimeline.map((n) => n.id))
      this.leanTimeline = [...older.filter((n) => !seen.has(n.id)), ...this.leanTimeline]
      this.hasMoreOlder = timeline.hasMore === true
      this.nextCursor = typeof timeline.nextCursor === 'number' ? timeline.nextCursor : null
      if (typeof timeline.nodeCount === 'number') this.nodeCount = timeline.nodeCount
      return true
    },
    suspendView() {
      // §5.1：切回完整视图，lite 连接保留（单视图操作约束）；视图交互停由组件层 v-if 控制。
    },
    /** lite 事件映射（§3.2 实时增量；T26 折叠规则）。 */
    onLiteEvent(event: unknown) {
      const rec = event as {
        kind?: string
        type?: string
        chatId?: string
        rootChatId?: string
        data?: Record<string, unknown>
      }
      if (rec?.kind !== 'notification') return
      const type = rec.type ?? ''

      // run.updated：chatId==rootChatId 为唯一权威工作态（T26）；子 chat 不污染主视图。
      if (type === 'run.updated' && rec.data) {
        if (rec.chatId !== this.rootChatId) return
        const runId = typeof rec.data.runId === 'string' ? rec.data.runId : this.runningState?.runId ?? ''
        const status = typeof rec.data.status === 'string' ? rec.data.status : 'running'
        if (status === 'running') {
          this.runningState = { runId, status, startedAt: Date.now() }
        } else {
          this.runningState = null
        }
        return
      }

      // done.finalMessage：主回复即时终态（§4.1 T31 W2 修正）。
      if (type === 'done' && rec.data) {
        const fm = asRecord(rec.data.finalMessage)
        if (fm && typeof fm.msgId === 'string') {
          // 同 msgId patch upsert 去重（F2）：patch 权威节点存在则不覆盖摘要显示
          const fromPatch = this.leanTimeline.some(
            (n) => n.id === fm.msgId || (n.actorKind === 'agent' && n.direction === 'agent-to-user' && n.orderKey > 0 && this.finalMessage?.msgId === fm.msgId),
          )
          if (!fromPatch || !this.finalMessage) {
            this.finalMessage = {
              msgId: fm.msgId,
              content: typeof fm.content === 'string' ? fm.content : '',
              contentLength: typeof fm.contentLength === 'number' ? fm.contentLength : 0,
              ...(typeof fm.contentHash === 'string' ? { contentHash: fm.contentHash } : {}),
              receivedAt: Date.now(),
            }
          }
        }
        return
      }

      // timeline.patch：lean upsert（历史权威）+ revision 自愈（F9）。
      if (type === 'timeline.patch' && rec.data) {
        this.applyTimelinePatch(rec.data)
        return
      }

      // interaction.changed：失效信号（无 seq 必重拉，C5；L2 消费重拉）。
      if (type === 'interaction.changed') {
        this.interactionsStale = true
        return
      }

      // turn.started/completed、子 chat 事件：T26 折叠——不驱动主视图（状态由 run.updated +
      // patch 节点状态表达）；error 事件留 L2 UI 分支。
    },
    applyTimelinePatch(data: Record<string, unknown>) {
      const rootPatch = asRecord(data.rootPatch) ?? data
      const patch = asRecord(rootPatch.rootPatch) ?? rootPatch
      const operations = Array.isArray(patch.operations) ? patch.operations : []
      for (const opRaw of operations) {
        const op = asRecord(opRaw)
        if (!op) continue
        if (op.type === 'upsert' && op.node) {
          const node = op.node as LeanTimelineNode
          const idx = this.leanTimeline.findIndex((n) => n.id === node.id)
          if (idx >= 0) this.leanTimeline.splice(idx, 1, node)
          else this.leanTimeline.push(node)
        } else if (op.type === 'revoke' && typeof op.nodeId === 'string') {
          const idx = this.leanTimeline.findIndex((n) => n.id === op.nodeId)
          if (idx >= 0) {
            const n = this.leanTimeline[idx]
            if (n) this.leanTimeline.splice(idx, 1, { ...n, status: 'revoked' })
          }
        }
      }
      if (typeof patch.revision === 'number') this.timelineRevision = patch.revision
    },
    disconnect() {
      liteClient?.disconnect()
      liteClient = null
      this.hydration = 'idle'
      this.rootChatId = null
      this.leanTimeline = []
      this.runningState = null
      this.finalMessage = null
      this.hasMoreOlder = false
      this.nextCursor = null
      this.nodeCount = null
    },
  },
})

/** lite 连接实例（模块级：Pinia state 需可序列化，连接对象为非响应式资源）。 */
let liteClient: LiteClient | null = null

export function getLiteClient(): LiteClient | null {
  return liteClient
}
