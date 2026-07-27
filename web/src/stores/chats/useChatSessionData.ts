/**
 * useChatSessionData：ChatSession store 的响应式只读视图 composable。
 *
 * 把 [selectors.ts](./selectors) 的纯函数包成 computed，供 Vue 组件 reactive 消费。
 * 消费层（Pet 气泡 / HistoryDrawer / PetIcons / 工具栏）经此 hook 读取，不直接访问 sessionsById。
 *
 * 数据由 [index.ts](./index.ts) `applyEvent`/`replaceSnapshot` 单写者维护；
 * App.vue 已挂载 `bindWsClient`，故 sessionsById 随 WS 事件实时更新，computed 自动重算。
 */
import { computed, type ComputedRef } from 'vue'
import { useChatSessionsStore } from './index'
import type { ChatSession, ChatMessage } from './types'
import type { HistoryItem } from '../agents/types'
import type { ApprovalState, QuestionItemState, RunningTool } from '../agents/types'
import type {
  ContextBreakdown,
  RuntimeSelection,
  PendingInput,
  ActiveTurnSnapshot,
} from '@/services/agentApi'
import {
  selectBubble,
  selectActiveMessage,
  selectMessages,
  selectOwnTimeline,
  selectGroupTimeline,
  selectIsWorking,
  selectCanResume,
  selectRuntime,
  selectContextUsage,
  selectContextBreakdown,
  selectApproval,
  selectApprovalQueue,
  selectQuestionBatches,
  selectActiveQuestionId,
  selectRunningTools,
  selectCurrentTodo,
  selectLoaded,
  type BubbleView,
} from './selectors'
import { flattenQuestionItems, findQuestion } from '../agents/actions/questionBatch'

/** null-safe session 取值（chatId 无对应实体 -> undefined）。 */
function sessionOf(
  sessionsById: Record<string, ChatSession>,
  chatId: string | undefined,
): ChatSession | undefined {
  if (!chatId) return undefined
  return sessionsById[chatId]
}

export interface ChatSessionData {
  session: ComputedRef<ChatSession | undefined>
  activeMessage: ComputedRef<ChatMessage | undefined>
  messages: ComputedRef<ChatMessage[]>
  bubble: ComputedRef<BubbleView>
  isWorking: ComputedRef<boolean>
  canResume: ComputedRef<boolean>
  runtime: ComputedRef<RuntimeSelection | undefined>
  contextUsage: ComputedRef<number | undefined>
  contextBreakdown: ComputedRef<ContextBreakdown | undefined>
  approval: ComputedRef<ApprovalState | undefined>
  approvalQueue: ComputedRef<ApprovalState[]>
  questionItems: ComputedRef<QuestionItemState[]>
  activeQuestionId: ComputedRef<string | undefined>
  activeQuestion: ComputedRef<
    | { batch: { batchId: string; questions: QuestionItemState[] }; question: QuestionItemState }
    | undefined
  >
  runningTools: ComputedRef<RunningTool[]>
  currentTodo: ComputedRef<unknown[] | undefined>
  loaded: ComputedRef<boolean>
  ownTimeline: ComputedRef<HistoryItem[]>
  /** 群聊时间线（root + descendants 聚合）；子 chat 自身抽屉用 ownTimeline。 */
  groupTimeline: ComputedRef<HistoryItem[]>
  /** V2 session-plane transient inputs/turns; never folded into canonical history. */
  pendingInputs: ComputedRef<PendingInput[]>
  activeTurns: ComputedRef<ActiveTurnSnapshot[]>
  timelineRevision: ComputedRef<number | undefined>
}

/**
 * 单 chat 数据视图。chatId 可为响应式 getter 或静态字符串。
 */
