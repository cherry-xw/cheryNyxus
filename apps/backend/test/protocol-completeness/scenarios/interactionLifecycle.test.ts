import { existsSync, rmSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Method } from '@chery/protocol'
import config from '@/utils/config.js'
import type {
  ChatAbortResponseData,
  ChatCreateResponseData,
  ChatInputSubmitResponseData,
  ChatListResponseData,
  ChatOpenResponseData,
  ChatRunResumeResponse,
  ChatTimelineGetResponseData,
  InteractionData,
  InteractionListResponseData,
  Notification,
} from '@/service/message/types.js'
import type { RequestHandle } from '@test/helpers/rpcClient.js'
import { bootProtocolService, waitFor, type ProtocolService } from '../helpers/serviceHarness.js'

interface OpenedChat {
  chatId: string
  subscriptionId: string
}

function commandInput(chatId: string, content: string) {
  return {
    chatId,
    commandId: randomUUID(),
    clientMessageId: randomUUID(),
    messageId: randomUUID(),
    content,
  }
}

function notifications(
  service: ProtocolService,
  type: string,
  chatId: string,
  since = 0,
): Notification[] {
  return service.client.received.slice(since).filter(
    (event): event is Notification =>
      event.kind === 'notification' && event.type === type && event.chatId === chatId,
  )
}

