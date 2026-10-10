// 回归测试：工具链 occurrence 的记录顺序必须与模板链一致（清单→校验→授权→审批）。
// 背景：sense_pending（审批注册）在模型流中先于 sense_end（校验/授权）到达，而 tool-list
// 原先只在批次边界（boundary.batch）才记录，导致"后续节点先触发、前置节点后触发"。
// 修复后：tool-list 在首个工具链事件时提前建立（收集中），tool-approval 延后到授权之后记录。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkflowJournalEventInput } from '@/db/workflowJournal.js'

const fixture = vi.hoisted(() => ({
  appendCalls: [] as WorkflowJournalEventInput[][],
}))

vi.mock('@/db/chat.js', () => ({
  getMessages: () => [],
  getRootChatId: (chatId: string) => chatId,
}))
vi.mock('@/db/conversationBranch.js', () => ({
  getConversationBranchByChat: () => undefined,
  getConversationTask: () => undefined,
}))
vi.mock('@/db/workflowJournal.js', () => ({
  appendWorkflowJournalEvents: (events: WorkflowJournalEventInput[]) => {
    fixture.appendCalls.push(structuredClone(events))
  },
  recordWorkflowJournalGap: () => {},
  readWorkflowStepSnapshot: () => ({ active: [] }),
}))
vi.mock('@/db/delivery.js', () => ({ getSpawnTaskByChild: () => undefined }))
vi.mock('@/service/chat/runtime.js', () => ({ getActiveChatRunId: () => 'run' }))

import { reportWorkflow } from '@/core/middleware/workflowObservation.js'
import type { MiddlewareChunk } from '@/core/middleware/types.js'
import { startWorkflowRunRecorder } from '@/service/chat/workflowRecorder.js'

const ALLOW_SECURITY = {
  decision: 'allow',
  roleType: 'assistant',
  policyHash: 'policy',
  findings: [],
  assessmentHash: 'assessment',
} as const

function beginToolRound() {
  const recorder = startWorkflowRunRecorder('root')
  reportWorkflow('root', { newIteration: true, iteration: 1 })
  reportWorkflow('root', { activeNodeId: 'input' })
  recorder.recordCommittedMessage({ id: 'user-message', inputId: 'user-input', role: 'user' })
  reportWorkflow('root', { attempt: 1 })
  reportWorkflow('root', { activeNodeId: 'model', phaseLabel: '准备请求' })
  reportWorkflow('root', { activeNodeId: 'model', phaseLabel: '调用中' })
  reportWorkflow('root', { activeNodeId: 'model', phaseLabel: '处理响应' })
  return recorder
}

function senseEnd(callId: string): MiddlewareChunk {
  return {
    type: 'sense_end',
    id: callId,
    name: 'config_manage',
    arguments: '{}',
    supervisionLevel: 1,
    security: ALLOW_SECURITY,
  }
}

function commitBatch(recorder: ReturnType<typeof startWorkflowRunRecorder>) {
  reportWorkflow('root', {
    activeNodeId: 'tools',
    batch: {
      id: 'batch',
      complete: true,
      calls: [{ id: 'call', name: 'config_manage', status: 'pending' }],
    },
  })
  recorder.recordChunk({
    type: 'sense_started',
    id: 'call',
    name: 'config_manage',
    arguments: '{}',
    startedAt: 1,
  })
  recorder.recordChunk({ type: 'sense_accept', id: 'call', name: 'config_manage', result: 'ok' })
  recorder.finish('succeeded', 'normal')
}

function recordedEvents(): WorkflowJournalEventInput[] {
  const seen = new Set<string>()
  return fixture.appendCalls
    .flat()
    .filter((event) => {
      if (seen.has(event.sourceKey)) return false
      seen.add(event.sourceKey)
      return true
    })
}

function indexOf(events: WorkflowJournalEventInput[], kind: string, eventKind: string, status?: string) {
  return events.findIndex(
    (event) =>
      event.kind === kind &&
      event.eventKind === eventKind &&
      (status === undefined || event.status === status),
  )
}

