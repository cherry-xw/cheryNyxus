import { computed, ref } from 'vue'
import type { InteractionRecord } from '@/application/backend/public'
import { useLiteStore, type LiteQuestionDraft } from './liteStore'
import { useLiteCanonicalView, type LiteInteraction } from './useLiteCanonicalView'
import { createApprovalPresentation } from '@/utils/approvalPresentation'

/**
 * 精简模式交互（审批 / 提问）的单一事实源。
 *
 * v2026-11：交互入口从「待处理面板」迁入详情抽屉——点击大模型响应回来的工具按钮，
 * 在侧边抽屉的工具调用卡内完成审批（允许/拒绝）与提问（单选/多选/补充/自由输入/提交）。
 * 本组合式把原先 useLiteViewController 里的交互逻辑整体搬出，供详情抽屉（DetailDrawer →
 * LiteToolCallDetail → LiteInteractionView）直接消费；待处理面板已移除。
 *
 * 草稿态（已选/补充/自由文本）持久化到 liteStore 的 rootUi.interactionDrafts（按窗口 × 根会话），
 * 关闭再打开抽屉不丢已答内容；审批/提问的提交与错误读取走 lite 规范视图（interactions store）。
 */
export interface LiteQuestionView {
  questionId: string
  question: string
  header?: string
  options: Array<{ label: string; description?: string }>
  multiSelect: boolean
  freeText: boolean
}