export function useChatSessionData(chatId: (() => string | undefined) | string): ChatSessionData {
  const store = useChatSessionsStore()
  const idRef = typeof chatId === 'function' ? chatId : () => chatId

  const session = computed(() => sessionOf(store.sessionsById, idRef()))

  const activeMessage = computed(() => {
    const s = session.value
    return s ? selectActiveMessage(s) : undefined
  })
  const messages = computed(() => {
    const s = session.value
    return s ? selectMessages(s) : []
  })
  const bubble = computed<BubbleView>(() => {
    const s = session.value
    return s ? selectBubble(s) : { thinking: '', content: '', status: 'idle', isWorking: false }
  })
  const isWorking = computed(() => (session.value ? selectIsWorking(session.value!) : false))
  const canResume = computed(() => (session.value ? selectCanResume(session.value!) : false))
  const runtime = computed(() => (session.value ? selectRuntime(session.value!) : undefined))
  const contextUsage = computed(() =>
    session.value ? selectContextUsage(session.value!) : undefined,
  )
  const contextBreakdown = computed(() =>
    session.value ? selectContextBreakdown(session.value!) : undefined,
  )
  const approval = computed(() => (session.value ? selectApproval(session.value!) : undefined))
  const approvalQueue = computed(() => (session.value ? selectApprovalQueue(session.value!) : []))
  const questionBatches = computed(() =>
    session.value ? selectQuestionBatches(session.value!) : [],
  )
  const questionItems = computed(() => flattenQuestionItemsFromBatches(questionBatches.value))
  const activeQuestionId = computed(() =>
    session.value ? selectActiveQuestionId(session.value!) : undefined,
  )
  const activeQuestion = computed(() => {
    const s = session.value
    if (!s) return undefined
    const batches = selectQuestionBatches(s)
    const qid = selectActiveQuestionId(s)
    return qid ? findQuestionFromBatches(batches, qid) : undefined
  })
  const runningTools = computed(() => (session.value ? selectRunningTools(session.value!) : []))
  const currentTodo = computed(() =>
    session.value ? selectCurrentTodo(session.value!) : undefined,
  )
  const loaded = computed(() => (session.value ? selectLoaded(session.value!) : false))
  const ownTimeline = computed<HistoryItem[]>(() => {
    const s = session.value
    return s ? selectOwnTimeline(s) : []
  })
  const groupTimeline = computed<HistoryItem[]>(() => {
    const id = idRef()
    if (!id) return []
    return selectGroupTimeline(store.sessionsById, id)
  })
  const pendingInputs = computed(() => session.value?.pendingInputs ?? [])
  const activeTurns = computed(() => session.value?.activeTurns ?? [])
  const timelineRevision = computed(() => session.value?.sync.timelineRevision)

  return {
    session,
    activeMessage,
    messages,
    bubble,
    isWorking,
    canResume,
    runtime,
    contextUsage,
    contextBreakdown,
    approval,
    approvalQueue,
    questionItems,
    activeQuestionId,
    activeQuestion,
    runningTools,
    currentTodo,
    loaded,
    ownTimeline,
    groupTimeline,
    pendingInputs,
    activeTurns,
    timelineRevision,
  }
}

/** flattenQuestionItems 适配 ChatInteractionState（原签名接 StreamState；这里从 batches 取）。 */
function flattenQuestionItemsFromBatches(
  batches: ReturnType<typeof selectQuestionBatches>,
): QuestionItemState[] {
  return batches.flatMap((b) => b.questions)
}

function findQuestionFromBatches(
  batches: ReturnType<typeof selectQuestionBatches>,
  questionId: string,
):
  | { batch: { batchId: string; questions: QuestionItemState[] }; question: QuestionItemState }
  | undefined {
  for (const batch of batches) {
    const question = batch.questions.find((q) => q.questionId === questionId)
    if (question) return { batch: { batchId: batch.batchId, questions: batch.questions }, question }
  }
  return undefined
}

// re-export for components that need flattenQuestionItems/findQuestion directly
export { flattenQuestionItems, findQuestion }
