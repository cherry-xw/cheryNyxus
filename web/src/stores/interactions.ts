import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { agentApi, type InteractionRecord } from '@/services/agentApi'
import { commandErrorFact, commandGateError, type CanonicalCommandError } from './commandLifecycle'
import { useChatSessionsStore } from './chats'

export interface InteractionCommandError extends CanonicalCommandError {
  interactionId: string
  at: number
  terminal?: boolean
}

export interface QuestionValidationError {
  code: 'REQUIRED' | 'SINGLE_CHOICE_CONFLICT'
  message: string
}

type InteractionAnswer = Parameters<typeof agentApi.answerInteractionQuestion>[0]['answers'][number]

function makeCommandId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `interaction-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function questionsOf(item: InteractionRecord): Array<{
  questionId: string
  options: Array<{ label: string }>
  multiSelect: boolean
}> {
  const questions = item.payload.questions
  if (!Array.isArray(questions)) return []
  return questions
    .map((raw) => raw as Record<string, unknown>)
    .filter((question) => typeof question.questionId === 'string')
    .map((question) => ({
      questionId: question.questionId as string,
      options: Array.isArray(question.options)
        ? (question.options as Array<{ label: string }>)
        : [],
      multiSelect: question.multiSelect === true,
    }))
}

/** Shared by Lite and the full interaction inbox; errors are returned per question. */
export function validateInteractionAnswers(
  item: InteractionRecord,
  answers: InteractionAnswer[],
): Record<string, QuestionValidationError> {
  const errors: Record<string, QuestionValidationError> = {}
  const answersById = new Map(answers.map((answer) => [answer.questionId, answer]))
  for (const question of questionsOf(item)) {
    const answer = answersById.get(question.questionId)
    if (answer?.cancelled) continue
    const selected = answer?.selectedLabels?.filter(Boolean) ?? []
    const freeText = answer?.freeText?.trim() ?? ''
    if (question.options.length === 0) {
      if (!freeText) errors[question.questionId] = { code: 'REQUIRED', message: '请输入回答' }
      continue
    }
    if (!question.multiSelect && selected.length > 0 && freeText) {
      errors[question.questionId] = {
        code: 'SINGLE_CHOICE_CONFLICT',
        message: '单选题请在选项与补充回答中二选一',
      }
      continue
    }
    const valid = freeText || (question.multiSelect ? selected.length > 0 : selected.length === 1)
    if (!valid) {
      errors[question.questionId] = {
        code: 'REQUIRED',
        message: question.multiSelect ? '请至少选择一项或填写回答' : '请选择一项或填写回答',
      }
    }
  }
  return errors
}

function isAlreadyResolved(code: string): boolean {
  return code === 'INTERACTION_ALREADY_RESOLVED' || code === 'ALREADY_RESOLVED'
}

export const useInteractionsStore = defineStore('interactions', () => {
  const records = ref<Record<string, InteractionRecord>>({})
  const loading = ref(false)
  const error = ref<string>()
  const errorsById = ref<Record<string, InteractionCommandError>>({})
  const questionErrorsById = ref<Record<string, Record<string, QuestionValidationError>>>({})
  const serverClockOffsetMs = ref(0)
  const inFlight = new Map<string, Promise<void>>()
  const commandIds = new Map<string, string>()

  const all = computed(() => Object.values(records.value))
  const pending = computed(() =>
    all.value.filter((item) => ['pending', 'resolving', 'blocked'].includes(item.status)),
  )
  const activity = computed(() =>
    all.value
      .filter((item) => !['pending', 'resolving', 'blocked'].includes(item.status))
      .sort((a, b) => b.updatedAt - a.updatedAt),
  )

  function install(items: InteractionRecord[]): void {
    const next = Object.fromEntries(items.map((item) => [item.interactionId, item]))
    for (const item of Object.values(records.value)) {
      if (
        !next[item.interactionId] &&
        ['completed', 'expired', 'cancelled'].includes(item.status)
      ) {
        next[item.interactionId] = item
      }
    }
    records.value = next
  }

  async function refresh(): Promise<void> {
    loading.value = true
    try {
      const receivedAt = Date.now()
      const page = await agentApi.listInteractionPage({ includeActivity: true })
      install(page.interactions)
      if (typeof page.serverNow === 'number')
        serverClockOffsetMs.value = page.serverNow - receivedAt
      error.value = undefined
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '待处理交互加载失败'
      throw cause
    } finally {
      loading.value = false
    }
  }

  function commandIdFor(item: InteractionRecord, operation: string): string {
    const key = `${item.interactionId}:${item.revision}:${operation}`
    const existing = commandIds.get(key)
    if (existing) return existing
    const created = makeCommandId()
    commandIds.set(key, created)
    return created
  }

  function setObjectError(
    item: InteractionRecord,
    cause: unknown,
    fallback: string,
    terminal = false,
  ): InteractionCommandError {
    const fact = commandErrorFact(cause, fallback)
    const normalized =
      fact.code === 'RATE_LIMITED'
        ? { ...fact, message: '请求过于频繁，请稍后重试', retryable: true }
        : fact
    const errorFact: InteractionCommandError = {
      ...normalized,
      interactionId: item.interactionId,
      at: Date.now(),
      ...(terminal ? { terminal: true } : {}),
    }
    errorsById.value = { ...errorsById.value, [item.interactionId]: errorFact }
    return errorFact
  }

  function clearObjectError(interactionId: string): void {
    const { [interactionId]: _removed, ...rest } = errorsById.value
    errorsById.value = rest
  }

  async function refreshAfterFailure(item: InteractionRecord): Promise<void> {
    try {
      await refresh()
    } catch {
      records.value[item.interactionId] = { ...item }
    }
  }

  function singleFlight(interactionId: string, operation: () => Promise<void>): Promise<void> {
    const existing = inFlight.get(interactionId)
    if (existing) return existing
    const promise = operation().finally(() => inFlight.delete(interactionId))
    inFlight.set(interactionId, promise)
    return promise
  }

  async function decide(item: InteractionRecord, action: 'accept' | 'reject'): Promise<void> {
    return singleFlight(item.interactionId, async () => {
      const current = records.value[item.interactionId] ?? item
      if (!['pending', 'blocked'].includes(current.status)) return
      const gate = useChatSessionsStore().commandAvailability(current.rootChatId)
      if (!gate.allowed) {
        const cause = commandGateError(gate)
        setObjectError(current, cause, cause.message)
        throw cause
      }
      clearObjectError(item.interactionId)
      records.value[item.interactionId] = { ...current, status: 'resolving' }
      try {
        const next = await agentApi.decideInteractionApproval({
          interactionId: current.interactionId,
          action,
          expectedRevision: current.revision,
          commandId: commandIdFor(current, `approval:${action}`),
        })
        records.value[next.interactionId] = next
      } catch (cause) {
        const fact = commandErrorFact(cause, '审批提交失败')
        if (isAlreadyResolved(fact.code)) {
          await refreshAfterFailure(current)
          const refreshed = records.value[current.interactionId]
          if (!refreshed || ['pending', 'resolving', 'blocked'].includes(refreshed.status)) {
            records.value[current.interactionId] = terminalFallback(current)
          }
          setObjectError(current, cause, '已在其他视图处理', true)
          return
        }
        await refreshAfterFailure(current)
        setObjectError(current, cause, '审批提交失败')
        throw cause
      }
    })
  }

  async function answer(item: InteractionRecord, answers: InteractionAnswer[]): Promise<void> {
    // A second view joins the authoritative submission before inspecting its
    // local draft. Otherwise an incomplete stale draft could overwrite the
    // first view's valid in-flight state with synthetic validation errors.
    const existing = inFlight.get(item.interactionId)
    if (existing) return existing
    const validation = validateInteractionAnswers(item, answers)
    questionErrorsById.value = { ...questionErrorsById.value, [item.interactionId]: validation }
    if (Object.keys(validation).length > 0) {
      const validationError = new Error('请完成全部必填问题后提交') as Error & { code: string }
      validationError.code = 'VALIDATION_ERROR'
      setObjectError(item, validationError, validationError.message)
      throw validationError
    }
    return singleFlight(item.interactionId, async () => {
      const current = records.value[item.interactionId] ?? item
      if (current.status !== 'pending') {
        const cause = new Error(
          current.status === 'blocked'
            ? '该问题当前不可提交，请刷新后重试'
            : '该问题已处理或不可提交',
        ) as Error & { code: string }
        cause.code = 'INTERACTION_NOT_ACTIONABLE'
        setObjectError(current, cause, cause.message)
        throw cause
      }
      const gate = useChatSessionsStore().commandAvailability(current.rootChatId)
      if (!gate.allowed) {
        const cause = commandGateError(gate)
        setObjectError(current, cause, cause.message)
        throw cause
      }
      clearObjectError(item.interactionId)
      records.value[current.interactionId] = { ...current, status: 'resolving' }
      try {
        const next = await agentApi.answerInteractionQuestion({
          interactionId: current.interactionId,
          expectedRevision: current.revision,
          commandId: commandIdFor(current, 'question:answer'),
          answers: answers.map((answer) => ({
            ...answer,
            selectedLabels: [...answer.selectedLabels],
            ...(answer.freeText ? { freeText: answer.freeText.trim() } : {}),
          })),
        })
        records.value[next.interactionId] = next
        questionErrorsById.value = { ...questionErrorsById.value, [current.interactionId]: {} }
      } catch (cause) {
        const fact = commandErrorFact(cause, '回答提交失败')
        if (isAlreadyResolved(fact.code)) {
          await refreshAfterFailure(current)
          const refreshed = records.value[current.interactionId]
          if (!refreshed || ['pending', 'resolving', 'blocked'].includes(refreshed.status)) {
            records.value[current.interactionId] = terminalFallback(current)
          }
          setObjectError(current, cause, '已在其他视图处理', true)
          return
        }
        await refreshAfterFailure(current)
        setObjectError(current, cause, '回答提交失败')
        throw cause
      }
    })
  }

  function calibratedNow(): number {
    return Date.now() + serverClockOffsetMs.value
  }

  return {
    records,
    all,
    pending,
    activity,
    loading,
    error,
    errorsById,
    questionErrorsById,
    serverClockOffsetMs,
    refresh,
    decide,
    answer,
    clearObjectError,
    calibratedNow,
  }
})

function terminalFallback(item: InteractionRecord): InteractionRecord {
  const now = Date.now()
  return {
    ...item,
    status: 'completed',
    result: { reason: '已在其他视图处理' },
    completedAt: now,
    updatedAt: now,
  }
}
