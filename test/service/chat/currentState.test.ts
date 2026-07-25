/**
 * computeCurrentState 单元测试（G8 刷新当前态快照）。
 * 直操 DB（createChat + appendChatEvent）+ approvalManager 内存态，验证：
 * - currentTodo = 最近 update_todo 的结构化 todos
 * - pendingApproval 仅当 approvalManager 存活时返回
 * - runningTools 在 run 未运行时为空
 * - accept/rejected 事件清除 pending 跟踪
 */
import { randomUUID } from 'crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createChat, deleteChat } from '@/db/chat.js'
import { appendChatEvent } from '@/db/delivery.js'
import { approvalManager } from '@/service/approval/manager.js'
import { computeCurrentState } from '@/service/chat/currentState.js'

const cleanup: string[] = []
afterEach(() => {
  for (const id of cleanup.splice(0).reverse()) deleteChat(id)
})

describe('computeCurrentState（G8）', () => {
  it('currentTodo = 最近 update_todo 的结构化 todos', () => {
    const chatId = randomUUID()
    cleanup.push(chatId)
    createChat(chatId)
    appendChatEvent(chatId, {
      kind: 'chunk',
      type: 'staged',
      data: {
        type: 'sense_end',
        senseName: 'update_todo',
        arguments: JSON.stringify({ todos: [{ content: 'a', status: 'pending' }] }),
        id: 't1',
      },
      chatId,
    })
    const cs = computeCurrentState(chatId)
    expect(cs.currentTodo).toEqual([{ content: 'a', status: 'pending' }])
  })

  it('pendingApproval：approvalManager 存活时返回，否则 undefined', () => {
    const chatId = randomUUID()
    cleanup.push(chatId)
    createChat(chatId)
    appendChatEvent(chatId, {
      kind: 'notification',
      type: 'interrupt',
      data: {
        approvalId: 'ap1',
        senseName: 'write_file',
        arguments: '{}',
        supervisionLevel: 1,
        waitTime: 30000,
        createdAt: 1000,
      },
      chatId,
    })
    // 未注册（不存活）→ undefined
    expect(computeCurrentState(chatId).pendingApproval).toBeUndefined()
    // 注册（存活）→ 返回
    approvalManager.register('ap1')
    const cs = computeCurrentState(chatId)
    expect(cs.pendingApproval?.approvalId).toBe('ap1')
    expect(cs.pendingApproval?.senseName).toBe('write_file')
    expect(cs.pendingApproval?.waitTime).toBe(30000)
    approvalManager.confirm('ap1', 'accept') // 清理单例态
  })

  it('runningTools：run 未运行时为空（即便有未决 sense_end）', () => {
    const chatId = randomUUID()
    cleanup.push(chatId)
    createChat(chatId)
    appendChatEvent(chatId, {
      kind: 'chunk',
      type: 'staged',
      data: { type: 'sense_end', senseName: 'read_file', arguments: '{}', id: 'r1' },
      chatId,
    })
    const cs = computeCurrentState(chatId)
    expect(cs.runningTools).toEqual([])
  })

  it('accept 事件清除 pendingApproval 跟踪（即便 approvalManager 仍存活）', () => {
    const chatId = randomUUID()
    cleanup.push(chatId)
    createChat(chatId)
    appendChatEvent(chatId, {
      kind: 'notification',
      type: 'interrupt',
      data: { approvalId: 'ap2', senseName: 'write_file', arguments: '{}', supervisionLevel: 1, waitTime: 0, createdAt: 0 },
      chatId,
    })
    appendChatEvent(chatId, {
      kind: 'notification',
      type: 'accept',
      data: { approvalId: 'ap2', senseName: 'write_file', result: 'ok' },
      chatId,
    })
    approvalManager.register('ap2') // 模拟残留存活，但事件已决
    try {
      expect(computeCurrentState(chatId).pendingApproval).toBeUndefined()
    } finally {
      approvalManager.confirm('ap2', 'accept') // 清理
    }
  })
})
