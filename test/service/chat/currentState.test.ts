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
import { computeCurrentState, limitExecutionSteps } from '@/service/chat/currentState.js'

const cleanup: string[] = []
afterEach(() => {
  for (const id of cleanup.splice(0).reverse()) deleteChat(id)
})

describe('computeCurrentState（G8）', () => {
  it('executionStepLimit 严格限制活动步骤并保留最新 running', () => {
    const steps = Array.from({ length: 5 }, (_, index) => ({
      id: `running-${index}`,
      runId: 'run-limit',
      chatId: 'chat-limit',
      kind: 'tool' as const,
      name: `tool-${index}`,
      status: 'running' as const,
      startedAt: index + 1,
    }))

    expect(limitExecutionSteps(steps, 3).map((step) => step.id)).toEqual([
      'running-2',
      'running-3',
      'running-4',
    ])
  })

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
      data: {
        approvalId: 'ap2',
        senseName: 'write_file',
        arguments: '{}',
        supervisionLevel: 1,
        waitTime: 0,
        createdAt: 0,
      },
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

  it('从持久事件重建模型/工具计时、拒绝零耗时与活动步骤', () => {
    const chatId = randomUUID()
    cleanup.push(chatId)
    createChat(chatId)
    const runId = 'run-timing'
    const append = (type: string, data: Record<string, unknown>) =>
      appendChatEvent(chatId, { kind: 'notification', type, data, chatId, runId })

    append('run.updated', { runId, status: 'running', at: 100, startedAt: 100 })
    append('turn.started', {
      turnId: 'turn-1',
      messageId: 'turn-1',
      runId,
      createdAt: 110,
    })
    append('turn.completed', { turnId: 'turn-1', messageId: 'turn-1', completedAt: 120 })
    append('sense_started', {
      id: 'tool-1',
      senseName: 'read_file',
      arguments: '{}',
      startedAt: 130,
    })
    append('accept', {
      approvalId: 'tool-1',
      senseName: 'read_file',
      result: 'ok',
      completedAt: 150,
    })
    append('rejected', {
      approvalId: 'tool-rejected',
      senseName: 'write_file',
      reason: '用户拒绝',
      completedAt: 160,
    })
    append('sense_started', {
      id: 'tool-running',
      senseName: 'execute_command',
      arguments: '{}',
      startedAt: 170,
    })

    expect(computeCurrentState(chatId).executionSteps).toEqual([
      {
        id: 'turn-1',
        runId,
        chatId,
        kind: 'model',
        name: '模型响应',
        status: 'completed',
        startedAt: 110,
        completedAt: 120,
      },
      {
        id: 'tool-1',
        runId,
        chatId,
        kind: 'tool',
        name: 'read_file',
        status: 'completed',
        startedAt: 130,
        completedAt: 150,
      },
      {
        id: 'tool-rejected',
        runId,
        chatId,
        kind: 'tool',
        name: 'write_file',
        status: 'rejected',
        startedAt: 160,
        completedAt: 160,
      },
      {
        id: 'tool-running',
        runId,
        chatId,
        kind: 'tool',
        name: 'execute_command',
        status: 'running',
        startedAt: 170,
      },
    ])

    // 数量预算优先保留活动步骤，再取最新终态；审批等待不计入工具耗时。
    expect(computeCurrentState(chatId, { executionStepLimit: 2 }).executionSteps).toEqual([
      expect.objectContaining({
        id: 'tool-rejected',
        status: 'rejected',
        startedAt: 160,
        completedAt: 160,
      }),
      expect.objectContaining({ id: 'tool-running', status: 'running' }),
    ])
  })

  it('run 终态为未封口步骤补 cancelled/failed 与完成时间', () => {
    const cancelledChatId = randomUUID()
    cleanup.push(cancelledChatId)
    createChat(cancelledChatId)
    appendChatEvent(cancelledChatId, {
      kind: 'notification',
      type: 'run.updated',
      data: { runId: 'cancel-run', status: 'running', at: 1, startedAt: 1 },
      chatId: cancelledChatId,
      runId: 'cancel-run',
    })
    appendChatEvent(cancelledChatId, {
      kind: 'notification',
      type: 'sense_started',
      data: { id: 'cancel-tool', senseName: 'bash', arguments: '{}', startedAt: 2 },
      chatId: cancelledChatId,
      runId: 'cancel-run',
    })
    appendChatEvent(cancelledChatId, {
      kind: 'notification',
      type: 'run.updated',
      data: { runId: 'cancel-run', status: 'paused', at: 9 },
      chatId: cancelledChatId,
      runId: 'cancel-run',
    })
    expect(computeCurrentState(cancelledChatId).executionSteps[0]).toMatchObject({
      id: 'cancel-tool',
      status: 'cancelled',
      completedAt: 9,
    })

    const failedChatId = randomUUID()
    cleanup.push(failedChatId)
    createChat(failedChatId)
    const failedEvents = [
      ['run.updated', { runId: 'failed-run', status: 'running', at: 10, startedAt: 10 }],
      [
        'turn.started',
        { turnId: 'failed-turn', messageId: 'failed-turn', runId: 'failed-run', createdAt: 11 },
      ],
      ['error', { message: 'boom' }],
      ['run.updated', { runId: 'failed-run', status: 'paused', at: 19 }],
      ['turn.completed', { turnId: 'failed-turn', messageId: 'failed-turn', completedAt: 20 }],
    ] as const
    for (const [type, data] of failedEvents) {
      appendChatEvent(failedChatId, {
        kind: 'notification',
        type,
        data,
        chatId: failedChatId,
        runId: 'failed-run',
      })
    }
    expect(computeCurrentState(failedChatId).executionSteps[0]).toMatchObject({
      id: 'failed-turn',
      status: 'failed',
      completedAt: 19,
    })
  })
})
