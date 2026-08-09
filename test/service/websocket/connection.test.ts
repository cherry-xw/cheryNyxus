import { describe, expect, it } from 'vitest'
import type { WebSocket } from 'ws'
import { ConnectionManager } from '@/service/websocket/connection.js'

function socket(readyState: number): WebSocket {
  return { OPEN: 1, readyState } as WebSocket
}

describe('ConnectionManager chat subscriptions', () => {
  it('routes one root envelope when a direct subscription was opened first', () => {
    const manager = new ConnectionManager()
    const ws = socket(1)
    const state = manager.create(ws)
    const directId = manager.beginSessionOpen('root-live', state.id)
    manager.setSessionBoundary(directId, 0)
    manager.finishSessionOpen(directId)
    const rootId = manager.beginRootSessionOpen('root-live', state.id)
    manager.setSessionBoundary(rootId, 0)
    manager.finishSessionOpen(rootId)

    const routed = manager.prepareSessionEvent(ws, {
      kind: 'notification',
      type: 'timeline.patch',
      chatId: 'root-live',
      rootChatId: 'root-live',
      seq: 1,
      rootEventSeq: 1,
    })

    expect(routed).toEqual([
      expect.objectContaining({
        subscriptionId: rootId,
        eventSeq: 1,
        sourceEventSeq: 1,
      }),
    ])
  })

  it('keeps the authoritative root subscription when a direct session opens later', () => {
    const manager = new ConnectionManager()
    const ws = socket(1)
    const state = manager.create(ws)
    const rootId = manager.beginRootSessionOpen('root-live', state.id)
    manager.setSessionBoundary(rootId, 0)
    manager.finishSessionOpen(rootId)

    const directId = manager.beginSessionOpen('root-live', state.id)
    manager.setSessionBoundary(directId, 0)
    manager.finishSessionOpen(directId)

    expect(manager.getSessionSubscription(rootId)).toMatchObject({ rootChatId: 'root-live' })
    expect(manager.getSessionSubscription(directId)).toMatchObject({ chatId: 'root-live' })
    expect(
      manager.prepareSessionEvent(ws, {
        kind: 'notification',
        type: 'input.updated',
        chatId: 'root-live',
        rootChatId: 'root-live',
        seq: 1,
        rootEventSeq: 1,
      }),
    ).toEqual([expect.objectContaining({ subscriptionId: rootId, eventSeq: 1 })])
  })

  it('releases only root events above the captured snapshot fence', () => {
    const manager = new ConnectionManager()
    const ws = socket(1)
    const state = manager.create(ws)
    const subscriptionId = manager.beginRootSessionOpen('root-1', state.id)

    expect(
      manager.prepareSessionEvent(ws, {
        kind: 'notification',
        type: 'before-fence',
        chatId: 'root-1',
        rootChatId: 'root-1',
        seq: 1,
        rootEventSeq: 1,
      }),
    ).toEqual([])
    manager.setSessionBoundary(subscriptionId, 1)
    expect(
      manager.prepareSessionEvent(ws, {
        kind: 'notification',
        type: 'after-fence',
        chatId: 'child-1',
        rootChatId: 'root-1',
        seq: 1,
        rootEventSeq: 2,
      }),
    ).toEqual([])

    manager.finishSessionOpen(subscriptionId)
    expect(manager.drainSessionBuffer(subscriptionId)).toEqual([
      expect.objectContaining({ type: 'after-fence', rootEventSeq: 2 }),
    ])
  })

  it('releases the first root event when an empty snapshot captured boundary 0', () => {
    const manager = new ConnectionManager()
    const ws = socket(1)
    const state = manager.create(ws)
    const subscriptionId = manager.beginRootSessionOpen('empty-root', state.id)
    manager.setSessionBoundary(subscriptionId, 0)

    expect(
      manager.prepareSessionEvent(ws, {
        kind: 'notification',
        type: 'turn.started',
        chatId: 'empty-root',
        rootChatId: 'empty-root',
        seq: 1,
        rootEventSeq: 1,
      }),
    ).toEqual([])

    manager.finishSessionOpen(subscriptionId)
    expect(manager.drainSessionBuffer(subscriptionId)).toEqual([
      expect.objectContaining({ type: 'turn.started', rootEventSeq: 1 }),
    ])
  })

  it('replaces the previous root subscription on the same connection', () => {
    const manager = new ConnectionManager()
    const ws = socket(1)
    const state = manager.create(ws)
    const first = manager.beginRootSessionOpen('root-2', state.id)
    const second = manager.beginRootSessionOpen('root-2', state.id)

    expect(manager.getSessionSubscription(first)).toBeUndefined()
    expect(manager.getSessionSubscription(second)).toMatchObject({ rootChatId: 'root-2' })
  })

  it('stops routing a switched-away root without terminating its runtime', () => {
    const manager = new ConnectionManager()
    const ws = socket(1)
    const state = manager.create(ws)
    const oldRoot = manager.beginRootSessionOpen('root-old', state.id)
    manager.setSessionBoundary(oldRoot, 0)
    manager.finishSessionOpen(oldRoot)

    expect(manager.closeSession(oldRoot)).toMatchObject({ rootChatId: 'root-old' })
    expect(
      manager.prepareSessionEvent(ws, {
        kind: 'notification',
        type: 'turn.delta',
        chatId: 'root-old',
        rootChatId: 'root-old',
        seq: 1,
        rootEventSeq: 1,
      }),
    ).toEqual([])

    const nextRoot = manager.beginRootSessionOpen('root-next', state.id)
    manager.setSessionBoundary(nextRoot, 0)
    manager.finishSessionOpen(nextRoot)
    expect(
      manager.prepareSessionEvent(ws, {
        kind: 'notification',
        type: 'turn.delta',
        chatId: 'root-next',
        rootChatId: 'root-next',
        seq: 1,
        rootEventSeq: 1,
      }),
    ).toEqual([expect.objectContaining({ subscriptionId: nextRoot, eventSeq: 1 })])
  })

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
