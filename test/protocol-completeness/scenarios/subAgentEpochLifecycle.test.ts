import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Method } from '@chery/protocol'
import { getMockProviderTranscript, resetMockProviderState } from '@/agent/provider/mock.js'
import { getChat } from '@/db/chat.js'
import { getSpawnTaskByChild } from '@/db/delivery.js'
import { applyRetiredRoles } from '@/service/config/roleLifecycle.js'
import type {
  ChatCreateResponseData,
  ChatEpochListResponseData,
  ChatInputSubmitResponseData,
  ChatListResponseData,
  ChatOpenResponseData,
  ChatTimelineGetResponseData,
  Notification,
  RoleCreatedNotificationData,
  RoleReplyNotificationData,
  SessionRuntimeSetResponseData,
} from '@/service/message/types.js'
import type { RequestHandle } from '@test/helpers/rpcClient.js'
import { bootProtocolService, waitFor, type ProtocolService } from '../helpers/serviceHarness.js'
import { buildReferenceCanonicalTimelineTree } from '../graph/referenceExecutionTree.js'

function installReplacementMockFixture(): void {
  writeFileSync(
    resolve(process.env.CHERY_DIR!, '.chery/mock/spawn-replacement.yaml'),
    [
      'repeat: last',
      'script:',
      '  - content: dispatching replacement protocol child',
      '    senseCalls:',
      '      - name: spawn_role',
      `        arguments: '{"type":"protocol_replacement","prompt":"run in the new epoch","wake":"immediate"}'`,
      '',
    ].join('\n'),
    'utf8',
  )
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

function notifications(service: ProtocolService, type: string, chatId?: string): Notification[] {
  return service.client.received.filter(
    (event): event is Notification =>
      event.kind === 'notification' &&
      event.type === type &&
      (chatId === undefined || event.chatId === chatId),
  )
}

async function waitForRoleCreated(
  service: ProtocolService,
  parentChatId: string,
  role?: string,
): Promise<RoleCreatedNotificationData> {
  return waitFor(() =>
    notifications(service, 'role_created', parentChatId)
      .map((event) => event.data as RoleCreatedNotificationData)
      .find((data) => data.parentChatId === parentChatId && (!role || data.type === role)),
  )
}

async function waitForRoleReply(
  service: ProtocolService,
  parentChatId: string,
  childChatId: string,
): Promise<RoleReplyNotificationData> {
  return waitFor(() =>
    notifications(service, 'role_reply', parentChatId)
      .map((event) => event.data as RoleReplyNotificationData)
      .find((data) => data.childChatId === childChatId),
  )
}

async function waitForDone(
  service: ProtocolService,
  chatId: string,
  handle?: RequestHandle,
): Promise<Notification> {
  const done = await waitFor(() =>
    notifications(service, 'done', chatId).find((event) => event.chatId === chatId),
  )
  if (handle) service.client.release(handle)
  return done
}

async function createRoot(
  service: ProtocolService,
  brain: string,
): Promise<{ chatId: string; subscriptionId: string }> {
  const presetByBrain: Record<string, string> = {
    protocol_spawn_reader: 'protocol-spawn-reader',
    protocol_spawn_failure: 'protocol-spawn-failure',
    protocol_spawn_slow: 'protocol-spawn-slow',
  }
  const preset = presetByBrain[brain]
  if (!preset) throw new Error(`missing protocol spawn preset for brain: ${brain}`)
  const created = await service.client.call(Method.CHAT_CREATE, {
    preset,
    // 测试要求全新会话（断言新纪元/新运行），显式关闭 chat.create 空白复用检查
    skipBlankReuse: true,
  })
  expect(created.success).toBe(true)
  const chatId = (created.data as ChatCreateResponseData).chatId
  const opened = await service.client.call(Method.CHAT_OPEN, {
    scope: 'root',
    rootChatId: chatId,
    view: 'tree',
  })
  expect(opened.success).toBe(true)
  return {
    chatId,
    subscriptionId: (opened.data as ChatOpenResponseData).subscriptionId,
  }
}

async function closeAndDelete(
  service: ProtocolService,
  chatId: string,
  subscriptionId: string,
): Promise<void> {
  await service.client.call(Method.CHAT_CLOSE, { subscriptionId })
  await service.client.call(Method.CHAT_DELETE, { chatId })
}

describe('sub-Agent and epoch lifecycle through the public protocol', () => {
  let service: ProtocolService

  beforeAll(async () => {
    service = await bootProtocolService()
  })

  beforeEach(() => {
    // The active epoch keeps the historical assistant turn, so this stateless
    // mock must explicitly repeat its sole dispatch response at turn index 1.
    installReplacementMockFixture()
    resetMockProviderState()
  })

  afterAll(async () => {
    await service.close()
  })

  it('dispatches a child, executes its real tool, returns its reply, and builds the root timeline', async () => {
    const { chatId, subscriptionId } = await createRoot(service, 'protocol_spawn_reader')
    const submitHandle = service.client.request(
      Method.CHAT_INPUT_SUBMIT,
      commandInput(chatId, 'delegate a real file read'),
    )
    const submitted = await service.client.awaitResponse(submitHandle)
    expect(submitted.success).toBe(true)
    const rootRunId = (submitted.data as ChatInputSubmitResponseData).runId

    const created = await waitForRoleCreated(service, chatId, 'protocol_reader')
    await waitForDone(service, chatId, submitHandle)
    const childDone = await waitForDone(service, created.chatId)
    const reply = await waitForRoleReply(service, chatId, created.chatId)

    expect(childDone.data).toMatchObject({ finished: true, canResume: false })
    expect(reply).toMatchObject({
      parentChatId: chatId,
      childChatId: created.chatId,
      type: 'protocol_reader',
      content: expect.stringContaining('isolated fixture read completed'),
    })
    expect(notifications(service, 'error', created.chatId)).toHaveLength(0)
    expect(getMockProviderTranscript().filter((entry) => entry.chatId === created.chatId)).toEqual([
      expect.objectContaining({ turn: 0, outcome: 'response', toolNames: ['read_file'] }),
      expect.objectContaining({ turn: 1, outcome: 'response', toolNames: [] }),
    ])

    const timelineResponse = await service.client.call(Method.CHAT_TIMELINE_GET, {
      rootChatId: chatId,
      view: 'tree',
    })
    expect(timelineResponse.success).toBe(true)
    const rootTimeline = (timelineResponse.data as ChatTimelineGetResponseData).rootTimeline!
    const referenceTree = buildReferenceCanonicalTimelineTree(rootTimeline)
    expect(referenceTree.nodes.map((node) => node.id)).toEqual(
      rootTimeline.nodes
        .map((node) => node.id)
        .sort((a, b) => {
          const left = rootTimeline.nodes.find((node) => node.id === a)!
          const right = rootTimeline.nodes.find((node) => node.id === b)!
          return left.orderKey - right.orderKey || a.localeCompare(b)
        }),
    )
    expect(referenceTree.edges).toHaveLength(rootTimeline.edges.length)
    expect(referenceTree.roots.length).toBeGreaterThan(0)
    expect(rootTimeline.nodes.some((node) => node.sourceChatId === created.chatId)).toBe(true)
    expect(rootTimeline.edges.some((edge) => edge.kind === 'spawn')).toBe(true)
    expect(rootTimeline.edges.some((edge) => edge.kind === 'return')).toBe(true)
    expect(
      rootTimeline.activeRuns.some((run) => run.runId === rootRunId && run.status === 'running'),
    ).toBe(false)

    await closeAndDelete(service, chatId, subscriptionId)
  })

  it('isolates a child model failure and reports exactly one structured child error', async () => {
    const { chatId, subscriptionId } = await createRoot(service, 'protocol_spawn_failure')
    const submitHandle = service.client.request(
      Method.CHAT_INPUT_SUBMIT,
      commandInput(chatId, 'delegate the failing child'),
    )
    await service.client.awaitResponse(submitHandle)
    const created = await waitForRoleCreated(service, chatId, 'protocol_failing')
    await waitForDone(service, chatId, submitHandle)
    const childError = await waitFor(() => notifications(service, 'error', created.chatId).at(-1))
    const childOutcome = await waitFor(() =>
      notifications(service, 'run.outcome', created.chatId).at(-1),
    )

    expect(childError.data).toMatchObject({
      code: 'RUN_AUTH_FAILED',
      source: 'brain',
      retryable: false,
      tracingId: expect.any(String),
      canResume: true,
    })
    expect(childOutcome.data).toMatchObject({
      status: 'failed',
      reasonCode: 'RUN_AUTH_FAILED',
      retryable: false,
      canResume: true,
      feedback: {
        code: 'RUN_AUTH_FAILED',
        severity: 'error',
        source: 'brain',
      },
    })
    expect(service.client.received.indexOf(childOutcome)).toBeLessThan(
      service.client.received.indexOf(childError),
    )
    expect(notifications(service, 'run.outcome', created.chatId)).toHaveLength(1)
    expect(notifications(service, 'error', created.chatId)).toHaveLength(1)
    expect(notifications(service, 'error', chatId)).toHaveLength(0)
    expect(getMockProviderTranscript().filter((entry) => entry.chatId === created.chatId)).toEqual([
      expect.objectContaining({ attempt: 1, outcome: 'error' }),
    ])

    await closeAndDelete(service, chatId, subscriptionId)
  })

  it('retires completed history, rotates model/tool/role context, and dispatches a new child in the new epoch', async () => {
    const { chatId, subscriptionId } = await createRoot(service, 'protocol_spawn_reader')
    const firstHandle = service.client.request(
      Method.CHAT_INPUT_SUBMIT,
      commandInput(chatId, 'create the historical child branch'),
    )
    await service.client.awaitResponse(firstHandle)
    const oldChild = await waitForRoleCreated(service, chatId, 'protocol_reader')
    await waitForDone(service, chatId, firstHandle)
    await waitForDone(service, oldChild.chatId)
    await waitForRoleReply(service, chatId, oldChild.chatId)

    const beforeEpochsResponse = await service.client.call(Method.CHAT_EPOCH_LIST, { chatId })
    const beforeEpochs = beforeEpochsResponse.data as ChatEpochListResponseData
    expect(beforeEpochs.epochs).toHaveLength(1)
    const historicalEpochId = beforeEpochs.activeEpochId!

    const changed = await service.client.call(Method.SESSION_RUNTIME_SET, {
      chatId,
      primary: {
        brain: 'protocol_spawn_replacement',
        senseGroup: 'protocol_spawn_v2',
        mcpServers: [],
      },
      roles: {
        protocol_replacement: {
          brain: 'protocol_content',
          senseGroup: 'protocol_none',
          mcpServers: [],
        },
      },
    })
    expect(changed.success).toBe(true)
    expect((changed.data as SessionRuntimeSetResponseData).applied).toContain(oldChild.chatId)
    expect(getChat(oldChild.chatId)?.lifecycle).toBe('retired')

    const afterEpochsResponse = await service.client.call(Method.CHAT_EPOCH_LIST, { chatId })
    const afterEpochs = afterEpochsResponse.data as ChatEpochListResponseData
    expect(afterEpochs.epochs).toHaveLength(2)
    expect(afterEpochs.activeEpochId).not.toBe(historicalEpochId)
    expect(afterEpochs.epochs.find((epoch) => epoch.epochId === historicalEpochId)).toMatchObject({
      status: 'historical',
      executable: false,
    })
    expect(
      afterEpochs.epochs.find((epoch) => epoch.epochId === afterEpochs.activeEpochId),
    ).toMatchObject({
      status: 'active',
      executable: true,
      transitionReason: 'session-runtime-changed',
    })

    const oldPrompt = await service.client.call(Method.CHAT_PROMPT_SNAPSHOT, {
      chatId,
      epochId: historicalEpochId,
    })
    expect(oldPrompt.success).toBe(true)
    const listed = await service.client.call(Method.CHAT_LIST, { scope: 'stage' })
    const retiredChild = (listed.data as ChatListResponseData).chats.find(
      (chat) => chat.chatId === oldChild.chatId,
    )
    expect(retiredChild).toMatchObject({ lifecycle: 'retired' })
    expect(retiredChild).not.toHaveProperty('activeEpochId')

    resetMockProviderState()
    const nextHandle = service.client.request(
      Method.CHAT_INPUT_SUBMIT,
      commandInput(chatId, 'dispatch only the replacement role'),
    )
    await service.client.awaitResponse(nextHandle)
    const replacement = await waitForRoleCreated(service, chatId, 'protocol_replacement')
    await waitForDone(service, chatId, nextHandle)
    await waitForDone(service, replacement.chatId)
    await waitForRoleReply(service, chatId, replacement.chatId)

    expect(replacement.chatId).not.toBe(oldChild.chatId)
    expect(getChat(replacement.chatId)?.lifecycle).toBe('active')
    expect(getMockProviderTranscript().filter((entry) => entry.chatId === chatId)).toEqual([
      expect.objectContaining({
        model: 'protocol_spawn_replacement',
        // Epoch changes preserve the complete conversation history, so the
        // stateless mock sees the historical root assistant as turn 0.
        turn: 1,
        toolNames: ['spawn_role'],
      }),
    ])
    const currentPrompt = await service.client.call(Method.CHAT_PROMPT_SNAPSHOT, { chatId })
    expect(currentPrompt.success).toBe(true)
    expect((currentPrompt.data as { epochId?: string }).epochId).toBe(afterEpochs.activeEpochId)

    await closeAndDelete(service, chatId, subscriptionId)
  })

  it('abandons a running child subtree when its role is deleted and refuses to resume it', async () => {
    const { chatId, subscriptionId } = await createRoot(service, 'protocol_spawn_slow')
    const submitHandle = service.client.request(
      Method.CHAT_INPUT_SUBMIT,
      commandInput(chatId, 'create a running child that will be deleted'),
    )
    await service.client.awaitResponse(submitHandle)
    const child = await waitForRoleCreated(service, chatId, 'protocol_slow')
    await waitFor(() => getMockProviderTranscript().find((entry) => entry.chatId === child.chatId))

    const lifecycle = applyRetiredRoles({
      roleIds: [],
      roleNames: ['protocol_slow'],
      rootChatIds: [chatId],
      reason: 'protocol test role deletion',
    })
    expect(lifecycle.abandonedChatIds).toContain(child.chatId)
    expect(getChat(child.chatId)?.lifecycle).toBe('abandoned')
    expect(getSpawnTaskByChild(child.chatId)?.status).toBe('abandoned')

    const resume = await service.client.call(Method.CHAT_RUN_RESUME, {
      chatId: child.chatId,
      commandId: randomUUID(),
    })
    expect(resume.success).toBe(false)
    expect(resume.error).toMatchObject({
      source: 'system',
      retryable: false,
      tracingId: expect.any(String),
    })
    const listed = await service.client.call(Method.CHAT_LIST, { scope: 'stage' })
    expect(
      (listed.data as ChatListResponseData).chats.find((chat) => chat.chatId === child.chatId),
    ).toMatchObject({ lifecycle: 'abandoned' })

    const abandoned = await waitFor(() =>
      notifications(service, 'child_abandoned', chatId).find(
        (event) => (event.data as { childChatId?: string }).childChatId === child.chatId,
      ),
    )
    expect(abandoned.data).toMatchObject({
      parentChatId: chatId,
      childChatId: child.chatId,
      type: 'protocol_slow',
      reason: 'protocol test role deletion',
    })
    service.client.release(submitHandle)
    await closeAndDelete(service, chatId, subscriptionId)
  }, 15_000)
})
