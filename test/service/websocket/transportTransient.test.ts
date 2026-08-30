import { describe, expect, it } from 'vitest'
import type { Chunk } from '@/service/message/types.js'
import { Transport } from '@/service/websocket/transport.js'
import { decodeMessage } from '../../../web/src/services/transport'

describe('binary transient stream envelope', () => {
  it('preserves the transient marker without adding a durable cursor', () => {
    const encoder = new Transport()
    Object.defineProperty(encoder, '_binary', { value: true, writable: true })
    const chunk: Chunk = {
      kind: 'chunk',
      type: 'stream',
      requestId: 'request-transient',
      chatId: 'chat-transient',
      runId: 'run-transient',
      rootChatId: 'chat-transient',
      transient: true,
      data: { msgId: 'message-transient', createdAt: 1, content: 'token' },
    }

    const encoded = encoder.encode(chunk)
    expect(Buffer.isBuffer(encoded)).toBe(true)
    if (!Buffer.isBuffer(encoded)) throw new Error('expected a binary stream frame')

    const frame = encoded.buffer.slice(
      encoded.byteOffset,
      encoded.byteOffset + encoded.byteLength,
    ) as ArrayBuffer
    expect(decodeMessage(frame)).toEqual(chunk)
  })
})
