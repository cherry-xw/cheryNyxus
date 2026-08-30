/**
 * 流程测试 Tier 2：刷新重连 S8–S12（service+WS 级，真实断连/重连）。
 *
 * 规约见 [docs/flow-test.md](../../../docs/flow-test.md) §3.B。G1/G3/G8 验收主战场：
 * - S9 审批中断刷新续跑【原 approvalId】：chat.open 恢复持久 interaction，原 id 命中。
 *
 * 复用 serviceHarness（真实 startService）+ RpcClient（binary 帧解码 + reconnect）+ eventsAssert。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { deleteChat } from '@/db/chat.js'
import type {
  ChatCreateResponseData,
  InterruptNotificationData,
  AcceptNotificationData,
} from '@/service/message/types.js'
import {
  awaitInputAccepted,
  bootFlowService,
  connectClient,
  decideApproval,
  openChat,
  submitChatInput,
  type FlowService,
} from '../helpers/serviceHarness.js'
import {
  allEvents,
  accepts,
  waitForNotification,
} from '../helpers/eventsAssert.js'
import type { RpcClient } from '../../helpers/rpcClient.js'

describe('S9 审批中断刷新续跑原 approvalId', () => {
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

  it('detached approval 存活 → 重连用原 approvalId accept 命中 → 续跑 done', async () => {
    const createRes = await client.call('chat.create', {
      brain: 'mock_confirm',
      senseGroup: 'confirm_senses',
    })
    chatId = (createRes.data as ChatCreateResponseData).chatId

    const input = submitChatInput(client, chatId, '写文件')
    await awaitInputAccepted(client, input)
    const interruptN = await waitForNotification(() => input.events, 'interrupt')
    const originalApprovalId = (interruptN.data as InterruptNotificationData).approvalId
    expect(originalApprovalId).toBeTruthy()

    // 2. 断连：canonical run 已脱离 ACK 请求，approval 存活、generator 悬挂。
    client.close()

    // 3. 重连（复用 client：pending/events 保留，运行事件继续按原 requestId 归档）
    await client.reconnect()

    const opened = await openChat(client, chatId)
    expect(opened.state.run?.state).toBe('running')
    expect(opened.state.pendingApproval?.approvalId).toBe(originalApprovalId)

    // 6. 用【原 approvalId】accept：持久 interaction 与内存 approval 同源命中。
    const decision = await decideApproval(client, originalApprovalId, 'accept')
    expect(decision.interaction.status).toBe('completed')

    // 7. run 续跑 → accept + done 经 subscription 到新 ws，保留原 requestId
    await waitForNotification(() => input.events, 'accept')
    await waitForNotification(() => input.events, 'done')
    const acceptMatches = accepts(allEvents(input.events)).filter(
      (a) => (a.data as AcceptNotificationData).approvalId === originalApprovalId,
    )
    expect(acceptMatches.length).toBeGreaterThanOrEqual(1)
  }, 15000)
})
