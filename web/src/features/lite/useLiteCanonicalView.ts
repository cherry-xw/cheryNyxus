import { reactive, ref } from 'vue'
import {
  agentApi,
  type InteractionRecord,
  type SenseToolInfo,
  type TimelineNode,
} from '@/services/agentApi'
import { useChatSessionsStore, useConnectionStore, useInteractionsStore } from '@/stores'
import { selectCanResume } from '@/stores/chats/selectors'
import type { ExecutionReadModel } from '@/stores/chats/executionReadModel'
import type { LiteToolMeta } from './executionMonitor'
import { useLiteStore } from './liteStore'

export interface LeanTimelineNode {
  id: string
  kind: TimelineNode['kind']
  actorKind: TimelineNode['actor']['kind']
  direction: TimelineNode['direction']
  orderKey: number
  status: TimelineNode['status']
  createdAt: number
  summary: string
  contentLength: number
  toolNames?: string[]
  termination?: Record<string, unknown>
}

export type LiteInteraction = InteractionRecord

type LiteConnectionPhase = 'idle' | 'connecting' | 'connected' | 'reconnecting'

function toLeanNode(node: TimelineNode): LeanTimelineNode {
  const toolNames = node.toolCalls?.map((call) => call.name).filter(Boolean)
  const isConversationMessage =
    node.actor.kind === 'user' ||
    (node.actor.kind === 'agent' && node.direction === 'agent-to-user')
  return {
    id: node.id,
    kind: node.kind,
    actorKind: node.actor.kind,
    direction: node.direction,
    orderKey: node.orderKey,
    status: node.status,
    createdAt: node.createdAt,
    // Internal/tool rows remain name-only in Lite. Full content stays in the
    // canonical timeline and is requested by the existing detail affordance.
    summary: isConversationMessage ? node.content : toolNames?.join(', ') || node.kind,
    contentLength: node.content.length,
    ...(toolNames?.length ? { toolNames } : {}),
    ...(node.termination
      ? { termination: node.termination as unknown as Record<string, unknown> }
      : {}),
  }
}

function errorFact(cause: unknown, fallback: string): { code: string; message: string } {
  const error = cause as Error & { code?: string }
  return {
    code: error?.code ?? 'INTERNAL',
    message: error instanceof Error ? error.message : fallback,
  }
}

/**
 * Compatibility view model for the existing Lite shell. Every domain read and
 * command delegates to the canonical stores already used by WorkbenchDialog.
 * It deliberately owns no connection, subscription, hydration or replay state.
 */