describe('interaction, resume, abort, and stream protocol lifecycles', () => {
  let service: ProtocolService
  const opened: OpenedChat[] = []
  const approvalOutput = resolve(
    process.env.CHERY_DIR!,
    'workspace',
    'approval-output.txt',
  )

  beforeAll(async () => {
    service = await bootProtocolService()
  })

  afterEach(async () => {
    for (const chat of opened.splice(0).reverse()) {
      await service.client.call(Method.CHAT_ABORT, { chatId: chat.chatId }).catch(() => undefined)
      await service.client.call(Method.CHAT_CLOSE, {
        subscriptionId: chat.subscriptionId,
      }).catch(() => undefined)
      await service.client.call(Method.CHAT_DELETE, { chatId: chat.chatId }).catch(() => undefined)
    }
    if (existsSync(approvalOutput)) rmSync(approvalOutput, { force: true })
  })

  afterAll(async () => {
    await service.close()
  })

  async function createChat(brain: string, senseGroup: string): Promise<OpenedChat> {
    const created = await service.client.call(Method.CHAT_CREATE, { brain, senseGroup })
    expect(created.success).toBe(true)
    const chatId = (created.data as ChatCreateResponseData).chatId
    const response = await service.client.call(Method.CHAT_OPEN, { scope: 'chat', chatId })
    expect(response.success).toBe(true)
    const subscriptionId = (response.data as ChatOpenResponseData).subscriptionId
    const chat = { chatId, subscriptionId }
    opened.push(chat)
    return chat
  }

  async function submit(chatId: string, content: string): Promise<{
    handle: RequestHandle
    accepted: ChatInputSubmitResponseData
    since: number
  }> {
    const since = service.client.received.length
    const handle = service.client.request(Method.CHAT_INPUT_SUBMIT, commandInput(chatId, content))
    const response = await service.client.awaitResponse(handle)
    expect(response.success).toBe(true)
    return { handle, accepted: response.data as ChatInputSubmitResponseData, since }
  }

  async function interaction(chatId: string, kind: InteractionData['kind']): Promise<InteractionData> {
    const response = await service.client.call(Method.INTERACTION_LIST, { includeActivity: true })
    expect(response.success).toBe(true)
    const records = (response.data as InteractionListResponseData).interactions
    const found = records.find((record) => record.chatId === chatId && record.kind === kind)
    if (!found) throw new Error(`missing ${kind} interaction for ${chatId}`)
    return found
  }

  async function waitForTimeline(
    chatId: string,
    inspect: (messages: ChatTimelineGetResponseData['messages']) => boolean,
    timeoutMs = 10_000,
  ): Promise<ChatTimelineGetResponseData['messages']> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const response = await service.client.call(Method.CHAT_TIMELINE_GET, { chatId })
      const messages = (response.data as ChatTimelineGetResponseData).messages
      if (inspect(messages)) return messages
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
    }
    throw new Error(`timeline condition timed out for ${chatId}`)
  }

  it('runs manual approval accept and rejects a stale revision without mutating the interaction', async () => {
    const { chatId } = await createChat('protocol_approval', 'protocol_write')
    const { handle, accepted, since } = await submit(chatId, 'write only after approval')
    const interrupt = await waitFor(() =>
      notifications(service, 'interrupt', chatId, since).find(
        (event) => (event.data as { senseName?: string }).senseName === 'write_file',
      ),
    )
    expect(interrupt.data).toMatchObject({ needsApproval: true, waitTime: 300000 })
    const pending = await interaction(chatId, 'approval')
    expect(pending).toMatchObject({ status: 'pending', revision: expect.any(Number) })

    const stale = await service.client.call(Method.INTERACTION_APPROVAL_DECIDE, {
      interactionId: pending.interactionId,
      action: 'accept',
      expectedRevision: pending.revision + 1,
      commandId: randomUUID(),
    })
    expect(stale).toMatchObject({ success: false, error: { code: 'INTERACTION_STALE' } })
    expect(await interaction(chatId, 'approval')).toMatchObject({
      status: 'pending',
      revision: pending.revision,
    })

    const commandId = randomUUID()
    const acceptedDecision = await service.client.call(Method.INTERACTION_APPROVAL_DECIDE, {
      interactionId: pending.interactionId,
      action: 'accept',
      expectedRevision: pending.revision,
      commandId,
    })
    expect(acceptedDecision.success).toBe(true)
    const duplicate = await service.client.call(Method.INTERACTION_APPROVAL_DECIDE, {
      interactionId: pending.interactionId,
      action: 'accept',
      expectedRevision: pending.revision,
      commandId,
    })
    expect(duplicate.data).toEqual(acceptedDecision.data)

    await waitFor(() =>
      notifications(service, 'sense_started', chatId, since).find(
        (event) => (event.data as { senseName?: string }).senseName === 'write_file',
      ),
    )
    await waitFor(() => notifications(service, 'accept', chatId, since).at(-1))
    await waitFor(() =>
      notifications(service, 'done', chatId, since).find((event) => event.runId === accepted.runId),
    )
    service.client.release(handle)
    expect(readFileSync(approvalOutput, 'utf8')).toBe('approved protocol write')
  })

  it('treats an explicit approval rejection as a tool result and completes the run', async () => {
    const { chatId } = await createChat('protocol_approval', 'protocol_write')
    const { handle, accepted, since } = await submit(chatId, 'reject the supervised write')
    await waitFor(() => notifications(service, 'interrupt', chatId, since).at(-1))
    const pending = await interaction(chatId, 'approval')
    const decision = await service.client.call(Method.INTERACTION_APPROVAL_DECIDE, {
      interactionId: pending.interactionId,
      action: 'reject',
      reason: 'protocol rejection',
      expectedRevision: pending.revision,
      commandId: randomUUID(),
    })
    expect(decision.success).toBe(true)
    const rejected = await waitFor(() => notifications(service, 'rejected', chatId, since).at(-1))
    expect(rejected.data).toMatchObject({ senseName: 'write_file' })
    expect((rejected.data as { reason: string }).reason).toContain('protocol rejection')
    await waitFor(() =>
      notifications(service, 'done', chatId, since).find((event) => event.runId === accepted.runId),
    )
    service.client.release(handle)
    expect(existsSync(approvalOutput)).toBe(false)
    expect(notifications(service, 'error', chatId, since)).toHaveLength(0)
  })

  it('turns the business approval deadline into rejection and lets the run finish', async () => {
    const previousTimeout = config.global.approval_timeout
    config.global.approval_timeout = 80
    try {
      const { chatId } = await createChat('protocol_approval', 'protocol_write')
      const { handle, accepted, since } = await submit(chatId, 'let approval expire')
      await waitFor(() => notifications(service, 'interrupt', chatId, since).at(-1))
      const rejected = await waitFor(() => notifications(service, 'rejected', chatId, since).at(-1))
      expect(rejected.data).toMatchObject({ senseName: 'write_file' })
      expect((rejected.data as { reason: string }).reason).toContain('超时')
      await waitFor(() =>
        notifications(service, 'done', chatId, since).find((event) => event.runId === accepted.runId),
      )
      service.client.release(handle)
      expect(await interaction(chatId, 'approval')).toMatchObject({ status: 'expired' })
      expect(notifications(service, 'error', chatId, since)).toHaveLength(0)
    } finally {
      config.global.approval_timeout = previousTimeout
    }
  })

  it('parks an unlimited approval at the hard resource deadline and exposes canResume', async () => {
    const previousTimeout = config.global.approval_timeout
    const previousHardTimeout = config.global.approval_hard_timeout
    config.global.approval_timeout = 0
    config.global.approval_hard_timeout = 80
    try {
      const { chatId } = await createChat('protocol_approval', 'protocol_write')
      const { handle, since } = await submit(chatId, 'park this pending approval')
      await waitFor(() => notifications(service, 'interrupt', chatId, since).at(-1))
      const paused = await waitFor(() =>
        notifications(service, 'run.updated', chatId, since).find(
          (event) => (event.data as { status?: string }).status === 'paused',
        ),
      )
      expect(paused.data).toMatchObject({ status: 'paused' })
      service.client.release(handle)
      const listed = await service.client.call(Method.CHAT_LIST, { scope: 'history' })
      expect(listed.success).toBe(true)
      expect(
        (listed.data as ChatListResponseData).chats.find((chat) => chat.chatId === chatId),
      ).toMatchObject({ canResume: true })
      expect(notifications(service, 'done', chatId, since)).toHaveLength(0)
      expect(notifications(service, 'rejected', chatId, since)).toHaveLength(0)
    } finally {
      config.global.approval_timeout = previousTimeout
      config.global.approval_hard_timeout = previousHardTimeout
    }
  })

  it('answers a durable question batch and resumes without a second user message', async () => {
    const { chatId } = await createChat('protocol_question', 'protocol_questions')
    const { handle, since } = await submit(chatId, 'ask one structured question')
    const requested = await waitFor(() =>
      notifications(service, 'question_batch_requested', chatId, since).at(-1),
    )
    const payload = requested.data as {
      batchId: string
      questions: Array<{ questionId: string; options: Array<{ label: string }> }>
    }
    expect(payload.questions).toHaveLength(1)
    expect(payload.questions[0]?.options.map((option) => option.label)).toEqual(['Alpha', 'Beta'])
    const pending = await interaction(chatId, 'question_batch')
    const answer = await service.client.call(Method.INTERACTION_QUESTION_ANSWER, {
      interactionId: pending.interactionId,
      expectedRevision: pending.revision,
      commandId: randomUUID(),
      answers: [{
        questionId: payload.questions[0]!.questionId,
        selectedLabels: ['Beta'],
      }],
    })
    expect(answer.success).toBe(true)
    await waitFor(() =>
      notifications(service, 'question_batch_completed', chatId, since).find(
        (event) => (event.data as { batchId?: string }).batchId === payload.batchId,
      ),
    )
    await waitFor(() => notifications(service, 'done', chatId, since).at(-1))
    service.client.release(handle)

    const timeline = await service.client.call(Method.CHAT_TIMELINE_GET, { chatId })
    const messages = (timeline.data as ChatTimelineGetResponseData).messages
    expect(messages.filter((message) => message.role === 'user')).toHaveLength(1)
    expect(messages.at(-1)?.content).toContain('question answer acknowledged')
  })

  it('resumes a failed run after changing the model without duplicating history', async () => {
    const { chatId } = await createChat('protocol_auth_failure', 'protocol_none')
    const { handle, accepted, since } = await submit(chatId, 'resume this exact user turn')
    await waitFor(() =>
      notifications(service, 'error', chatId, since).find((event) => event.runId === accepted.runId),
    )
    service.client.release(handle)
    await service.client.call(Method.RUNTIME_SET, {
      chatId,
      brain: 'protocol_content',
      senseGroup: 'protocol_none',
      mcpServers: [],
    })
    const resumedAt = service.client.received.length
    const response = await service.client.call(Method.CHAT_RUN_RESUME, {
      chatId,
      commandId: randomUUID(),
    })
    expect(response.success).toBe(true)
    const resumed = response.data as ChatRunResumeResponse
    expect(resumed.status).toBe('started')
    await waitFor(() =>
      notifications(service, 'done', chatId, resumedAt).find((event) => event.runId === resumed.runId),
    )
    const timeline = await service.client.call(Method.CHAT_TIMELINE_GET, { chatId })
    const messages = (timeline.data as ChatTimelineGetResponseData).messages
    expect(messages.filter((message) => message.role === 'user')).toHaveLength(1)
    expect(messages.at(-1)?.content).toContain('protocol content response')
  })

  it('aborts a first-token wait promptly and keeps command replay idempotent', async () => {
    const { chatId } = await createChat('protocol_abort', 'protocol_none')
    const { handle, accepted, since } = await submit(chatId, 'abort before any provider output')
    await waitFor(() =>
      notifications(service, 'run.updated', chatId, since).find(
        (event) => (event.data as { status?: string }).status === 'running',
      ),
    )
    const commandId = randomUUID()
    const startedAt = Date.now()
    const aborted = await service.client.call(Method.CHAT_ABORT, {
      chatId,
      runId: accepted.runId,
      commandId,
    })
    expect(Date.now() - startedAt).toBeLessThan(1500)
    expect(aborted.success).toBe(true)
    expect(aborted.data as ChatAbortResponseData).toMatchObject({
      chatId,
      runId: accepted.runId,
      aborted: true,
      status: 'paused',
      results: [expect.objectContaining({
        chatId,
        runId: accepted.runId,
        state: 'paused',
        outcome: 'stopped',
      })],
    })
    const replay = await service.client.call(Method.CHAT_ABORT, {
      chatId,
      runId: accepted.runId,
      commandId,
    })
    expect(replay.data).toEqual(aborted.data)
    service.client.release(handle)
    expect(notifications(service, 'done', chatId, since)).toHaveLength(0)
  })

  it('preserves ordered thinking/content deltas and monotonic persisted sequence numbers', async () => {
    const { chatId } = await createChat('protocol_stream', 'protocol_none')
    const { handle, accepted, since } = await submit(chatId, 'stream both channels')
    await waitFor(() =>
      notifications(service, 'done', chatId, since).find((event) => event.runId === accepted.runId),
    )
    service.client.release(handle)
    const deltas = notifications(service, 'turn.delta', chatId, since)
    expect(deltas.map((event) => (event.data as { channel: string }).channel)).toEqual([
      'thinking',
      'thinking',
      'content',
      'content',
    ])
    expect(deltas.map((event) => (event.data as { offset: number }).offset)).toEqual([
      0,
      'protocol-thought-1'.length,
      0,
      'protocol-content-1'.length,
    ])
    const seqs = service.client.received.slice(since)
      .filter((event): event is Notification => event.kind === 'notification')
      .map((event) => event.seq)
      .filter((seq): seq is number => typeof seq === 'number')
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(seqs.length)
  })

  it('queues a second input with one-based sequence and replays its command idempotently', async () => {
    const { chatId } = await createChat('protocol_queue', 'protocol_none')
    const first = await submit(chatId, 'first queued protocol input')
    expect(first.accepted).toMatchObject({ state: 'started', queueSequence: 1 })
    await waitFor(() =>
      notifications(service, 'run.updated', chatId, first.since).find(
        (event) => (event.data as { status?: string }).status === 'running',
      ),
    )

    const secondInput = commandInput(chatId, 'second queued protocol input')
    const secondHandle = service.client.request(Method.CHAT_INPUT_SUBMIT, secondInput)
    const secondResponse = await service.client.awaitResponse(secondHandle)
    expect(secondResponse.success).toBe(true)
    const second = secondResponse.data as ChatInputSubmitResponseData
    expect(second).toMatchObject({ state: 'queued', queueSequence: 2 })
    const duplicate = await service.client.call(Method.CHAT_INPUT_SUBMIT, secondInput)
    expect(duplicate.data).toEqual(secondResponse.data)

    const messages = await waitForTimeline(
      chatId,
      (current) =>
        current.filter((message) => message.role === 'user').length === 2 &&
        current.filter((message) => message.role === 'assistant').length >= 2,
    )
    service.client.release(first.handle)
    service.client.release(secondHandle)
    expect(messages.filter((message) => message.role === 'user')).toHaveLength(2)
    expect(messages.filter((message) => message.role === 'assistant')).toHaveLength(2)
    expect(messages.filter((message) => message.content === 'queued response completed')).toHaveLength(2)
  })

  it('rolls a partial provider attempt into one clean durable assistant turn', async () => {
    const { chatId } = await createChat('protocol_retry_partial', 'protocol_none')
    const { handle, accepted, since } = await submit(chatId, 'recover after partial output')
    await waitFor(() =>
      notifications(service, 'done', chatId, since).find((event) => event.runId === accepted.runId),
      12_000,
    )
    service.client.release(handle)
    const startedTurns = notifications(service, 'turn.started', chatId, since)
    const turnIds = startedTurns.map((event) => (event.data as { turnId: string }).turnId)
    expect(new Set(turnIds).size).toBe(2)
    const cancelled = notifications(service, 'turn.cancelled', chatId, since)
    expect(cancelled).toHaveLength(1)
    expect(cancelled[0]?.data).toMatchObject({
      turnId: turnIds[0],
      messageId: turnIds[0],
      reason: 'retry_reset',
      cancelledAt: expect.any(Number),
    })
    const reverse = service.client.received.slice(since).find(
      (event) =>
        event.kind === 'chunk' &&
        event.type === 'staged' &&
        (event.data as { type?: string }).type === 'reverse',
    )
    expect(reverse?.data).toMatchObject({ type: 'reverse', messageIds: [turnIds[0]] })
    const lifecycle = service.client.received.slice(since)
    expect(lifecycle.indexOf(cancelled[0]!)).toBeLessThan(lifecycle.indexOf(reverse!))
    const staged = service.client.received.slice(since).filter(
      (event) => event.kind === 'chunk' && event.type === 'staged',
    )
    expect(staged.at(-1)?.data).toMatchObject({
      type: 'content_end',
      content: 'retry-clean-success',
    })
    const timeline = await service.client.call(Method.CHAT_TIMELINE_GET, { chatId })
    const messages = (timeline.data as ChatTimelineGetResponseData).messages
    expect(messages.some((message) => message.content?.includes('discarded-partial'))).toBe(false)
    expect(messages.at(-1)?.content).toContain('retry-clean-success')
  }, 15_000)
})
