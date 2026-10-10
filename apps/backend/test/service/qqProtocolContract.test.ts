import { describe, expect, it } from 'vitest'
import {
  QQCapabilities,
  QQDeliveryResultRequestSchema,
  QQEventSubmitRequestSchema,
  QQHelloResponseSchema,
  QQIdentityBindResponseSchema,
  QQNotificationSchema,
  QQRecoverResponseSchema,
} from '../../../../packages/protocol/src/qq.js'

const outputIdentity = {
  eventId: 'output-1',
  requestId: 'request-1',
  selfId: '123',
  conversationType: 'private' as const,
  targetId: '789',
  seq: 1,
}

describe('QQ shared transport contract', () => {
  it('accepts the complete handshake, binding, and recovery responses', () => {
    expect(
      QQHelloResponseSchema.parse({
        protocolVersion: 1,
        backendVersion: '1.0.0',
        selfId: '123',
        authenticated: true,
        capabilities: [...QQCapabilities],
      }),
    ).toMatchObject({ selfId: '123', authenticated: true })
    expect(
      QQIdentityBindResponseSchema.parse({
        bound: true,
        selfId: '123',
        sourceType: 'napcat-action',
        validation: 'accepted',
      }),
    ).toMatchObject({ bound: true, selfId: '123' })
    expect(
      QQRecoverResponseSchema.parse({
        events: [
          QQNotificationSchema.parse({
            kind: 'notification',
            type: 'qq.message.ack',
            data: { ...outputIdentity, text: '收到', state: 'queued' },
          }),
        ],
      }).events,
    ).toHaveLength(1)
  })

  it('rejects forged identity, invalid event targets, and malformed delivery results', () => {
    expect(() =>
      QQEventSubmitRequestSchema.parse({
        eventId: 'qq:123:private:789:1',
        selfId: '123',
        conversationType: 'private',
        targetId: '789',
        senderId: '123',
        senderName: 'self',
        messageId: '1',
        content: 'loopback',
        mentionedBot: false,
        occurredAt: 1,
      }),
    ).toThrow()
    expect(() =>
      QQNotificationSchema.parse({
        kind: 'notification',
        type: 'qq.reply.part',
        data: { ...outputIdentity, partIndex: 2 },
      }),
    ).not.toThrow()
    expect(() =>
      QQDeliveryResultRequestSchema.parse({
        ...outputIdentity,
        status: 'sent',
        messageIds: [],
        activity: true,
        terminal: true,
      }),
    ).not.toThrow()
    expect(() =>
      QQDeliveryResultRequestSchema.parse({
        ...outputIdentity,
        status: 'unknown',
        messageIds: [],
        sentAt: 1,
        activity: false,
        terminal: false,
        extra: 'must be rejected',
      }),
    ).toThrow()
  })
})
