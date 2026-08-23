import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { agentApi, type InteractionRecord } from '../../src/services/agentApi'
import { wsClient } from '../../src/services/ws'
import { commandGate } from '../../src/stores/commandLifecycle'
import { useChatSessionsStore } from '../../src/stores/chats'
import { createEmptySession } from '../../src/stores/chats/hydration'
import { reduce } from '../../src/stores/chats/reducer'
import { useInteractionsStore, validateInteractionAnswers } from '../../src/stores/interactions'

function interaction(
  kind: InteractionRecord['kind'],
  overrides: Partial<InteractionRecord> = {},
): InteractionRecord {
  return {
    interactionId: kind === 'approval' ? 'approval-1' : 'batch-1',
    kind,
    chatId: 'root',
    rootChatId: 'root',
    status: 'pending',
    payload: {},
    revision: 1,
    createdAt: 10,
    updatedAt: 10,
    ...overrides,
  }
}

function readyRoot(): ReturnType<typeof useChatSessionsStore> {
  const chats = useChatSessionsStore()
  chats.ensureEntity('root').sync.loaded = true
  vi.spyOn(wsClient, 'getStatus').mockReturnValue('connected')
  return chats
}

describe('canonical command and interaction lifecycle', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.restoreAllMocks()
  })

  it.each([
    [{ connectionStatus: 'disconnected', rootChatId: 'root', hydrated: true }, 'RECONNECTING'],
    [{ connectionStatus: 'connecting', rootChatId: 'root', hydrated: true }, 'CONNECTING'],
    [{ connectionStatus: 'connected', rootChatId: undefined, hydrated: false }, 'ROOT_REQUIRED'],
    [
      { connectionStatus: 'connected', rootChatId: 'root', hydrated: false, hydrating: true },
      'HYDRATING',
    ],
    [
      {
        connectionStatus: 'connected',
        rootChatId: 'root',
        hydrated: true,
        fatalError: '会话状态不可用',
      },
      'SESSION_UNAVAILABLE',
    ],
  ] as const)('blocks an unsafe command state with an actionable reason', (input, code) => {
    expect(commandGate(input)).toMatchObject({ allowed: false, code })
  })

  it('allows commands only after connection and hydration are ready', () => {
    expect(
      commandGate({ connectionStatus: 'connected', rootChatId: 'root', hydrated: true }),
    ).toEqual({ allowed: true })
  })

  it('applies one done fact to final body, resume state, clock and completion timing', () => {
    const session = createEmptySession('root')
    session.run.status = 'running'
    session.run.activeRunId = 'run-1'
    session.executionSteps = [
      {
        id: 'model-1',
        runId: 'run-1',
        chatId: 'root',
        kind: 'model',
        status: 'running',
        startedAt: 100,
      },
    ]
    reduce(
      session,
      {
        kind: 'notification',
        type: 'done',
        chatId: 'root',
        runId: 'run-1',
        data: {
          finalMessage: {
            msgId: 'answer-1',
            role: 'assistant',
            content: 'final answer',
            createdAt: 100,
          },
          canResume: true,
          completedAt: 140,
          serverNow: 1_050,
        },
      },
      { now: 1_000 },
    )

    expect(session.messagesById['answer-1']).toMatchObject({
      content: 'final answer',
      status: 'sealed',
    })
    expect(session.context).toMatchObject({ canResume: true, serverClockOffsetMs: 50 })
    expect(session.run).toMatchObject({ status: 'paused', activeRunId: undefined })
    expect(session.activeRun).toMatchObject({
      runId: 'run-1',
      status: 'paused',
      completedAt: 140,
    })
    expect(session.executionSteps[0]).toMatchObject({ status: 'cancelled', completedAt: 140 })
  })

  it('keeps the live clock offset while replaying an old done fact', () => {
    const session = createEmptySession('root')
    session.sync.replaying = true
    session.context.serverClockOffsetMs = 77
    session.run.status = 'running'
    session.run.activeRunId = 'historical-run'

    reduce(
      session,
      {
        kind: 'notification',
        type: 'done',
        chatId: 'root',
        runId: 'historical-run',
        data: {
          finalMessage: {
            msgId: 'historical-answer',
            role: 'assistant',
            content: 'replayed final answer',
            createdAt: 100,
          },
          canResume: false,
          completedAt: 140,
          serverNow: 140,
        },
      },
      { now: 10_000 },
    )

    expect(session.context.serverClockOffsetMs).toBe(77)
    expect(session.context.canResume).toBe(false)
    expect(session.messagesById['historical-answer']).toMatchObject({
      content: 'replayed final answer',
      status: 'sealed',
    })
    expect(session.activeRun).toMatchObject({
      runId: 'historical-run',
      status: 'completed',
      completedAt: 140,
    })
  })

  it('keeps outgoing input sending, failed, retryable and committed without a fake commit', async () => {
    const chats = readyRoot()
    const attachments = [{ assetId: 'asset-1', kind: 'image' as const, mimeType: 'image/png' }]
    const firstFailure = Object.assign(new Error('socket lost'), { code: 'NETWORK' })
    const submit = vi
      .spyOn(agentApi, 'submitChatInput')
      .mockRejectedValueOnce(firstFailure)
      .mockImplementationOnce(async (params) => ({
        chatId: 'root',
        inputId: 'input-1',
        clientMessageId: params.clientMessageId,
        messageId: params.messageId,
        runId: 'run-1',
        state: 'started',
        queueSequence: 1,
        acceptedAt: 50,
      }))

    const prepared = chats.prepareInput('root', 'hello')
    const message = chats.sessionsById.root!.messagesById[prepared.messageId]!

    await expect(chats.submitInput('root', 'hello', attachments, prepared)).rejects.toThrow(
      'socket lost',
    )
    attachments[0]!.assetId = 'mutated-after-submit'
    expect(message.delivery).toMatchObject({
      status: 'failed',
      commandId: prepared.commandId,
      attachments: [{ assetId: 'asset-1', kind: 'image', mimeType: 'image/png' }],
      error: { code: 'NETWORK' },
    })

    await expect(chats.retryInput('root', prepared.messageId)).resolves.toMatchObject({
      inputId: 'input-1',
    })
    expect(submit).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        commandId: prepared.commandId,
        clientMessageId: prepared.clientMessageId,
        messageId: prepared.messageId,
        attachments: [{ assetId: 'asset-1', kind: 'image', mimeType: 'image/png' }],
      }),
    )
    expect(message.delivery).toMatchObject({ status: 'committed' })
    expect(message.delivery?.error).toBeUndefined()
    chats.rollbackPreparedInput(prepared, new Error('late timeline cleanup failure'))
    expect(message.delivery).toMatchObject({ status: 'committed' })
    expect(chats.sessionsById.root!.run.status).toBe('running')
    expect(submit).toHaveBeenCalledTimes(2)
    expect(chats.removeFailedInput('root', prepared.messageId)).toBe(false)
  })

  it('preserves sending and failed messages across timeline replacement without replaying RPCs', () => {
    const chats = readyRoot()
    const submit = vi.spyOn(agentApi, 'submitChatInput')
    const sending = chats.prepareInput('root', 'still sending')
    const failed = chats.prepareInput('root', 'retry later')
    chats.rollbackPreparedInput(failed, Object.assign(new Error('offline'), { code: 'NETWORK' }))

    chats.replaceTimelineSnapshot('root', { chatId: 'root', revision: 2, messages: [] })

    expect(chats.sessionsById.root!.messagesById[sending.messageId]?.delivery?.status).toBe(
      'sending',
    )
    expect(chats.sessionsById.root!.messagesById[failed.messageId]?.delivery?.status).toBe('failed')
    expect(submit).not.toHaveBeenCalled()
  })

  it('gates Workbench continue/stop and deduplicates one root pause resume operation', async () => {
    const chats = readyRoot()
    let finishResume!: () => void
    const resumeTree = vi
      .spyOn(agentApi, 'resumeTree')
      .mockImplementation((rootChatId, pauseId, commandId) =>
        new Promise<void>((resolve) => {
          finishResume = resolve
        }).then(() => ({ rootChatId, pauseId, commandId, status: 'completed', results: [] })),
      )
    const first = chats.resumeTree('root', 'pause-1')
    const second = chats.resumeTree('root', 'pause-1')
    expect(resumeTree).toHaveBeenCalledTimes(1)
    finishResume()
    await Promise.all([first, second])

    vi.mocked(wsClient.getStatus).mockReturnValue('disconnected')
    const abort = vi.spyOn(agentApi, 'abortAgent')
    await expect(chats.resumeTree('root', 'pause-2')).rejects.toMatchObject({
      code: 'RECONNECTING',
    })
    await expect(chats.abortAgent('root')).rejects.toMatchObject({ code: 'RECONNECTING' })
    expect(resumeTree).toHaveBeenCalledTimes(1)
    expect(abort).not.toHaveBeenCalled()
  })

  it('removes only failed local messages', async () => {
    const chats = readyRoot()
    vi.spyOn(agentApi, 'submitChatInput').mockRejectedValue(new Error('offline'))
    const prepared = chats.prepareInput('root', 'keep me')
    await expect(chats.submitInput('root', 'keep me', undefined, prepared)).rejects.toThrow()

    expect(chats.sessionsById.root!.messagesById[prepared.messageId]?.delivery?.status).toBe(
      'failed',
    )
    expect(chats.removeFailedInput('root', prepared.messageId)).toBe(true)
    expect(chats.sessionsById.root!.messagesById[prepared.messageId]).toBeUndefined()
  })

  it('validates every required single-choice and free-text question by question id', () => {
    const item = interaction('question_batch', {
      payload: {
        questions: [
          { questionId: 'choice', options: [{ label: 'A' }], multiSelect: false },
          { questionId: 'text', options: [], multiSelect: false },
        ],
      },
    })
    expect(
      validateInteractionAnswers(item, [
        { questionId: 'choice', selectedLabels: [] },
        { questionId: 'text', selectedLabels: [], freeText: '  ' },
      ]),
    ).toEqual({
      choice: expect.objectContaining({ code: 'REQUIRED' }),
      text: expect.objectContaining({ code: 'REQUIRED' }),
    })
  })

  it('deduplicates approval submission across views and keeps its terminal record', async () => {
    readyRoot()
    const store = useInteractionsStore()
    const item = interaction('approval')
    store.records[item.interactionId] = item
    let resolve!: (value: InteractionRecord) => void
    const decide = vi.spyOn(agentApi, 'decideInteractionApproval').mockReturnValue(
      new Promise((done) => {
        resolve = done
      }),
    )

    const first = store.decide(item, 'accept')
    const second = store.decide(item, 'accept')
    expect(decide).toHaveBeenCalledTimes(1)
    resolve(interaction('approval', { status: 'completed', revision: 3, completedAt: 30 }))
    await Promise.all([first, second])

    expect(store.records[item.interactionId]).toMatchObject({ status: 'completed', revision: 3 })
  })

  it('maps ALREADY_RESOLVED and RATE_LIMITED to the correct interaction only', async () => {
    readyRoot()
    const store = useInteractionsStore()
    const already = interaction('approval', { interactionId: 'already' })
    const limited = interaction('approval', { interactionId: 'limited' })
    store.records = { already, limited }
    vi.spyOn(agentApi, 'listInteractionPage').mockResolvedValue({
      interactions: [
        interaction('approval', {
          interactionId: 'already',
          status: 'completed',
          revision: 2,
          completedAt: 20,
        }),
        limited,
      ],
      serverNow: Date.now(),
    })
    vi.spyOn(agentApi, 'decideInteractionApproval')
      .mockRejectedValueOnce(
        Object.assign(new Error('handled elsewhere'), { code: 'INTERACTION_ALREADY_RESOLVED' }),
      )
      .mockRejectedValueOnce(Object.assign(new Error('slow down'), { code: 'RATE_LIMITED' }))

    await expect(store.decide(already, 'accept')).resolves.toBeUndefined()
    expect(store.records.already).toMatchObject({ status: 'completed' })
    expect(store.errorsById.already).toMatchObject({ terminal: true })

    await expect(store.decide(limited, 'accept')).rejects.toThrow('slow down')
    expect(store.errorsById.limited).toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true,
      interactionId: 'limited',
    })
    expect(store.errorsById.already).toMatchObject({ interactionId: 'already' })
  })

  it('binds a normal network error only to its target interaction', async () => {
    readyRoot()
    const store = useInteractionsStore()
    const target = interaction('approval', { interactionId: 'network-target' })
    const untouched = interaction('approval', { interactionId: 'untouched' })
    store.records = { [target.interactionId]: target, [untouched.interactionId]: untouched }
    vi.spyOn(agentApi, 'listInteractionPage').mockResolvedValue({
      interactions: [target, untouched],
    })
    vi.spyOn(agentApi, 'decideInteractionApproval').mockRejectedValue(
      Object.assign(new Error('network down'), { code: 'NETWORK' }),
    )

    await expect(store.decide(target, 'accept')).rejects.toThrow('network down')
    expect(store.errorsById[target.interactionId]).toMatchObject({ code: 'NETWORK' })
    expect(store.errorsById[untouched.interactionId]).toBeUndefined()
  })

  it('keeps an expired approval in activity when a refreshed page truncates terminal records', async () => {
    readyRoot()
    const store = useInteractionsStore()
    const item = interaction('approval', { interactionId: 'expires-now' })
    store.records[item.interactionId] = item
    vi.spyOn(agentApi, 'decideInteractionApproval').mockResolvedValue(
      interaction('approval', {
        interactionId: item.interactionId,
        status: 'expired',
        revision: 2,
        completedAt: 20,
      }),
    )
    vi.spyOn(agentApi, 'listInteractionPage').mockResolvedValue({ interactions: [] })

    await store.decide(item, 'accept')
    await store.refresh()

    expect(store.records[item.interactionId]).toMatchObject({ status: 'expired', revision: 2 })
    expect(store.activity.map((record) => record.interactionId)).toContain(item.interactionId)
  })

  it('does not call the question RPC when validation fails', async () => {
    readyRoot()
    const store = useInteractionsStore()
    const item = interaction('question_batch', {
      payload: { questions: [{ questionId: 'required', options: [], multiSelect: false }] },
    })
    store.records[item.interactionId] = item
    const answer = vi.spyOn(agentApi, 'answerInteractionQuestion')

    await expect(
      store.answer(item, [{ questionId: 'required', selectedLabels: [], freeText: '' }]),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(answer).not.toHaveBeenCalled()
    expect(store.questionErrorsById[item.interactionId]?.required).toMatchObject({
      code: 'REQUIRED',
    })
  })

  it('joins an in-flight question answer before validating a second view draft', async () => {
    readyRoot()
    const store = useInteractionsStore()
    const item = interaction('question_batch', {
      payload: { questions: [{ questionId: 'required', options: [], multiSelect: false }] },
    })
    store.records[item.interactionId] = item
    let finish!: (value: InteractionRecord) => void
    const answer = vi.spyOn(agentApi, 'answerInteractionQuestion').mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      }),
    )

    const first = store.answer(item, [
      { questionId: 'required', selectedLabels: [], freeText: 'valid answer' },
    ])
    const second = store.answer(item, [
      { questionId: 'required', selectedLabels: [], freeText: '' },
    ])
    expect(answer).toHaveBeenCalledTimes(1)
    expect(store.questionErrorsById[item.interactionId]?.required).toBeUndefined()
    expect(store.errorsById[item.interactionId]).toBeUndefined()

    finish(
      interaction('question_batch', {
        status: 'completed',
        revision: 2,
        completedAt: 30,
      }),
    )
    await Promise.all([first, second])
    expect(store.records[item.interactionId]).toMatchObject({ status: 'completed' })
  })

  it('rejects a blocked question explicitly instead of silently succeeding', async () => {
    readyRoot()
    const store = useInteractionsStore()
    const item = interaction('question_batch', {
      status: 'blocked',
      payload: { questions: [{ questionId: 'required', options: [], multiSelect: false }] },
    })
    store.records[item.interactionId] = item
    const answer = vi.spyOn(agentApi, 'answerInteractionQuestion')

    await expect(
      store.answer(item, [
        { questionId: 'required', selectedLabels: [], freeText: 'cannot submit' },
      ]),
    ).rejects.toMatchObject({ code: 'INTERACTION_NOT_ACTIONABLE' })
    expect(store.errorsById[item.interactionId]).toMatchObject({
      code: 'INTERACTION_NOT_ACTIONABLE',
    })
    expect(answer).not.toHaveBeenCalled()
  })
})
