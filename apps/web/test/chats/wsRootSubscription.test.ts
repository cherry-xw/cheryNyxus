import { describe, expect, it, vi } from 'vitest'
import { WsClient } from '../../src/services/ws'

type TestableWsClient = WsClient & {
  handleMessage(event: MessageEvent): void
}

function deliver(client: WsClient, message: unknown): void {
  ;(client as TestableWsClient).handleMessage({ data: JSON.stringify(message) } as MessageEvent)
}

describe('WsClient root subscriptions', () => {
  it('dispatches an existing root event without waiting for unseen per-chat history', () => {
    const client = new WsClient()
    const received = vi.fn()
    client.onEvent(received)

    const event = {
      kind: 'notification',
      type: 'turn.started',
      chatId: 'existing-root',
      seq: 3080,
      sourceEventSeq: 3080,
      rootChatId: 'existing-root',
      rootEventSeq: 7120,
      eventSeq: 7120,
      subscriptionId: 'root-subscription',
      data: { turnId: 'turn-1', messageId: 'message-1' },
    }

    deliver(client, event)

    expect(received).toHaveBeenCalledTimes(1)
    expect(received).toHaveBeenCalledWith(event)
    expect(client.getLastSeq('existing-root')).toBe(0)
  })

  it('keeps an ordinary high per-chat event buffered until its gap is recovered', () => {
    const client = new WsClient()
    const received = vi.fn()
    client.onEvent(received)

    deliver(client, {
      kind: 'notification',
      type: 'turn.started',
      chatId: 'direct-chat',
      seq: 3080,
      eventSeq: 3080,
      data: { turnId: 'turn-1', messageId: 'message-1' },
    })

    expect(received).not.toHaveBeenCalled()
    expect(client.getHighestSeenSeq('direct-chat')).toBe(3080)
  })
})
