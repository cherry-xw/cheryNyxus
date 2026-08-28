import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Method } from '@chery/protocol'
import type {
  ChatCreateResponseData,
  ChatInputSubmitResponseData,
  ChatOpenResponseData,
  ChatTimelineGetResponseData,
  Notification,
} from '@/service/message/types.js'
import type { RequestHandle } from '@test/helpers/rpcClient.js'
import {
  bootProtocolService,
  waitFor,
  type ProtocolService,
} from '../helpers/serviceHarness.js'

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
  _handle?: RequestHandle,
): Notification[] {
  return service.client.received.filter(
    (event): event is Notification =>
      event.kind === 'notification' && event.type === type && event.chatId === chatId,
  )
}

describe('real WebSocket command/session lifecycle', () => {
  let service: ProtocolService

  beforeAll(async () => {
    service = await bootProtocolService()
  })

  afterAll(async () => {
    await service.close()
  })

  it('acknowledges input synchronously and publishes the detached final response', async () => {
    const create = await service.client.call(Method.CHAT_CREATE, {
      brain: 'protocol_content',
      senseGroup: 'protocol_none',
    })
    expect(create.success).toBe(true)
    const chatId = (create.data as ChatCreateResponseData).chatId

    const open = await service.client.call(Method.CHAT_OPEN, { scope: 'chat', chatId })
    const subscriptionId = (open.data as ChatOpenResponseData).subscriptionId
    const submitHandle = service.client.request(
      Method.CHAT_INPUT_SUBMIT,
      commandInput(chatId, 'hello'),
    )
    const submit = await service.client.awaitResponse(submitHandle)
    const accepted = submit.data as ChatInputSubmitResponseData

    expect(submit.success).toBe(true)
    expect(accepted).toMatchObject({ chatId, state: 'started', queueSequence: 1 })
    const done = await waitFor(() =>
      notifications(service, 'done', chatId, submitHandle).at(-1),
    )
    service.client.release(submitHandle)
    expect(done.data).toMatchObject({ canResume: false })

    const timeline = await service.client.call(Method.CHAT_TIMELINE_GET, { chatId })
    const messages = (timeline.data as ChatTimelineGetResponseData).messages
    expect(messages.map((message) => message.role)).toEqual(
      expect.arrayContaining(['user', 'assistant']),
    )
    expect(messages.at(-1)?.content).toContain('protocol content response')

    await service.client.call(Method.CHAT_CLOSE, { subscriptionId })
    await service.client.call(Method.CHAT_DELETE, { chatId })
  })

  it('emits one structured run error, then succeeds after a model change', async () => {
    const create = await service.client.call(Method.CHAT_CREATE, {
      brain: 'protocol_auth_failure',
      senseGroup: 'protocol_none',
    })
    const chatId = (create.data as ChatCreateResponseData).chatId
    const open = await service.client.call(Method.CHAT_OPEN, { scope: 'chat', chatId })
    const subscriptionId = (open.data as ChatOpenResponseData).subscriptionId

    const firstSubmitHandle = service.client.request(
      Method.CHAT_INPUT_SUBMIT,
      commandInput(chatId, 'fail authentication'),
    )
    const firstSubmit = await service.client.awaitResponse(firstSubmitHandle)
    expect(firstSubmit.success).toBe(true)
    expect(firstSubmit.error).toBeUndefined()
    const failedRunId = (firstSubmit.data as ChatInputSubmitResponseData).runId
    const error = await waitFor(() =>
      notifications(service, 'error', chatId, firstSubmitHandle).find(
        (event) => event.runId === failedRunId,
      ),
    )
    expect(error.data).toMatchObject({
      code: expect.any(String),
      source: 'brain',
      retryable: false,
      tracingId: expect.any(String),
      // Authentication is not retryable within the same provider call, but
      // the run remains resumable after the user fixes or changes its model.
      canResume: true,
    })
    expect(
      notifications(service, 'error', chatId, firstSubmitHandle).filter(
        (event) => event.runId === failedRunId,
      ),
    ).toHaveLength(1)
    service.client.release(firstSubmitHandle)

    const runtime = await service.client.call(Method.RUNTIME_SET, {
      chatId,
      brain: 'protocol_content',
      senseGroup: 'protocol_none',
      mcpServers: [],
    })
    expect(runtime.success).toBe(true)

    const secondSubmitHandle = service.client.request(
      Method.CHAT_INPUT_SUBMIT,
      commandInput(chatId, 'recover with the new model'),
    )
    const secondSubmit = await service.client.awaitResponse(secondSubmitHandle)
    const recoveredRunId = (secondSubmit.data as ChatInputSubmitResponseData).runId
    await waitFor(() =>
      notifications(service, 'done', chatId, secondSubmitHandle).find(
        (event) => event.runId === recoveredRunId,
      ),
    )
    service.client.release(secondSubmitHandle)
    expect(
      notifications(service, 'error', chatId, secondSubmitHandle).filter(
        (event) => event.runId === recoveredRunId,
      ),
    ).toHaveLength(0)

    await service.client.call(Method.CHAT_CLOSE, { subscriptionId })
    await service.client.call(Method.CHAT_DELETE, { chatId })
  })
})
