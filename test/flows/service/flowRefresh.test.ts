/**
 * 流程测试 Tier 2：刷新重连 S8–S12（service+WS 级，真实断连/重连）。
 *
 * 规约见 [docs/flow-test.md](../../../docs/flow-test.md) §3.B。G1/G3/G8 验收主战场：
 * - S9 审批中断刷新续跑【原 approvalId】（G1 改造C 验收核心：grace 内 approval 存活，原 id 命中）。
 *
 * 复用 serviceHarness（真实 startService）+ RpcClient（binary 帧解码 + reconnect）+ eventsAssert。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { deleteChat } from '@/db/chat.js'
import type {
  ChatCreateResponseData,
  ChatAttachResponseData,
  InterruptNotificationData,
  AcceptNotificationData,
} from '@/service/message/types.js'
import { bootFlowService, connectClient, type FlowService } from '../helpers/serviceHarness.js'
import {
  allEvents,
  accepts,
  waitForNotification,
  waitFor,
  streamChunks,
  collectStreamContent,
  dones,
} from '../helpers/eventsAssert.js'
import type { RpcClient } from '../../helpers/rpcClient.js'

describe('S9 审批中断刷新续跑原 approvalId（G1 改造C 验收）', () => {
  let svc: FlowService
  let client: RpcClient
  let chatId: string

  beforeAll(async () => {
    svc = await bootFlowService()
    client = await connectClient(svc)
  })

  afterEach(async () => {
    if (chatId) {
      try {
        deleteChat(chatId)
      } catch {
        /* chat may already be gone */
      }
    }
  })

  afterAll(async () => {
    client.close()
    await svc.close()
  })

  it('grace 内 approval 存活 → 重连用原 approvalId accept 命中 → 续跑 done', async () => {
    const createRes = await client.call('chat.create', {
      brain: 'mock_confirm',
      senseGroup: 'confirm_senses',
    })
    chatId = (createRes.data as ChatCreateResponseData).chatId

    // 1. send 触发 write_file:confirm → interrupt；捕获【原 approvalId】（断连前）
    const send = client.request('chat.send', { chatId, prompt: '写文件' })
    const interruptN = await waitForNotification(() => send.events, 'interrupt')
    const originalApprovalId = (interruptN.data as InterruptNotificationData).approvalId
    expect(originalApprovalId).toBeTruthy()

    // 2. 断连（模拟 WS close）→ server 进 grace：approval 存活、generator 悬挂（未 park）
    client.close()

    // 3. 重连（复用 client：pending/events 保留，send.response 已 reject 但 events 续传）
    await client.reconnect()

    // 4. attach：running + 重定向输出 + currentState.pendingApproval = 原 approvalId
    const attachRes = await client.call('chat.attach', { chatId })
    const attachData = attachRes.data as ChatAttachResponseData
    expect(attachData.running).toBe(true)
    expect(attachData.attached).toBe(true)
    expect(attachData.currentState?.pendingApproval?.approvalId).toBe(originalApprovalId)

    // 5. sync 回放（补齐断连窗口；单一 hydration 水源）
    const syncRes = await client.call('chat.sync', { chatId, afterSeq: 0 })
    expect(syncRes.success).toBe(true)

    // 6. 用【原 approvalId】accept（G1 改造C 核心：approval 未被 park，原 id 命中）
    const approvalRes = await client.call('sense.approval', {
      approvalId: originalApprovalId,
      action: 'accept',
    })
    expect(approvalRes.success).toBe(true)

    // 7. run 续跑 → accept + done 经 liveOutput 到新 ws，归入 send.events（原 requestId）
    await waitForNotification(() => send.events, 'accept')
    await waitForNotification(() => send.events, 'done')
    const acceptMatches = accepts(allEvents(send.events)).filter(
      (a) => (a.data as AcceptNotificationData).approvalId === originalApprovalId,
    )
    expect(acceptMatches.length).toBeGreaterThanOrEqual(1)
  }, 15000)
})
