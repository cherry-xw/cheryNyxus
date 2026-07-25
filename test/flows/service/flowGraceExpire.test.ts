/**
 * 流程测试 Tier 2：审批中断超 grace 释放 S10（service+WS 级）。
 *
 * 规约见 [docs/flow-test.md](../../../docs/flow-test.md) §3.B S10 / FP-C3。G1 改造C 的「到期才 park」半边：
 * 审批挂起 → 断连 → grace 内 approval 存活（S9 已验）；**超 grace** → expireRun → parkApproval(AgentParkError)
 * → run paused → canResume=true。与 [disconnectGrace.test.ts](../../service/websocket/disconnectGrace.test.ts)
 * 单元（到期 parkApproval）互补：此处真实 timer + 完整 send/observer 链端到端。
 *
 * 用真实短 grace（disconnectGraceMs=400）+ 真实 sleep，免 fake timers 与异步 ws/grace 链路耦合。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { deleteChat } from '@/db/chat.js'
import type {
  ChatCreateResponseData,
  ChatGetResponseData,
  ChatAttachResponseData,
  InterruptNotificationData,
} from '@/service/message/types.js'
import { bootFlowService, connectClient, type FlowService } from '../helpers/serviceHarness.js'
import { waitForNotification } from '../helpers/eventsAssert.js'
import type { RpcClient } from '../../helpers/rpcClient.js'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('S10 审批中断超 grace 释放 → park → canResume（G1 到期半边）', () => {
  let svc: FlowService
  let client: RpcClient
  let chatId: string

  beforeAll(async () => {
    // 短 grace：400ms。startService 前注入 config.global.disconnect_grace_ms（全进程）。
    svc = await bootFlowService({ disconnectGraceMs: 400 })
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

  it('挂起审批 → 断连超 grace → park(paused) → 重连 chat.get canResume=true / attach running=false', async () => {
    const createRes = await client.call('chat.create', {
      brain: 'mock_confirm',
      senseGroup: 'confirm_senses',
    })
    chatId = (createRes.data as ChatCreateResponseData).chatId

    // 1. send 触发 write_file:confirm → interrupt（run 挂在审批）
    const send = client.request('chat.send', { chatId, prompt: '写文件' })
    const interruptN = await waitForNotification(() => send.events, 'interrupt')
    const approvalId = (interruptN.data as InterruptNotificationData).approvalId
    expect(approvalId).toBeTruthy()

    // 2. 断连 → grace 启动（400ms）；approval 仍存活、generator 悬挂
    client.close()

    // 3. 超 grace（400 + buffer 让 park 链路落地：reject approval.wait → generator finally → observer paused → DB）
    await sleep(400 + 350)

    // 4. 重连（复用 client：pending/events 保留）
    await client.reconnect()

    // 5. chat.get canResume=true（park 归 paused，末条为 sense → 可续）；非 ended（无 finished）
    const getRes = await client.call('chat.get', { chatId })
    expect(getRes.success).toBe(true)
    expect((getRes.data as ChatGetResponseData).canResume).toBe(true)

    // 6. attach running=false（run 已 park 结束，无实时流可重连）
    const attachRes = await client.call('chat.attach', { chatId })
    expect((attachRes.data as ChatAttachResponseData).running).toBe(false)
  }, 15000)
})
