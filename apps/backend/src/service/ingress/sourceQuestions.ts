import type { IngressFileAuthorization, IngressQuestionAnswer, IngressQuestionResume, IngressQuestionResumeResult } from './api.js'
import { getChat } from '@/db/chat.js'
import { getSoulDb } from '@/db/index.js'
import { getInteraction } from '@/db/interaction.js'
import { questionBatchFacts } from '@/db/question.js'
import { claimSourceAnswer, getSourceAnswerCommand, getSourceTask, saveSourceAnswer, setSourceTaskState,
  sourceQuestionBatches, sourceTaskError, sourceTaskSessionId, startSourceAnswer } from '@/db/sourceTasks.js'
import { resolveQuestionBatch } from '../chat/wake.js'
import { launchSourceQuestionRun } from '../chat/sourceQuestionRun.js'
import { sourceExecutionAuthority, validateSourceInput } from './sourceExecution.js'
import { ingressExecution } from './request.js'
import { immutableSnapshot } from './api.js'
import { logger } from '@/utils/logger/index.js'

type Authorized = Omit<IngressQuestionResume, 'conversationKey' | 'identity'> & IngressFileAuthorization
type Answer = Omit<IngressQuestionAnswer, 'conversationKey' | 'identity'> & IngressFileAuthorization
const saving = new Set<string>()

