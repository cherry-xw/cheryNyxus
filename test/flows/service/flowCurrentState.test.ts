/**
 * 流程测试 Tier 2：刷新 currentState 快照 S12（G8 验收点，service+WS 级）。
 *
 * 规约见 [docs/flow-test.md](../../../docs/flow-test.md) §3.B S12。currentState 在 chat.get/chat.attach/chat.sync
 * response 携带，权威给出 pendingApproval / runningTools / currentTodo（不含 currentTurnContent，避双内容源）。
 *
 * 端到端补单元（[currentState.test.ts](../../service/chat/currentState.test.ts)）未覆盖的 WS 链路：
 * - currentTodo：真实 send 链产生 update_todo → ended 态 chat.get 快照 = 结构化 todos。
 * - runningTools：confirm 审批挂起（run running + interrupt 未决）→ chat.attach 快照含该工具 id。
 *   pendingApproval 同源 approvalId（与 S9 断连重连场景互补：此处同连接直接 attach 验）。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { deleteChat } from '@/db/chat.js'
import type {
  ChatCreateResponseData,
  ChatGetResponseData,
  ChatAttachResponseData,
  CurrentStateData,
  InterruptNotificationData,
} from '@/service/message/types.js'
import { bootFlowService, connectClient, type FlowService } from '../helpers/serviceHarness.js'
import { allEvents, interrupts, waitForNotification } from '../helpers/eventsAssert.js'
import type { RpcClient } from '../../helpers/rpcClient.js'

describe('S12 刷新 currentState 快照（G8 端到端）', () => {
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

  it('currentTodo：update_todo 跑完 → chat.get 快照 = 结构化 todos', async () => {
    const createRes = await client.call('chat.create', {
      brain: 'mock_todo',
      senseGroup: 'todo_senses',
    })
    chatId = (createRes.data as ChatCreateResponseData).chatId

    // send 跑完（update_todo:auto 自动执行，末条 assistant 无 senseCalls → ended）
    const send = client.request('chat.send', { chatId, prompt: '规划任务' })
    await waitForNotification(() => send.events, 'done')

    // chat.get 流式回历史 + return 携带 currentState；currentTodo = 最近 update_todo 的 args.todos
    const getHandle = client.request('chat.get', { chatId })
    const getRes = await client.awaitResponse(getHandle)
    expect(getRes.success).toBe(true)
    const cs = (getRes.data as ChatGetResponseData).currentState as CurrentStateData | undefined
    expect(cs?.currentTodo).toEqual([
      { content: '分析需求', status: 'completed' },
      { content: '实现功能', status: 'in_progress', activeForm: '编码中' },
      { content: '编写测试', status: 'pending' },
    ])
  }, 15000)

  it('runningTools + pendingApproval：审批挂起 → attach 快照含未决工具 + 同源 approvalId', async () => {
    const createRes = await client.call('chat.create', {
      brain: 'mock_confirm',
      senseGroup: 'confirm_senses',
    })
    chatId = (createRes.data as ChatCreateResponseData).chatId

    // send 触发 write_file:confirm → interrupt（run 挂在审批，isChatRunning=true）
    const send = client.request('chat.send', { chatId, prompt: '写文件' })
    const interruptN = await waitForNotification(() => send.events, 'interrupt')
    const approvalId = (interruptN.data as InterruptNotificationData).approvalId

    // 同连接 attach（run running）→ 重定向输出 + currentState 快照
    const attachRes = await client.call('chat.attach', { chatId })
    const attachData = attachRes.data as ChatAttachResponseData
    expect(attachData.running).toBe(true)
    expect(attachData.attached).toBe(true)
    const cs = attachData.currentState as CurrentStateData | undefined

    // runningTools 含未决 write_file（id = interrupt approvalId，同源）
    const tool = cs?.runningTools.find((t) => t.id === approvalId)
    expect(tool?.senseName).toBe('write_file')
    // pendingApproval 同源 approvalId（approvalManager 内存存活）
    expect(cs?.pendingApproval?.approvalId).toBe(approvalId)
    expect(cs?.pendingApproval?.senseName).toBe('write_file')

    // 清理：abort 挂起 run（统一暂停语义），免 afterAll 悬挂
    await client.call('chat.abort', { chatId })
    // 断言用到 interrupts 仅确认中断态确实到达（防回归）
    expect(interrupts(allEvents(send.events)).length).toBeGreaterThanOrEqual(1)
  }, 15000)
})
