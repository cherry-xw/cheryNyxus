import type { ChatSession } from '../types'
import type { QuestionDraftAnswer } from '@/domain/chat/projectionTypes'
import { useInteractionsStore } from '../../interactions'

export function createInteractionCommands(getSession: (chatId: string) => ChatSession | undefined) {
  async function submitApproval(
    chatId: string,
    approvalId: string,
    action: 'accept' | 'reject',
  ): Promise<void> {
    const interactions = useInteractionsStore()
    let record = interactions.records[approvalId]
    if (!record) {
      await interactions.refresh()
      record = interactions.records[approvalId]
    }
    if (!record || record.kind !== 'approval') throw new Error('审批待办不存在或已结束')
    await interactions.decide(record, action)
    // 即时清 pending（不等 accept/rejected notification 回来）
    const session = getSession(chatId)
    if (session) {
      if (session.interaction.approval?.approvalId === approvalId) {
        session.interaction.approval = undefined
        if (session.interaction.approvalQueue.length > 0) {
          session.interaction.approval = session.interaction.approvalQueue.shift()
        }
      }
    }
  }

  function dismissApproval(chatId: string): void {
    const session = getSession(chatId)
    if (!session) return
    session.interaction.approval = undefined
    if (session.interaction.approvalQueue.length > 0) {
      session.interaction.approval = session.interaction.approvalQueue.shift()
    }
  }

  function dismissApprovalToQueue(chatId: string): void {
    const session = getSession(chatId)
    if (!session?.interaction.approval) return
    const current = session.interaction.approval
    session.interaction.approval = session.interaction.approvalQueue.shift()
    session.interaction.approvalQueue.push(current)
  }

  function resummonApproval(chatId: string, approvalId: string): void {
    const session = getSession(chatId)
    if (!session) return
    const idx = session.interaction.approvalQueue.findIndex((a) => a.approvalId === approvalId)
    if (idx < 0) return
    const target = session.interaction.approvalQueue[idx]
    if (!target) return
    if (session.interaction.approval)
      session.interaction.approvalQueue.push(session.interaction.approval)
    session.interaction.approvalQueue.splice(idx, 1)
    session.interaction.approval = target
  }

  function expireApproval(chatId: string, approvalId: string): void {
    const session = getSession(chatId)
    if (!session) return
    if (session.interaction.approval?.approvalId === approvalId) {
      dismissApproval(chatId)
      return
    }
    session.interaction.approvalQueue = session.interaction.approvalQueue.filter(
      (approval) => approval.approvalId !== approvalId,
    )
  }

  function setActiveQuestion(chatId: string, questionId: string | undefined): void {
    const session = getSession(chatId)
    if (session) session.interaction.activeQuestionId = questionId
  }

  function updateQuestionDraft(
    chatId: string,
    questionId: string,
    draft?: QuestionDraftAnswer,
  ): void {
    const session = getSession(chatId)
    const question = session?.interaction.questionBatches
      .flatMap((batch) => batch.questions)
      .find((item) => item.questionId === questionId)
    if (!question) return
    if (draft) question.draftAnswer = draft
    else delete question.draftAnswer
  }

  async function advanceQuestion(
    chatId: string,
    questionId: string,
    draft: QuestionDraftAnswer,
  ): Promise<void> {
    const session = getSession(chatId)
    const batch = session?.interaction.questionBatches.find((item) =>
      item.questions.some((question) => question.questionId === questionId),
    )
    const question = batch?.questions.find((item) => item.questionId === questionId)
    if (!batch || !question || batch.status === 'submitting') return
    question.draftAnswer = draft
    question.localStatus = 'ready'
    const next = batch.questions.find((item) => item.localStatus === 'pending')
    if (next) {
      session!.interaction.activeQuestionId = next.questionId
      return
    }
    batch.status = 'submitting'
    try {
      const interactions = useInteractionsStore()
      let interaction = interactions.records[batch.batchId]
      if (!interaction) {
        await interactions.refresh()
        interaction = interactions.records[batch.batchId]
      }
      if (!interaction || interaction.kind !== 'question_batch') {
        throw new Error('问题待办不存在或已结束')
      }
      await interactions.answer(
        interaction,
        batch.questions.map((item) => ({
          questionId: item.questionId,
          selectedLabels: [...item.draftAnswer!.selectedLabels],
          ...(item.draftAnswer!.optionNotes ? { optionNotes: item.draftAnswer!.optionNotes } : {}),
          ...(item.draftAnswer!.freeText ? { freeText: item.draftAnswer!.freeText } : {}),
          ...(item.draftAnswer!.cancelled ? { cancelled: true } : {}),
        })),
      )
      session!.interaction.questionBatches = session!.interaction.questionBatches.filter(
        (item) => item.batchId !== batch.batchId,
      )
    } catch (error) {
      batch.status = 'pending'
      throw error
    }
  }

  async function cancelQuestion(chatId: string, questionId: string): Promise<void> {
    await advanceQuestion(chatId, questionId, { selectedLabels: [], cancelled: true })
  }

  function backQuestion(chatId: string, questionId: string): void {
    const session = getSession(chatId)
    const batch = session?.interaction.questionBatches.find((item) =>
      item.questions.some((question) => question.questionId === questionId),
    )
    const current = batch?.questions.find((item) => item.questionId === questionId)
    if (!batch || !current || batch.status === 'submitting') return
    const sorted = [...batch.questions].sort((a, b) => a.position - b.position)
    const index = sorted.findIndex((item) => item.questionId === questionId)
    const previous = index > 0 ? sorted[index - 1] : undefined
    if (!previous) return
    if (current.localStatus === 'ready') current.localStatus = 'pending'
    session!.interaction.activeQuestionId = previous.questionId
  }

  async function submitQuestionBatch(
    chatId: string,
    batchId: string,
    answers: Array<{
      questionId: string
      selectedLabels: string[]
      /** 每选项补充描述：label → note（可选，向后兼容；仅已选选项生效）。 */
      optionNotes?: Record<string, string>
      freeText?: string
      cancelled?: boolean
    }>,
  ): Promise<void> {
    const interactions = useInteractionsStore()
    let interaction = interactions.records[batchId]
    if (!interaction) {
      await interactions.refresh()
      interaction = interactions.records[batchId]
    }
    if (!interaction || interaction.chatId !== chatId || interaction.kind !== 'question_batch') {
      throw new Error('问题待办不存在或已结束')
    }
    await interactions.answer(interaction, answers)
  }

  return { submitApproval, dismissApproval, dismissApprovalToQueue, resummonApproval, expireApproval, setActiveQuestion, updateQuestionDraft, advanceQuestion, cancelQuestion, backQuestion, submitQuestionBatch }
}
