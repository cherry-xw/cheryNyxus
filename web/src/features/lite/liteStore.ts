/**
 * 工作台 lite 极简 UI 状态（T33 L0 骨架）。
 * 数据流契约：docs/web/mcu-lite-workbench-ui.md §3（v0.2 定稿）。
 * L0 范围：连接/会话/hydration 状态机骨架；对话流渲染留 L1，交互留 L2。
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

export type LiteHydrationPhase = 'idle' | 'chat-list' | 'chat-open' | 'interaction-list' | 'ready' | 'failed'

interface LiteStoreState {
  /** windowId（presetId 维度）→ 视图激活态（per-window 独立，§2.1）。 */
  activeByWindow: Record<string, boolean>
  connection: LiteConnectionState
  hydration: LiteHydrationPhase
  /** 当前会话（E 定案：仅当前会话，单 root）。 */
  rootChatId: string | null
  presetName: string | null
  leanTimeline: LeanTimelineNode[]
  runningState: { runId: string; status: string; startedAt: number } | null
  pendingInteractionIds: string[]
}

export const useLiteStore = defineStore('lite-workbench', {
  state: (): LiteStoreState => ({
    activeByWindow: {},
    connection: { phase: 'idle', reconnectAttempts: 0, receivedBytes: 0 },
    hydration: 'idle',
    rootChatId: null,
    presetName: null,
    leanTimeline: [],
    runningState: null,
    pendingInteractionIds: [],
  }),
  getters: {
    isLiteActive(state): (windowId: string) => boolean {
      return (windowId) => !!state.activeByWindow[windowId]
    },
    isHydrated(state): boolean {
      return state.hydration === 'ready'
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
      // hydration 链 L0 骨架：连接就绪后由 L1 实装 chat.list → chat.open → interaction.list。
      this.hydration = this.connection.phase === 'connected' ? 'chat-list' : 'idle'
    },
    suspendView() {
      // §5.1：切回完整视图，lite 连接保留（单视图操作约束）；视图交互停由组件层 v-if 控制。
    },
    /** lite 事件入口（L0：仅更新连接/运行态骨架字段；完整映射留 L1 LiteEventMapper）。 */
    onLiteEvent(event: unknown) {
      const rec = event as { kind?: string; type?: string; data?: Record<string, unknown>; chatId?: string }
      if (rec?.kind !== 'notification') return
      if (rec.type === 'run.updated' && rec.data) {
        const runId = typeof rec.data.runId === 'string' ? rec.data.runId : this.runningState?.runId ?? ''
        const status = typeof rec.data.status === 'string' ? rec.data.status : 'running'
        if (status === 'running') {
          this.runningState = { runId, status, startedAt: Date.now() }
        } else {
          this.runningState = null
        }
      }
    },
    disconnect() {
      liteClient?.disconnect()
      liteClient = null
      this.hydration = 'idle'
      this.rootChatId = null
      this.leanTimeline = []
      this.runningState = null
    },
  },
})

/** lite 连接实例（模块级：Pinia state 需可序列化，连接对象为非响应式资源）。 */
let liteClient: LiteClient | null = null

export function getLiteClient(): LiteClient | null {
  return liteClient
}