beforeEach(() => {
  fixture.appendCalls = []
})

describe('workflow recorder tool chain ordering', () => {
  it('records tool-list before validation/authorization/approval and links causes', () => {
    const recorder = beginToolRound()
    // 真实中间件流顺序：sense_pending（审批注册）先于其调用自身的 sense_end。
    recorder.recordChunk({
      type: 'sense_pending',
      approvalId: 'call',
      senseName: 'config_manage',
      arguments: '{}',
      supervisionLevel: 1,
    })
    recorder.recordChunk(senseEnd('call'))
    commitBatch(recorder)

    const events = recordedEvents()
    const listStart = indexOf(events, 'tool-list', 'started')
    const listSucceeded = indexOf(events, 'tool-list', 'status', 'succeeded')
    const validationStart = indexOf(events, 'tool-validation', 'started')
    const authorizationStart = indexOf(events, 'tool-authorization', 'started')
    const approvalStart = indexOf(events, 'tool-approval', 'started')
    const approvalWaiting = indexOf(events, 'tool-approval', 'status', 'waiting')

    // 工具链顺序与模板一致：清单 → 校验 → 授权 → 审批，批次提交后才结束清单。
    expect(listStart).toBeGreaterThanOrEqual(0)
    expect(validationStart).toBeGreaterThan(listStart)
    expect(authorizationStart).toBeGreaterThan(validationStart)
    expect(approvalStart).toBeGreaterThan(authorizationStart)
    expect(approvalWaiting).toBeGreaterThan(approvalStart)
    expect(listSucceeded).toBeGreaterThan(approvalStart)

    // 同一个 tool-list occurrence：先 running（收集中），批次提交后 succeeded 并带真实 batchId。
    const listEvents = events.filter((event) => event.kind === 'tool-list')
    expect(listEvents.filter((event) => event.status === 'running')).toHaveLength(1)
    const succeeded = listEvents.find((event) => event.status === 'succeeded')
    expect(succeeded?.batchId).toBe('batch')

    // 因果链完整：校验←清单，授权←校验，审批←授权。
    const byId = new Map(events.map((event) => [event.occurrenceId, event]))
    const listId = listEvents[0]!.occurrenceId
    const validation = events.find((event) => event.kind === 'tool-validation' && event.eventKind === 'started')!
    const authorization = events.find((event) => event.kind === 'tool-authorization' && event.eventKind === 'started')!
    const approval = events.find((event) => event.kind === 'tool-approval' && event.eventKind === 'started')!
    expect(validation.causeOccurrenceId).toBe(listId)
    expect(authorization.causeOccurrenceId).toBe(validation.occurrenceId)
    expect(approval.causeOccurrenceId).toBe(authorization.occurrenceId)

    // 审批等待状态带明确原因。
    const waiting = events.find((event) => event.kind === 'tool-approval' && event.status === 'waiting')!
    expect(waiting.waitReason).toBe('approval')
    expect(waiting.reason).toBe('approval')
  })

  it('finishes the model response at message commit, before the tool chain', () => {
    const recorder = beginToolRound()
    // 模型响应消息提交（流结束）→ 模型立即终态化，早于任何工具链事件。
    recorder.recordCommittedMessage({ id: 'assistant-with-tool', role: 'assistant' })
    recorder.recordChunk(senseEnd('call'))
    commitBatch(recorder)

    const events = recordedEvents()
    const modelSucceeded = indexOf(events, 'model', 'status', 'succeeded')
    const listStart = indexOf(events, 'tool-list', 'started')
    const validationStart = indexOf(events, 'tool-validation', 'started')
    expect(modelSucceeded).toBeGreaterThanOrEqual(0)
    expect(listStart).toBeGreaterThan(modelSucceeded)
    expect(validationStart).toBeGreaterThan(listStart)
    const authorizationStart = indexOf(events, 'tool-authorization', 'started')
    expect(authorizationStart).toBeGreaterThan(validationStart)

    // 模型终态带 response 原因，且只终态化一次（提交时；批次边界不再重复）。
    const modelStatuses = events.filter(
      (event) => event.kind === 'model' && event.eventKind === 'status',
    )
    expect(modelStatuses.find((event) => event.status === 'succeeded')?.reason).toBe('response')
    expect(
      events.filter(
        (event) =>
          event.kind === 'model' && event.eventKind === 'status' && event.status === 'succeeded',
      ),
    ).toHaveLength(1)

    // 工具链的清单仍以该模型 occurrence 为前驱。
    const modelId = modelStatuses[0]!.occurrenceId
    const listStartEvent = events.find(
      (event) => event.kind === 'tool-list' && event.eventKind === 'started',
    )!
    expect(listStartEvent.causeOccurrenceId).toBe(modelId)
  })

  it('finishes the model response at message commit, before the tool chain', () => {
    const recorder = beginToolRound()
    // 真实中间件流顺序：模型响应消息（含工具调用）先于 sense_pending/sense_end 提交，
    // 因此模型在工具链（清单/校验/授权/审批）之前就应终态化（reason=response）。
    recorder.recordCommittedMessage({ id: 'assistant-with-tool', role: 'assistant' })
    recorder.recordChunk({
      type: 'sense_pending',
      approvalId: 'call',
      senseName: 'config_manage',
      arguments: '{}',
      supervisionLevel: 1,
    })
    recorder.recordChunk(senseEnd('call'))
    commitBatch(recorder)

    const events = recordedEvents()
    const modelSucceeded = indexOf(events, 'model', 'status', 'succeeded')
    const listStart = indexOf(events, 'tool-list', 'started')
    const validationStart = indexOf(events, 'tool-validation', 'started')
    expect(modelSucceeded).toBeGreaterThanOrEqual(0)
    expect(listStart).toBeGreaterThan(modelSucceeded)
    expect(validationStart).toBeGreaterThan(listStart)

    // 模型只终态化一次，且带 response 原因（批次边界不再重复终态化）。
    const succeeded = events.filter(
      (event) =>
        event.kind === 'model' && event.eventKind === 'status' && event.status === 'succeeded',
    )
    expect(succeeded).toHaveLength(1)
    expect(succeeded[0]?.reason).toBe('response')

    // 工具链的清单仍以该模型 occurrence 为前驱。
    const modelId = events.find((event) => event.kind === 'model' && event.eventKind === 'started')!
      .occurrenceId
    const listStartEvent = events.find(
      (event) => event.kind === 'tool-list' && event.eventKind === 'started',
    )!
    expect(listStartEvent.causeOccurrenceId).toBe(modelId)
  })

  it('starts tool-list at the first tool-chain event even without approval (auto call)', () => {
    const recorder = beginToolRound()
    recorder.recordChunk(senseEnd('call'))
    commitBatch(recorder)

    const events = recordedEvents()
    expect(events.some((event) => event.kind === 'tool-list' && event.eventKind === 'started')).toBe(true)
    expect(events.some((event) => event.kind === 'tool-approval')).toBe(false)
    const listStart = indexOf(events, 'tool-list', 'started')
    const validationStart = indexOf(events, 'tool-validation', 'started')
    expect(validationStart).toBeGreaterThan(listStart)
  })

  it('shares one tool-list occurrence across calls of the same batch', () => {
    const recorder = beginToolRound()
    recorder.recordChunk({
      type: 'sense_pending',
      approvalId: 'a',
      senseName: 'config_manage',
      arguments: '{}',
      supervisionLevel: 1,
    })
    recorder.recordChunk({ ...senseEnd('a'), id: 'a' })
    recorder.recordChunk({ ...senseEnd('b'), id: 'b' })
    reportWorkflow('root', {
      activeNodeId: 'tools',
      batch: {
        id: 'batch',
        complete: true,
        calls: [
          { id: 'a', name: 'config_manage', status: 'pending' },
          { id: 'b', name: 'config_manage', status: 'pending' },
        ],
      },
    })
    recorder.recordChunk({
      type: 'sense_started',
      id: 'b',
      name: 'config_manage',
      arguments: '{}',
      startedAt: 1,
    })
    recorder.recordChunk({ type: 'sense_accept', id: 'b', name: 'config_manage', result: 'ok' })
    recorder.recordChunk({
      type: 'sense_started',
      id: 'a',
      name: 'config_manage',
      arguments: '{}',
      startedAt: 1,
    })
    recorder.recordChunk({ type: 'sense_accept', id: 'a', name: 'config_manage', result: 'ok' })
    recorder.finish('succeeded', 'normal')

    const events = recordedEvents()
    const listOccurrenceIds = new Set(
      events.filter((event) => event.kind === 'tool-list').map((event) => event.occurrenceId),
    )
    expect(listOccurrenceIds.size).toBe(1)
    const listId = [...listOccurrenceIds][0]!
    for (const callId of ['a', 'b']) {
      const validation = events.find(
        (event) => event.kind === 'tool-validation' && event.callId === callId && event.eventKind === 'started',
      )!
      expect(validation.causeOccurrenceId, callId).toBe(listId)
    }
  })

  it('records context at request preparation, after the loop input, as a run-level fact', () => {
    const recorder = startWorkflowRunRecorder('root')
    reportWorkflow('root', { newIteration: true, iteration: 1 })
    reportWorkflow('root', { activeNodeId: 'input' })
    const before = recordedEvents()
    // 上下文不在 recorder 创建时抢占首位：loop 首个事件是 input，与模板链一致。
    expect(before.find((event) => event.kind === 'input')).toBeTruthy()
    expect(before.some((event) => event.kind === 'context')).toBe(false)
    const inputStart = indexOf(before, 'input', 'started')

    reportWorkflow('root', { activeNodeId: 'model', phaseLabel: '准备请求' })
    const after = recordedEvents()
    const contextStart = indexOf(after, 'context', 'started')
    const requestStart = indexOf(after, 'request', 'started')
    expect(contextStart).toBeGreaterThan(inputStart)
    expect(requestStart).toBeGreaterThan(contextStart)
    // run 级 context：不带 iteration/attempt，整个 run 只有一个。
    const contextEvents = after.filter((event) => event.kind === 'context')
    expect(contextEvents.some((event) => event.status === 'succeeded')).toBe(true)
    expect(contextEvents.every((event) => event.iteration === undefined)).toBe(true)
    expect(contextEvents.every((event) => event.attempt === undefined)).toBe(true)
    recorder.finish()
  })

  it('shares one checkpoint occurrence between the boundary and the tool-result message commit', () => {
    const recorder = beginToolRound()
    recorder.recordCommittedMessage({ id: 'assistant-with-tool', role: 'assistant' })
    recorder.recordChunk(senseEnd('call'))
    recorder.recordChunk({
      type: 'sense_started',
      id: 'call',
      name: 'config_manage',
      arguments: '{}',
      startedAt: 1,
    })
    recorder.recordChunk({ type: 'sense_accept', id: 'call', name: 'config_manage', result: 'ok' })
    // 真实流：checkpoint 边界（记录汇总）先于工具结果消息提交。
    reportWorkflow('root', { activeNodeId: 'checkpoint', phaseLabel: '记录汇总' })
    recorder.recordCommittedMessage({ id: 'call', role: 'sense' })
    recorder.finish('succeeded', 'normal')

    const events = recordedEvents()
    const checkpointIds = new Set(
      events.filter((event) => event.kind === 'checkpoint').map((event) => event.occurrenceId),
    )
    // 边界与消息提交复用同一 occurrence："内容记录"只点亮一次，两条入边指向同一对象。
    expect(checkpointIds.size).toBe(1)
    const checkpointEvents = events.filter((event) => event.kind === 'checkpoint')
    expect(checkpointEvents.some((event) => event.status === 'succeeded')).toBe(true)
    expect(
      checkpointEvents.some(
        (event) =>
          event.eventKind === 'anchor-added' &&
          event.anchor?.kind === 'message' &&
          !!event.causeOccurrenceId,
      ),
    ).toBe(true)
  })
})
