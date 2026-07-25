/**
 * 流程测试 Tier 2：停止后刷新仍 resume S13（service+WS 级，真实 startService）。
 *
 * 规约见 [docs/flow-test.md](../../../docs/flow-test.md) §3.C。本场景同时是 Tier 2 地基垂直切片——
 * 验证 bootFlowService + RpcClient(binary 帧解码) + eventsAssert 全链路打通。
 *
 * 流程：chat.create → chat.send(confirm 挂起审批) → chat.abort → chat.get(canResume=true)。
 * runId = chat.send 的 Request.id（types.ts：runId 等于启动该运行的 Request.id）。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { deleteChat } from '@/db/chat.js'
import type {
  ChatAbortResponseData,
  ChatGetResponseData,
  ChatCreateResponseData,
} from '@/service/message/types.js'
import { bootFlowService, connectClient, type FlowService } from '../helpers/serviceHarness.js'
import { allEvents, interrupts, waitForNotification } from '../helpers/eventsAssert.js'
import type { RpcClient } from '../../helpers/rpcClient.js'

describe('S13 停止后刷新仍 resume（Tier 2 地基垂直切片）', () => {
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

  it('chat.abort → paused；刷新 chat.get canResume=true', async () => {
    // 1. 创建 confirm 审批 chat
    const createRes = await client.call('chat.create', {
      brain: 'mock_confirm',
      senseGroup: 'confirm_senses',
    })
    expect(createRes.success).toBe(true)
    chatId = (createRes.data as ChatCreateResponseData).chatId

    // 2. send 触发 write_file:confirm → interrupt（不 await 终态，run 挂在审批）
    const send = client.request('chat.send', { chatId, prompt: '写文件' })
    await waitForNotification(() => send.events, 'interrupt')
    expect(interrupts(allEvents(send.events)).length).toBeGreaterThanOrEqual(1)

    // 3. abort 活跃 run（无条件，免 runId CONFLICT）
    const abortRes = await client.call('chat.abort', { chatId })
    expect(abortRes.success).toBe(true)
    expect((abortRes.data as ChatAbortResponseData).aborted).toBe(true)

    // 4. send 终态：handleChatAbort 走 approvalManager.abort（rejectApproval(AgentAbortError)）
    //    可靠中断 approval.wait → generator 结束 → finally 投递终态；统一暂停语义 success:true。
    const sendFinal = await client.awaitResponse(send)
    expect(sendFinal.success).toBe(true)

    // 5. 刷新：chat.get canResume=true（abort 归 paused，末条为 sense）
    const getRes = await client.call('chat.get', { chatId })
    expect(getRes.success).toBe(true)
    expect((getRes.data as ChatGetResponseData).canResume).toBe(true)
  }, 15000)
})
