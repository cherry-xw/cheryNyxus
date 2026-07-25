/**
 * disconnectGrace 断连宽限测试（G1 改造C 验收）。
 *
 * G1 核心语义：WS 断连不立即 park 挂起审批——宽限期内 approval 存活（重连可用原 approvalId 审批续跑），
 * 到期 disconnectGrace.expireRun 才 parkApproval。connection.close() 不再立即 park（改由 grace 接管）。
 *
 * 本测试在 disconnectGrace + approvalManager + approvalRegistry 层验证：
 * - onConnectionClosed 启动 grace，approval 仍存活（未被 park）
 * - 宽限期到期才 parkApproval → approval 归 paused（AgentParkError）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { WebSocket } from 'ws'
import { disconnectGrace } from '@/service/websocket/disconnectGrace.js'
import { approvalManager } from '@/service/approval/manager.js'
import { createApproval } from '@/core/sense/index.js'
import { AgentParkError } from '@/core/middleware/errors.js'

describe('disconnectGrace 宽限 deferred-park（G1 改造C）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    disconnectGrace.configure({
      requestParkAfterTurn: vi.fn(),
      parkApproval: (id: string) => approvalManager.park(id),
    })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('断连后宽限期内 approval 仍存活（未被立即 park）', () => {
    const requestId = 'req-g1-1'
    const approvalId = 'ap-g1-1'
    approvalManager.register(approvalId)
    disconnectGrace.track({
      requestId,
      chatId: 'c1',
      runId: requestId,
      connectionId: 'conn1',
      outputWs: {} as WebSocket,
    })
    disconnectGrace.setPendingApproval(requestId, approvalId)

    // 断连 → grace 启动
    disconnectGrace.onConnectionClosed('conn1')

    // 宽限期内（未到期）→ approval 仍存活
    vi.advanceTimersByTime(5000)
    expect(approvalManager.has(approvalId)).toBe(true)

    // 清理
    disconnectGrace.onRequestFinished(requestId)
    approvalManager.confirm(approvalId, 'accept')
  })

  it('宽限期到期 → parkApproval，approval 归 paused（AgentParkError）', async () => {
    const requestId = 'req-g1-2'
    const approvalId = 'ap-g1-2'
    const approvalPromise = createApproval(approvalId, 0, 0) // 不限时、无 hard（测试手动控制）
    approvalManager.register(approvalId)
    disconnectGrace.track({
      requestId,
      chatId: 'c2',
      runId: requestId,
      connectionId: 'conn2',
      outputWs: {} as WebSocket,
    })
    disconnectGrace.setPendingApproval(requestId, approvalId)

    disconnectGrace.onConnectionClosed('conn2')
    // 到期（默认 grace 15000ms）
    vi.advanceTimersByTime(16000)

    // approval 已被 park → 不存活 + promise reject AgentParkError
    expect(approvalManager.has(approvalId)).toBe(false)
    await expect(approvalPromise).rejects.toBeInstanceOf(AgentParkError)

    disconnectGrace.onRequestFinished(requestId)
  })

  it('宽限期内 rebind（重连）→ 取消 grace，approval 继续存活', () => {
    const requestId = 'req-g1-3'
    const approvalId = 'ap-g1-3'
    approvalManager.register(approvalId)
    disconnectGrace.track({
      requestId,
      chatId: 'c3',
      runId: requestId,
      connectionId: 'conn3',
      outputWs: {} as WebSocket,
    })
    disconnectGrace.setPendingApproval(requestId, approvalId)

    disconnectGrace.onConnectionClosed('conn3')
    // 宽限期内重连（rebind 到新连接）
    disconnectGrace.rebind({ requestId, connectionId: 'conn3-new', outputWs: {} as WebSocket })

    // 推进超过原 grace 时间 → 不应 park（grace 已取消）
    vi.advanceTimersByTime(20000)
    expect(approvalManager.has(approvalId)).toBe(true)

    disconnectGrace.onRequestFinished(requestId)
    approvalManager.confirm(approvalId, 'accept')
  })
})