export function useLiteCanonicalView(windowId: () => string, rootChatId: () => string) {
  const chats = useChatSessionsStore()
  const connection = useConnectionStore()
  const interactions = useInteractionsStore()
  const uiStore = useLiteStore()

  const root = () => rootChatId()
  const timeline = () =>
    chats.rootTimeline(root(), 'conversation') ??
    chats.rootTimeline(root(), 'tree') ??
    chats.rootTimeline(root(), 'audit')
  const execution = () => chats.executionReadModel(root())
  const rootUi = () => uiStore.ensureRootUi(windowId(), root())

  /** sense.tools 元信息缓存：工具中文名 + 图标（展示用，失败降级为空表）。 */
  const senseTools = ref<SenseToolInfo[]>([])
  let senseToolsLoaded = false
  async function fetchSenseTools(): Promise<void> {
    if (senseToolsLoaded) return
    senseToolsLoaded = true
    try {
      senseTools.value = await agentApi.listSenseTools()
    } catch {
      // 容错降级：保持空表，展示时回退英文原名 / 默认图标
    }
  }
  function toolMeta(name: string): LiteToolMeta | undefined {
    const tool = senseTools.value.find((item) => item.name === name)
    return tool ? { label: tool.label, icon: tool.icon } : undefined
  }

  function setCommandError(
    error: { code: string; message: string; interactionId?: string } | null,
  ): void {
    uiStore.patchRootUi(windowId(), root(), { commandError: error })
  }

  function resolveDetailNodeId(id: string): string | null {
    const nodes = timeline()?.nodes ?? []
    return nodes.find((node) => node.id === id || node.sourceMessageId === id)?.id ?? null
  }

  return reactive({
    get rootChatId(): string {
      return root()
    },
    get connection(): {
      phase: LiteConnectionPhase
    } {
      const phase: LiteConnectionPhase =
        connection.status === 'connected'
          ? 'connected'
          : connection.status === 'connecting'
            ? 'connecting'
            : connection.error || root() || timeline()
              ? 'reconnecting'
              : 'idle'
      return { phase }
    },
    get hydration(): 'idle' | 'chat-open' | 'ready' | 'failed' {
      if (timeline()) return 'ready'
      if (connection.status === 'connected') return 'chat-open'
      return connection.error ? 'failed' : 'idle'
    },
    get hydrationError(): string | null {
      return connection.error
    },
    get execution(): ExecutionReadModel {
      return execution()
    },
    get leanTimeline(): LeanTimelineNode[] {
      return (timeline()?.nodes ?? []).map(toLeanNode)
    },
    /** 运行历史投影的权威数据源：全部已提交节点（含工具批/消息），按 orderKey 排序由投影器处理。 */
    get runNodes(): TimelineNode[] {
      return (timeline()?.nodes ?? []).filter((node) => node.status === 'committed')
    },
    get mainStreamNodes(): LeanTimelineNode[] {
      return (timeline()?.nodes ?? [])
        .filter(
          (node) =>
            node.status === 'committed' &&
            node.sourceChatId === root() &&
            (node.actor.kind === 'user' ||
              (node.actor.kind === 'agent' && node.direction === 'agent-to-user')),
        )
        .map(toLeanNode)
        .sort((a, b) => a.orderKey - b.orderKey)
    },
    get processNodes(): LeanTimelineNode[] {
      return (timeline()?.nodes ?? [])
        .filter(
          (node) =>
            node.status === 'committed' &&
            node.actor.kind === 'agent' &&
            node.direction !== 'agent-to-user',
        )
        .map(toLeanNode)
        .sort((a, b) => a.orderKey - b.orderKey)
    },
    get subTaskNodes(): LeanTimelineNode[] {
      return (timeline()?.nodes ?? [])
        .filter(
          (node) =>
            node.status === 'committed' &&
            (node.direction === 'parent-to-child' || node.direction === 'child-to-parent'),
        )
        .map(toLeanNode)
        .sort((a, b) => a.orderKey - b.orderKey)
    },
    get nodeCount(): number {
      return timeline()?.nodes.length ?? 0
    },
    get hasMoreOlder(): boolean {
      // Canonical generations are loaded through the shared chat store. Task 4
      // supplies the explicit lazy-detail control instead of a private pager.
      return false
    },
    get finalMessage(): {
      msgId: string
      nodeId: string | null
      content: string
      contentLength: number
      receivedAt: number
    } | null {
      const final = execution().finalResponse
      return final
        ? {
            msgId: final.id,
            nodeId: resolveDetailNodeId(final.id),
            content: final.content,
            contentLength: final.content.length,
            receivedAt: final.updatedAt,
          }
        : null
    },
    get runningState(): { runId: string; status: string; startedAt: number } | null {
      const model = execution()
      return model.status === 'running' || model.status === 'waiting'
        ? {
            runId: model.runId ?? '',
            status: model.status,
            startedAt: model.startedAt ?? Date.now(),
          }
        : null
    },
    get canResume(): boolean {
      const session = chats.sessionsById[root()]
      return session ? selectCanResume(session) : execution().status === 'paused'
    },
    get interactions(): InteractionRecord[] {
      return interactions.all
        .filter((item) => item.rootChatId === root())
        .sort((a, b) => {
          const aPending = ['pending', 'resolving', 'blocked'].includes(a.status) ? 0 : 1
          const bPending = ['pending', 'resolving', 'blocked'].includes(b.status) ? 0 : 1
          return aPending - bPending || b.updatedAt - a.updatedAt
        })
    },
    get commandGate() {
      // Register the reactive dependency; canonical availability reads the same
      // socket's imperative status to keep every command adapter on one gate.
      void connection.status
      return chats.commandAvailability(root())
    },
    get outgoingMessages() {
      const session = chats.sessionsById[root()]
      return (session?.messageOrder ?? [])
        .map((id) => session?.messagesById[id])
        .filter(
          (message): message is NonNullable<typeof message> =>
            message?.role === 'user' && !!message.delivery,
        )
    },
    get lastCommandError(): {
      code: string
      message: string
      interactionId?: string
    } | null {
      return rootUi().commandError
    },
    set lastCommandError(value) {
      setCommandError(value)
    },
    async loadOlder(): Promise<boolean> {
      return false
    },
    async refreshInteractions(): Promise<void> {
      await interactions.refresh()
    },
    async submitInput(content: string): Promise<boolean> {
      try {
        const prepared = chats.prepareInput(root(), content)
        await chats.submitInput(root(), content, undefined, prepared)
        return true
      } catch {
        return false
      }
    },
    async retryInput(messageId: string): Promise<boolean> {
      try {
        await chats.retryInput(root(), messageId)
        return true
      } catch {
        return false
      }
    },
    removeFailedInput(messageId: string): boolean {
      return chats.removeFailedInput(root(), messageId)
    },
    interactionError(interactionId: string) {
      return interactions.errorsById[interactionId] ?? null
    },
    questionError(interactionId: string, questionId: string) {
      return interactions.questionErrorsById[interactionId]?.[questionId] ?? null
    },
    async decideApproval(interactionId: string, action: 'accept' | 'reject'): Promise<boolean> {
      const interaction = interactions.records[interactionId]
      if (!interaction) return false
      try {
        await interactions.decide(interaction, action)
        return true
      } catch {
        return false
      }
    },
    async answerQuestion(
      interactionId: string,
      answers: Array<{
        questionId: string
        selectedLabels?: string[]
        /** 每选项补充描述：label → note（可选，向后兼容；仅已选选项生效）。 */
        optionNotes?: Record<string, string>
        freeText?: string
        cancelled?: boolean
      }>,
    ): Promise<boolean> {
      const interaction = interactions.records[interactionId]
      if (!interaction) return false
      try {
        await interactions.answer(
          interaction,
          answers.map((answer) => ({
            questionId: answer.questionId,
            selectedLabels: answer.selectedLabels ?? [],
            ...(answer.optionNotes ? { optionNotes: answer.optionNotes } : {}),
            ...(answer.freeText ? { freeText: answer.freeText } : {}),
            ...(answer.cancelled ? { cancelled: true } : {}),
          })),
        )
        return true
      } catch {
        return false
      }
    },
    async abortRun(): Promise<boolean> {
      try {
        await chats.abortAgent(root())
        setCommandError(null)
        return true
      } catch (cause) {
        setCommandError(errorFact(cause, '停止失败'))
        return false
      }
    },
    async resumeRun(): Promise<boolean> {
      try {
        await chats.resumeAgent(root())
        setCommandError(null)
        return true
      } catch (cause) {
        setCommandError(errorFact(cause, '继续失败'))
        return false
      }
    },
    async fetchNodeDetail(
      nodeId: string,
      options: {
        sections?: Array<'content' | 'thinking' | 'toolCalls'>
        offset?: number
        limit?: number
      } = {},
    ) {
      try {
        const data = await agentApi.getTimelineNode({
          rootChatId: root(),
          nodeId,
          ...options,
        })
        return { success: true as const, data }
      } catch (cause) {
        const error = errorFact(cause, '详情加载失败')
        if (error.code === 'RATE_LIMITED') setCommandError(error)
        return { success: false as const, error }
      }
    },
    calibratedNow(): number {
      const offset = chats.sessionsById[root()]?.context.serverClockOffsetMs
      return offset === undefined ? interactions.calibratedNow() : Date.now() + offset
    },
    detailNodeIdForMessage(messageId: string): string | null {
      return resolveDetailNodeId(messageId)
    },
    detailNodeIdForToolCall(callId: string): string | null {
      return (
        timeline()?.nodes.find((node) => node.toolCalls?.some((call) => call.callId === callId))
          ?.id ?? null
      )
    },
    get senseTools(): SenseToolInfo[] {
      return senseTools.value
    },
    loadSenseTools: fetchSenseTools,
    toolMeta,
  })
}