function authorize(owner: string, chatId: string, input: Authorized) {
  input.validateIdentity(); input.signal?.throwIfAborted()
  const task = getSourceTask(input.runId), identity = input.requestIdentity, original = task?.identity
  if (!task || task.chatId !== chatId || identity.source !== 'plugin' || identity.channel !== 'qq' ||
    original?.ownerId !== owner || identity.ownerId !== owner || original.entryId !== identity.entryId ||
    !original.subject || !identity.subject || ['selfId', 'userId', 'conversationType', 'groupId'].some(field =>
      original.subject![field as keyof typeof original.subject] !== identity.subject![field as keyof typeof identity.subject])) sourceTaskError('IDENTITY_REJECTED')
  const authority = sourceExecutionAuthority(identity, input.validateIdentity)
  const source = validateSourceInput(task.input, authority), scope = source.repo.scope(authority, task.input.scopeId)
  if (getChat(chatId)?.active_epoch_id !== task.epochId || scope.coreBinding?.chatId !== chatId ||
    scope.coreBinding.epochId !== task.epochId || scope.permissionRevision !== task.permissionRevision) sourceTaskError('IDENTITY_REJECTED')
  return { task, authority, repo: source.repo }
}
function ready(runId: string, chatId: string): boolean {
  const batches = sourceQuestionBatches(runId)
  return batches.length > 0 && batches.every(batch => {
    const facts = questionBatchFacts(chatId, batch.batchId)
    return facts.length === batch.questionIds.length && facts.every(fact => fact.status === 'answered')
  })
}
export function sourceQuestionStatus(owner: string, chatId: string, input: Authorized): IngressQuestionResumeResult {
  const { task, repo, authority } = authorize(owner, chatId, input), command = getSourceAnswerCommand(input.commandId)
  const base = { runId: input.runId, commandId: input.commandId, canQueue: false }
  if (!command || command.runId !== input.runId) return { ...base, status: 'unknown', reasonCode: 'QUESTION_COMMAND_UNKNOWN' }
  if (['completed','failed','cancelled'].includes(task.state)) return { ...base, status: task.state as 'completed' | 'failed' | 'cancelled' }
  if (task.sessionId !== sourceTaskSessionId) return { ...base, status: 'cancelled', reasonCode: 'BACKEND_STOPPED' }
  const batches = sourceQuestionBatches(input.runId)
  if (batches.some(batch => questionBatchFacts(chatId, batch.batchId).some(fact => fact.status === 'cancelled')))
    return { ...base, status: 'cancelled', reasonCode: 'QUESTION_CANCELLED' }
  if (command.state === 'saving') return { ...base, status: 'saving' }
  if (command.state === 'started') return { ...base, status: task.state === 'paused' || task.state === 'waiting' ? 'paused' : 'started' }
  return { ...base, status: 'saved', canQueue: task.state === 'waiting' && ready(task.runId, chatId),
    sourceSnapshot: repo.snapshot(authority, task.input.scopeId, command.sourceInput!.snapshotId) }
}
/** Monthly answers, main interactions and snapshot are repeatable, not a cross-DB transaction. */
export async function saveSourceQuestions(owner: string, chatId: string, input: Answer): Promise<IngressQuestionResumeResult> {
  const { task, authority, repo } = authorize(owner, chatId, input)
  const binding = sourceQuestionBatches(task.runId).find(batch => batch.batchId === input.batchId)
  const interaction = getInteraction(input.batchId), source = input.sourceAnswers
  if (!binding || !interaction || interaction.chatId !== chatId || interaction.kind !== 'question_batch' ||
    !['pending', 'resolving', 'blocked', 'completed'].includes(interaction.status) ||
    interaction.deadlineAt !== undefined && interaction.deadlineAt <= Date.now() ||
    !source || source.records.length !== binding.questionIds.length || input.answers.length !== binding.questionIds.length ||
    new Set(input.answers.map(answer => answer.questionId)).size !== binding.questionIds.length ||
    new Set(source.records.map(answer => answer.questionId)).size !== binding.questionIds.length ||
    binding.questionIds.some(id => !input.answers.some(answer => answer.questionId === id) || !source.records.some(answer => answer.questionId === id))) sourceTaskError('IDENTITY_REJECTED')
  const answers = source.records.map(value => {
    const answer = input.answers.find(answer => answer.questionId === value.questionId)!
    if (!answer.freeText?.trim() || answer.selectedLabels.length || answer.cancelled) sourceTaskError('INVALID_PARAMS')
    return { ...value, text: answer.freeText }
  })
  // Check the fingerprint even for repeated commands after a run has ended.
  const old = getSourceAnswerCommand(input.commandId)
  if (!old && (task.state !== 'waiting' || task.sessionId !== sourceTaskSessionId)) sourceTaskError('QUESTION_NOT_WAITING')
  const command = claimSourceAnswer({ commandId: input.commandId, runId: task.runId, batchId: input.batchId,
    parentSnapshotId: source.snapshotId, body: { sourceAnswers: source, answers: input.answers } })
  if (command.state !== 'saving' || task.state !== 'waiting' || task.sessionId !== sourceTaskSessionId) return sourceQuestionStatus(owner, chatId, input)
  if (saving.has(task.runId)) sourceTaskError('QUESTION_SAVE_IN_PROGRESS')
  saving.add(task.runId)
  try {
    if (command.parentSnapshotId !== task.input.snapshotId) sourceTaskError('SOURCE_CONFLICT')
    const facts = questionBatchFacts(chatId, input.batchId)
    if (facts.length !== binding.questionIds.length || facts.some(fact => fact.status === 'cancelled')) sourceTaskError('QUESTION_CANCELLED')
    const sourceAnswer = repo.answerSnapshot(authority, { parentSnapshotId: command.parentSnapshotId,
      commandId: command.commandId, runId: task.runId, batchId: input.batchId, answers })
    await resolveQuestionBatch(chatId, input.batchId, input.answers, task.runId)
    authorize(owner, chatId, input)
    const completed = questionBatchFacts(chatId, input.batchId)
    if (completed.some(fact => fact.status !== 'answered')) sourceTaskError('QUESTION_SAVE_INCOMPLETE')
    getSoulDb().transaction(() => {
      const saved = repo.runMessages(authority, task.input.scopeId, task.requestId)
      for (const fact of completed) {
        const message = saved.find(item => item.ref.messageId === fact.questionId)
        if (!message || message.state === 'unknown' || message.body.role !== 'sense') sourceTaskError('SOURCE_TOOL_OUTCOME_UNKNOWN')
        repo.saveRunMessage(authority, task.input.scopeId, task.runId, { ...message.body, content: fact.answerText! }, 'completed')
      }
      saveSourceAnswer(command.commandId, sourceAnswer.sourceInput)
    })()
    return sourceQuestionStatus(owner, chatId, input)
  } finally { saving.delete(task.runId) }
}
export async function resumeSourceQuestions(owner: string, chatId: string, input: Authorized): Promise<IngressQuestionResumeResult> {
  const status = sourceQuestionStatus(owner, chatId, input)
  if (status.status !== 'saved' || !status.canQueue) return status
  const { task } = authorize(owner, chatId, input)
  const execution = { identity: immutableSnapshot(task.identity), signal: input.signal, sourceInput: task.input, sourceStartReason: 'question_resume' as const,
    sourceCapacity: input.sourceCapacity, execution: { toolHistory: 'request' as const, retry: 'never' as const }, validate: input.validateIdentity }
  const started = await ingressExecution.run(execution, () => launchSourceQuestionRun({ authenticatedUserId: owner,
    connectionId: `ingress:${owner}`, requestId: task.runId, log: logger }, chatId, task.runId,
    { requestId: task.runId, inputId: `question:${input.commandId}`, requestIdentity: task.identity, requestExecution: execution }, () => {
      const current = sourceQuestionStatus(owner, chatId, input)
      if (current.status !== 'saved' || !current.canQueue) sourceTaskError('QUESTION_NOT_WAITING')
      const { repo, authority } = authorize(owner, chatId, input)
      repo.completedRunMessages(authority, task.input.scopeId, task.requestId)
      getSoulDb().transaction(() => {
        if (!startSourceAnswer(input.commandId)) sourceTaskError('SOURCE_CONFLICT')
        setSourceTaskState(task.runId, 'running')
        getSoulDb().prepare("UPDATE execution_active_runs SET status='running' WHERE chat_id=? AND run_id=? AND status IN ('waiting','paused')").run(chatId,task.runId)
      })()
    }))
  return started ? { ...status, status: 'started', canQueue: false } : { ...status, reasonCode: 'PREVIOUS_WORK_PENDING' }
}
