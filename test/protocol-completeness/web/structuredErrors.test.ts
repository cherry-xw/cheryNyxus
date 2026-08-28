import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import { fail } from '../../../web/src/services/agentApi'
import { wsClient, type ConnectionStatus, type RpcResponse } from '../../../web/src/services/ws'
import { createEmptySession } from '../../../web/src/stores/chats/model/hydration'
import { reduce } from '../../../web/src/stores/chats/model/reducer'
import { useChatSessionsStore } from '../../../web/src/stores/chats'
import { createStreamRouter } from '../../../web/src/stores/agents/ui/streamRouter'
import type { StreamState } from '../../../web/src/stores/agents/types'
import type { PetInstance } from '../../../web/src/domain/pets/types'

const protocolError = {
  code: 'RATE_LIMITED',
  message: 'provider quota exceeded',
  source: 'brain' as const,
  retryable: true,
  tracingId: 'trace-structured-error',
  retryAfterMs: 2500,
}

const mutableWs = wsClient as unknown as { status: ConnectionStatus }

beforeEach(() => {
  setActivePinia(createPinia())
  mutableWs.status = 'connected'
})

afterEach(() => {
  mutableWs.status = 'disconnected'
  vi.restoreAllMocks()
})

describe('structured error delivery to web state', () => {
  it('copies every Response.error field onto the thrown Error', () => {
    const response: RpcResponse = {
      id: 'response-1',
      kind: 'response',
      requestId: 'request-1',
      success: false,
      error: protocolError,
    }

    expect(fail('chat.input.submit', response)).toMatchObject(protocolError)
  })

  it('marks an optimistic message failed without losing response diagnostics', async () => {
    vi.spyOn(wsClient, 'rpc').mockResolvedValue({
      id: 'response-1',
      kind: 'response',
      requestId: 'request-1',
      success: false,
      error: protocolError,
    })
    const store = useChatSessionsStore()
    const session = store.ensureEntity('root-chat')
    session.sync.loaded = true

    await expect(store.submitInput('root-chat', 'hello')).rejects.toMatchObject(protocolError)

    const optimistic = Object.values(session.messagesById).find((message) => message.delivery)
    expect(optimistic?.delivery).toMatchObject({ status: 'failed', error: protocolError })
    expect(session.run.errorFact).toMatchObject(protocolError)
  })

  it('records a run notification as paused plus one structured notification signal', () => {
    const session = createEmptySession('root-chat')
    session.run.status = 'running'
    session.run.activeRunId = 'run-1'

    reduce(
      session,
      {
        kind: 'notification',
        type: 'error',
        requestId: 'request-1',
        chatId: 'root-chat',
        runId: 'run-1',
        data: { ...protocolError, canResume: true },
      },
      { now: 1000 },
    )

    expect(session.run).toMatchObject({
      status: 'paused',
      error: protocolError.message,
      errorFact: { ...protocolError, canResume: true },
      retainUntil: 31_000,
    })
    expect(session.context.canResume).toBe(true)
  })

  it('isolates child failures and suppresses historical replay side effects', () => {
    const store = useChatSessionsStore()
    const parent = store.ensureEntity('parent-chat')
    const child = store.ensureEntity('child-chat', { parentChatId: 'parent-chat' })

    store.applyEvent('child-chat', {
      kind: 'notification',
      type: 'error',
      chatId: 'child-chat',
      runId: 'child-run',
      data: { ...protocolError, canResume: false },
    })

    expect(child.run.errorFact).toMatchObject(protocolError)
    expect(parent.run.errorFact).toBeUndefined()

    parent.sync.replaying = true
    store.applyEvent(
      'parent-chat',
      {
        kind: 'notification',
        type: 'error',
        chatId: 'parent-chat',
        runId: 'historical-run',
        data: { ...protocolError, canResume: true },
      },
      'replay',
    )
    expect(parent.run.errorFact).toBeUndefined()
    expect(parent.run.retainUntil).toBeUndefined()
  })

  it('does not promote a tool rejection into a run failure', () => {
    const session = createEmptySession('root-chat')
    session.run.status = 'running'

    reduce(
      session,
      {
        kind: 'notification',
        type: 'rejected',
        chatId: 'root-chat',
        data: { approvalId: 'tool-call-1', reason: 'permission denied' },
      },
      { now: 1000 },
    )

    expect(session.run.status).toBe('running')
    expect(session.run.errorFact).toBeUndefined()
  })

  it('preserves the same facts in the legacy Pet stream without replaying its error bubble', () => {
    const pet = {
      instanceId: 'pet-1',
      chatId: 'root-chat',
      isMaster: true,
      isGhost: false,
      isWorking: true,
      canResume: false,
    } as PetInstance
    const streams = ref<Record<string, StreamState>>({})
    const router = createStreamRouter(
      streams,
      ref([pet]),
      new Map(),
      (target, working) => {
        if (target) target.isWorking = working
      },
      () => {},
      async () => {},
      async () => {},
      () => 'ghost',
      ref([]),
    )
    const stream = router.ensureStream('root-chat')

    router.routeNotification({
      kind: 'notification',
      type: 'error',
      chatId: 'root-chat',
      runId: 'run-1',
      data: { ...protocolError, canResume: true },
    })
    expect(stream.errorFact).toMatchObject({ ...protocolError, canResume: true })
    expect(stream.error).toBe(protocolError.message)

    stream.error = undefined
    stream.errorFact = undefined
    stream.replaying = true
    router.routeNotification({
      kind: 'notification',
      type: 'error',
      chatId: 'root-chat',
      runId: 'old-run',
      data: { ...protocolError, canResume: true },
    })
    expect(stream.error).toBeUndefined()
    expect(stream.errorFact).toBeUndefined()
  })
})
