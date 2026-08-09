import { describe, expect, it, vi } from 'vitest'
import type { Chunk } from '@/service/message/types.js'
import { Transport } from '@/service/websocket/transport.js'
import { decodeMessage } from '../../../web/src/services/transport'
import { WsClient } from '../../../web/src/services/ws'

type TestableWsClient = WsClient & {
  handleMessage(event: MessageEvent): void
}

function frameData(frame: Buffer): ArrayBuffer {
  return frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer
}

function deliver(client: WsClient, data: string | ArrayBuffer): void {
  ;(client as TestableWsClient).handleMessage({ data } as MessageEvent)
}

describe('binary root subscription envelope', () => {
  it('preserves every root cursor field through binary stream encoding', () => {
    const encoder = new Transport()
    Object.defineProperty(encoder, '_binary', { value: true, writable: true })
    const chunk: Chunk = {
      kind: 'chunk',
      type: 'stream',
      requestId: 'request-1',
      chatId: 'child-1',
      runId: 'run-1',
      seq: 12,
      eventSeq: 101,
      subscriptionId: 'root-subscription',
      rootChatId: 'root-1',
      rootEventSeq: 101,
      sourceEventSeq: 12,
      data: { msgId: 'message-1', createdAt: 1, content: 'token' },
    }

    const encoded = encoder.encode(chunk)
    expect(Buffer.isBuffer(encoded)).toBe(true)
    if (!Buffer.isBuffer(encoded)) throw new Error('expected a binary stream frame')

    expect(decodeMessage(frameData(encoded))).toEqual(chunk)
  })

  it('keeps JSON, binary stream and JSON root events contiguous in the browser', () => {
    const encoder = new Transport()
    Object.defineProperty(encoder, '_binary', { value: true, writable: true })
    const client = new WsClient()
    const received = vi.fn()
    client.onEvent(received)

    const rootFields = {
      chatId: 'root-1',
      rootChatId: 'root-1',
      subscriptionId: 'root-subscription',
    }
    deliver(
      client,
      JSON.stringify({
        kind: 'notification',
        type: 'turn.started',
        ...rootFields,
        seq: 20,
        sourceEventSeq: 20,
        eventSeq: 100,
        rootEventSeq: 100,
        data: { turnId: 'message-1', messageId: 'message-1', runId: 'run-1' },
      }),
    )
    const stream = encoder.encode({
      kind: 'chunk',
      type: 'stream',
      requestId: 'request-1',
      runId: 'run-1',
      ...rootFields,
      seq: 21,
      sourceEventSeq: 21,
      eventSeq: 101,
      rootEventSeq: 101,
      data: { msgId: 'message-1', createdAt: 1, content: 'A' },
    })
    if (!Buffer.isBuffer(stream)) throw new Error('expected a binary stream frame')
    deliver(client, frameData(stream))
    deliver(
      client,
      JSON.stringify({
        kind: 'notification',
        type: 'turn.delta',
        ...rootFields,
        seq: 22,
        sourceEventSeq: 22,
        eventSeq: 102,
        rootEventSeq: 102,
        data: { turnId: 'message-1', channel: 'content', offset: 0, delta: 'A' },
      }),
    )

    expect(received.mock.calls.map(([event]) => event.rootEventSeq)).toEqual([100, 101, 102])
  })
})
