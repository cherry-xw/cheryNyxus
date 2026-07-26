import { describe, expect, it } from 'vitest'
import type { WebSocket } from 'ws'
import { ConnectionManager } from '@/service/websocket/connection.js'

function socket(readyState: number): WebSocket {
  return { OPEN: 1, readyState } as WebSocket
}

describe('ConnectionManager chat subscriptions', () => {
  it('lets a refreshed connection reclaim a stale owner before its close handler runs', () => {
    const manager = new ConnectionManager()
    const old = socket(3) // CLOSED, but intentionally not manager.close() yet
    const next = socket(1)
    const oldState = manager.create(old)
    const nextState = manager.create(next)

    manager.bindChatConnection('chat-1', oldState.id)
    expect(() => manager.bindChatConnection('chat-1', nextState.id)).not.toThrow()
    expect(manager.findWsByChatId('chat-1')).toBe(next)
  })

  it('keeps two open connections subscribed to the same chat', () => {
    const manager = new ConnectionManager()
    const owner = socket(1)
    const contender = socket(1)
    const ownerState = manager.create(owner)
    const contenderState = manager.create(contender)

    manager.bindChatConnection('chat-2', ownerState.id)
    expect(() => manager.bindChatConnection('chat-2', contenderState.id)).not.toThrow()
    expect(manager.getChatOutputs('chat-2')).toEqual(expect.arrayContaining([owner, contender]))
  })

  it('removes only the closed connection from a chat subscription', async () => {
    const manager = new ConnectionManager()
    const first = socket(1)
    const second = socket(1)
    const firstState = manager.create(first)
    const secondState = manager.create(second)
    manager.bindChatConnection('chat-3', firstState.id)
    manager.bindChatConnection('chat-3', secondState.id)

    await manager.close(first)
    expect(manager.getChatOutputs('chat-3')).toEqual([second])
  })
})
