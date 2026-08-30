/**
 * 流程测试 Tier 2：canonical detached 审批到达硬期限后释放 S10（service+WS 级）。
 *
 * chat.input.submit 在 ACK 后与传输请求脱钩，WS disconnectGrace 不再拥有该 run；无限审批由
 * approval_hard_timeout 作为资源上限，超限抛 AgentParkError → run paused → canResume=true。
 * 传输请求层的 grace 到期 park 由 disconnectGrace.test.ts 单元覆盖。
 *
 * 用真实短 hard deadline，免 fake timers 与异步 WS/runner 链路耦合。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { deleteChat } from '@/db/chat.js'
import { isChatRunning } from '@/service/chat/runtime.js'
import type {
  ChatCreateResponseData,
  ChatListResponseData,
  InterruptNotificationData,
} from '@/service/message/types.js'
import {
  awaitInputAccepted,
  bootFlowService,
  connectClient,
  openChat,
  submitChatInput,
  type FlowService,
} from '../helpers/serviceHarness.js'
import { waitFor, waitForNotification } from '../helpers/eventsAssert.js'
import type { RpcClient } from '../../helpers/rpcClient.js'

describe('S10 canonical detached 审批硬期限 → park → canResume', () => {
  let svc: FlowService
  let client: RpcClient
  let chatId: string

  beforeAll(async () => {
    svc = await bootFlowService({ approvalTimeoutMs: 0, approvalHardTimeoutMs: 400 })
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

  it('挂起审批 → 断连 → 超硬期限 park(paused) → 重连 catalog canResume / open idle', async () => {
    const createRes = await client.call('chat.create', {
      brain: 'mock_confirm',
      senseGroup: 'confirm_senses',
    })
    chatId = (createRes.data as ChatCreateResponseData).chatId

    const input = submitChatInput(client, chatId, '写文件')
    await awaitInputAccepted(client, input)
    const interruptN = await waitForNotification(() => input.events, 'interrupt')
    const approvalId = (interruptN.data as InterruptNotificationData).approvalId
    expect(approvalId).toBeTruthy()
    expect(isChatRunning(chatId)).toBe(true)

    // 2. canonical run 已脱离 ACK 请求；断连不改变审批的 chat 域生命周期。
    client.close()

    // 3. 等待 hard deadline 后 park 链路完整落地：reject approval.wait → observer paused → DB。
    await waitFor(
      () => [],
      () => (!isChatRunning(chatId) ? true : undefined),
      5000,
    )

    // 4. 重连（复用 client：pending/events 保留）
    await client.reconnect()

    const catalog = await client.call('chat.list', { scope: 'history' })
    expect(catalog.success).toBe(true)
    const summary = (catalog.data as ChatListResponseData).chats.find(
      (entry) => entry.chatId === chatId,
    )
    expect(summary?.canResume).toBe(true)

    const opened = await openChat(client, chatId)
    expect(opened.state.run).toBeUndefined()
    expect(opened.state.activeTurns).toEqual([])
  }, 15000)
})