export function useLiteInteractions(windowId: () => string, rootChatId: () => string) {
  const liteUi = useLiteStore()
  const lite = useLiteCanonicalView(windowId, rootChatId)
  const rootUi = computed(() => liteUi.ensureRootUi(windowId(), rootChatId()))

  const connectionBlocked = computed(() => !lite.commandGate.allowed)

  function interactionStatusLabel(interaction: LiteInteraction): string {
    return {
      pending: '待处理',
      resolving: '处理中',
      blocked: '恢复失败，可重试',
      completed: '已处理',
      expired: '已超时，未执行',
      cancelled: '已取消',
    }[interaction.status]
  }

  function interactionActionable(interaction: LiteInteraction): boolean {
    return (
      interaction.status === 'pending' ||
      (interaction.kind === 'approval' && interaction.status === 'blocked')
    )
  }

  /** 当前交互是否已处理完（终态或已开始提交）：交互控件据此进入只读/禁用。 */
  function interactionSettled(interaction: LiteInteraction): boolean {
    return !interactionActionable(interaction)
  }

  // ── 工具调用 → 待处理交互匹配（详情抽屉用）────────────────────────────
  // 审批：interactionId = 该次工具调用的 callId（§4.3 契约）；
  // 提问：批内每题的 questionId = 触发它的 callId（src/db/question.ts 以 call.id 落 question_items）。
  // pending（待处理）/ resolving（提交中）都命中——提交中保持交互视图（显示「处理中…」），
  // 完成后不再命中，工具卡自然回到只读展示。
  function interactionActive(interaction: LiteInteraction): boolean {
    return (
      interaction.status === 'pending' ||
      interaction.status === 'resolving' ||
      (interaction.kind === 'approval' && interaction.status === 'blocked')
    )
  }
  function interactionForCall(callId: string | undefined): LiteInteraction | null {
    if (!callId) return null
    for (const item of lite.interactions) {
      if (!interactionActive(item)) continue
      if (item.kind === 'approval' && item.interactionId === callId) return item
      if (item.kind === 'question_batch' && questionsOf(item).some((q) => q.questionId === callId))
        return item
    }
    return null
  }

  /** 交互承载的焦点工具调用 id：审批=该次工具调用的 callId（=interactionId）；提问=批内第一题的 questionId。 */
  function focusCallIdForInteraction(interaction: LiteInteraction): string | null {
    if (interaction.kind === 'approval') return interaction.interactionId
    return questionsOf(interaction)[0]?.questionId ?? null
  }
  /** 交互所在节点 id（详情抽屉打开目标）：工具调用归属节点 → 会话锚点节点 → payload 锚点节点。 */
  function focusNodeForInteraction(interaction: LiteInteraction): string | null {
    const callId = focusCallIdForInteraction(interaction)
    if (callId) {
      const owner = lite.detailNodeIdForToolCall(callId)
      if (owner) return owner
    }
    if (interaction.anchorNodeId) {
      const anchored = lite.detailNodeIdForMessage(interaction.anchorNodeId)
      if (anchored) return anchored
    }
    const payloadAnchor = (interaction.payload as { anchorNodeId?: unknown }).anchorNodeId
    return typeof payloadAnchor === 'string' ? lite.detailNodeIdForMessage(payloadAnchor) : null
  }

  // ── 审批展示 ────────────────────────────────────────────────────────
  function approvalArguments(interaction: LiteInteraction): unknown {
    return interaction.payload.arguments
  }

  function approvalRiskSummary(interaction: LiteInteraction): string {
    const security = interaction.payload.security
    if (security && typeof security === 'object') {
      const findings = (security as { findings?: unknown }).findings
      if (Array.isArray(findings)) {
        const message = (findings[0] as { message?: unknown } | undefined)?.message
        if (typeof message === 'string' && message.trim()) return message.slice(0, 120)
      }
    }
    return '未发现额外安全提示；仍请核对能力、行为和完整操作参数。'
  }

  // ── 提问：结构与草稿 ────────────────────────────────────────────────
  function questionsOf(interaction: LiteInteraction): LiteQuestionView[] {
    const questions = interaction.payload.questions
    if (!Array.isArray(questions)) return []
    return (questions as Array<Record<string, unknown>>).map((question) => ({
      questionId: typeof question.questionId === 'string' ? question.questionId : '',
      question: typeof question.question === 'string' ? question.question : '',
      ...(typeof question.header === 'string' && question.header.trim()
        ? { header: question.header.trim() }
        : {}),
      options: Array.isArray(question.options)
        ? (question.options as Array<{ label: string; description?: string }>)
        : [],
      multiSelect: question.multiSelect === true,
      freeText: !Array.isArray(question.options) || question.options.length === 0,
    }))
  }

  const questionDrafts = computed({
    get: () => rootUi.value.interactionDrafts,
    set: (value: Record<string, Record<string, LiteQuestionDraft>>) =>
      liteUi.patchRootUi(windowId(), rootChatId(), { interactionDrafts: value }),
  })

  function draftOf(batchId: string, questionId: string): LiteQuestionDraft {
    return (
      questionDrafts.value[batchId]?.[questionId] ?? {
        selected: [],
        notes: {},
        freeText: '',
        otherActive: false,
      }
    )
  }

  function selectedOf(batchId: string, questionId: string): string[] {
    return draftOf(batchId, questionId).selected
  }

  function noteOf(batchId: string, questionId: string, label: string): string {
    return draftOf(batchId, questionId).notes[label] ?? ''
  }

  function textDraftOf(batchId: string, questionId: string): string {
    return draftOf(batchId, questionId).freeText
  }

  /** 「其他」输入框作为选项的激活态（单选 radio / 多选复选框）。 */
  function otherActiveOf(batchId: string, questionId: string): boolean {
    return draftOf(batchId, questionId).otherActive === true
  }

  // ── 选项「补充」输入的展开态（纯 UI，不持久化；key 含 questionId，切题自动隔离）──
  const noteOpenByKey = ref<Record<string, boolean>>({})
  function noteKey(batchId: string, questionId: string, label: string): string {
    return `${batchId}:${questionId}:${label}`
  }
  function isNoteOpen(batchId: string, questionId: string, label: string): boolean {
    return noteOpenByKey.value[noteKey(batchId, questionId, label)] === true
  }
  function openNote(batchId: string, questionId: string, label: string): void {
    noteOpenByKey.value = { ...noteOpenByKey.value, [noteKey(batchId, questionId, label)]: true }
  }
  function closeNote(batchId: string, questionId: string, label: string): void {
    const key = noteKey(batchId, questionId, label)
    if (!noteOpenByKey.value[key]) return
    const { [key]: _removed, ...rest } = noteOpenByKey.value
    noteOpenByKey.value = rest
  }
  /** 「补充」按钮：仅选中选项可展开（展开/收起切换）。 */
  function toggleNoteOpen(batchId: string, questionId: string, label: string): void {
    if (isNoteOpen(batchId, questionId, label)) closeNote(batchId, questionId, label)
    else openNote(batchId, questionId, label)
  }

  function toggleOption(batchId: string, question: LiteQuestionView, label: string): void {
    const batch = { ...questionDrafts.value[batchId] }
    const draft = draftOf(batchId, question.questionId)
    const current = new Set(draft.selected)
    const next = { ...draft }
    if (question.multiSelect) {
      if (current.has(label)) {
        current.delete(label)
        const { [label]: _removed, ...rest } = next.notes
        next.notes = rest
        closeNote(batchId, question.questionId, label)
      } else {
        current.add(label)
        if (next.notes[label]?.trim()) openNote(batchId, question.questionId, label)
      }
      next.selected = [...current]
    } else {
      const deselecting = current.has(label)
      next.selected = deselecting ? [] : [label]
      if (!deselecting) {
        // 单选选中具体选项 → 抢走「其他」的激活并丢弃其输入（互斥）
        next.freeText = ''
        next.otherActive = false
      }
      // 单选切选项：丢弃非当前选项的补充描述
      next.notes = deselecting
        ? {}
        : { ...(next.notes[label] ? { [label]: next.notes[label] } : {}) }
      if (deselecting) closeNote(batchId, question.questionId, label)
      else if (next.notes[label]?.trim()) openNote(batchId, question.questionId, label)
    }
    batch[question.questionId] = next
    questionDrafts.value = { ...questionDrafts.value, [batchId]: batch }
  }

  function setOptionNote(batchId: string, questionId: string, label: string, value: string): void {
    const batch = { ...questionDrafts.value[batchId] }
    const draft = draftOf(batchId, questionId)
    batch[questionId] = { ...draft, notes: { ...draft.notes, [label]: value } }
    questionDrafts.value = { ...questionDrafts.value, [batchId]: batch }
  }

  /**
   * 「其他」输入框切换（输入框本身是单选/多选的一个选项）：
   * - 单选：点击抢走其他选项的 active（可再点取消，取消即清空输入）；
   * - 多选：手动勾选复选框；取消勾选清空输入。
   */
  function toggleOtherActive(batchId: string, question: LiteQuestionView): void {
    const batch = { ...questionDrafts.value[batchId] }
    const draft = draftOf(batchId, question.questionId)
    const next = { ...draft, otherActive: !draft.otherActive }
    if (next.otherActive) {
      if (!question.multiSelect) {
        next.selected = []
        next.notes = {}
      }
    } else {
      next.freeText = ''
    }
    batch[question.questionId] = next
    questionDrafts.value = { ...questionDrafts.value, [batchId]: batch }
  }

  function setTextDraft(batchId: string, question: LiteQuestionView, value: string): void {
    const batch = { ...questionDrafts.value[batchId] }
    const draft = draftOf(batchId, question.questionId)
    const next = { ...draft, freeText: value }
    if (question.freeText) {
      // 纯自由文本题：无选项，不参与勾选
    } else if (question.multiSelect) {
      // 多选：输入内容自动勾选「其他」复选框；清空即取消勾选
      next.otherActive = value.trim().length > 0
    } else if (value.trim()) {
      // 单选：输入即激活「其他」选项，抢走其他选项的选中
      next.selected = []
      next.notes = {}
      next.otherActive = true
    }
    batch[question.questionId] = next
    questionDrafts.value = { ...questionDrafts.value, [batchId]: batch }
  }

  /** 选项卡片点击/键盘切换：不可操作（已处理/超时等）时忽略。 */
  function onToggleChoice(
    interaction: LiteInteraction,
    question: LiteQuestionView,
    label: string,
  ): void {
    if (!interactionActionable(interaction)) return
    toggleOption(interaction.interactionId, question, label)
  }

  function onToggleOther(interaction: LiteInteraction, question: LiteQuestionView): void {
    if (!interactionActionable(interaction)) return
    toggleOtherActive(interaction.interactionId, question)
  }

  function onOtherInput(
    interaction: LiteInteraction,
    question: LiteQuestionView,
    value: string,
  ): void {
    setTextDraft(interaction.interactionId, question, value)
  }

  function questionAnswered(batchId: string, question: LiteQuestionView): boolean {
    const draft = draftOf(batchId, question.questionId)
    if (draft.freeText.trim()) return true
    if (question.freeText) return false
    return question.multiSelect ? draft.selected.length > 0 : draft.selected.length === 1
  }

  function answeredQuestionCount(interaction: LiteInteraction): number {
    return questionsOf(interaction).filter((question) =>
      questionAnswered(interaction.interactionId, question),
    ).length
  }

  function canAnswerBatch(interaction: LiteInteraction): boolean {
    const questions = questionsOf(interaction)
    return (
      questions.length > 0 &&
      questions.every((question) => questionAnswered(interaction.interactionId, question))
    )
  }

  // ── 审批 / 提问提交 ────────────────────────────────────────────────
  const deciding = ref<string | null>(null)
  async function onDecide(
    interaction: LiteInteraction,
    action: 'accept' | 'reject',
  ): Promise<void> {
    deciding.value = interaction.interactionId
    try {
      await lite.decideApproval(interaction.interactionId, action)
    } finally {
      deciding.value = null
    }
  }

  const answering = ref<string | null>(null)
  async function onAnswerBatch(interaction: LiteInteraction): Promise<void> {
    const batchId = interaction.interactionId
    if (!canAnswerBatch(interaction)) return
    const answers = questionsOf(interaction).map((question) => {
      const draft = draftOf(batchId, question.questionId)
      if (question.freeText) {
        return {
          questionId: question.questionId,
          freeText: draft.freeText,
        }
      }
      const notes: Record<string, string> = {}
      const freeText = draft.freeText.trim()
      const selected = !question.multiSelect && freeText ? [] : draft.selected
      for (const label of selected) {
        const note = draft.notes[label]?.trim()
        if (note) notes[label] = note
      }
      return {
        questionId: question.questionId,
        selectedLabels: selected,
        ...(Object.keys(notes).length ? { optionNotes: notes } : {}),
        ...(freeText ? { freeText } : {}),
      }
    })
    answering.value = batchId
    try {
      await lite.answerQuestion(batchId, answers)
    } finally {
      answering.value = null
    }
  }

  // ── 倒计时（仅运行中 pending/resolving 的交互计算；终态只显示状态）──
  function remainingLabel(interaction: LiteInteraction): string {
    if (interaction.status !== 'pending' && interaction.status !== 'resolving') return ''
    if (typeof interaction.deadlineAt !== 'number') return ''
    const remaining = interaction.deadlineAt - lite.calibratedNow()
    if (remaining <= 0) return '已超时'
    const seconds = Math.ceil(remaining / 1000)
    return seconds >= 60 ? `${Math.floor(seconds / 60)}m${seconds % 60}s` : `${seconds}s`
  }

  /** 审批展示模型（approval card 顶部「大模型需要…」）。 */
  function approvalPresentationOf(interaction: LiteInteraction) {
    return createApprovalPresentation(interaction.payload.senseName, interaction.payload.arguments)
  }

  return {
    lite,
    connectionBlocked,
    interactionActionable,
    interactionActive,
    interactionSettled,
    interactionStatusLabel,
    interactionForCall,
    focusCallIdForInteraction,
    focusNodeForInteraction,
    approvalArguments,
    approvalRiskSummary,
    approvalPresentationOf,
    questionsOf,
    selectedOf,
    noteOf,
    textDraftOf,
    otherActiveOf,
    isNoteOpen,
    toggleNoteOpen,
    onToggleChoice,
    onToggleOther,
    onOtherInput,
    setOptionNote,
    questionAnswered,
    answeredQuestionCount,
    canAnswerBatch,
    onDecide,
    deciding,
    onAnswerBatch,
    answering,
    remainingLabel,
  }
}

export type LiteInteractionsApi = ReturnType<typeof useLiteInteractions>
export type { InteractionRecord }
