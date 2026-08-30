/**
 * 流程测试 Tier 2：刷新 currentState 快照 S12（G8 验收点，service+WS 级）。
 *
 * 规约见 [docs/flow-test.md](../../../docs/flow-test.md) §3.B S12。canonical chat.open state
 * 权威给出 pendingApproval / runningTools；已完成的 todo 从
 * chat.timeline.get 的 update_todo sense call 恢复（不引入第二套 currentTurnContent 水源）。
 *
 * 端到端补单元（[currentState.test.ts](../../service/chat/currentState.test.ts)）未覆盖的 WS 链路：
 * - currentTodo：真实 input 链产生 update_todo → canonical timeline 保留结构化参数。
 * - runningTools：confirm 审批挂起（run running + interrupt 未决）→ chat.open 快照含该工具 id。
 *   pendingApproval 同源 approvalId（与 S9 断连重连场景互补：此处同连接直接 open 验）。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { deleteChat } from '@/db/chat.js'
import type {
  ChatCreateResponseData,
  InterruptNotificationData,
} from '@/service/message/types.js'
import {
  awaitInputAccepted,
  bootFlowService,
  connectClient,
  getChatTimeline,
  openChat,
  submitChatInput,
  type FlowService,
} from '../helpers/serviceHarness.js'
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

  it('currentTodo：update_todo 跑完 → canonical timeline 保留结构化 todos', async () => {
    const createRes = await client.call('chat.create', {
      brain: 'mock_todo',
      senseGroup: 'todo_senses',
    })
    chatId = (createRes.data as ChatCreateResponseData).chatId

    const input = submitChatInput(client, chatId, '规划任务')
    await awaitInputAccepted(client, input)
    await waitForNotification(() => input.events, 'done')

    const timeline = await getChatTimeline(client, chatId)
    const todoCall = timeline.messages
      ?.flatMap((message) => message.senseCalls ?? [])
      .find((call) => call.name === 'update_todo')
    expect(todoCall?.status).toBe('accepted')
    expect(JSON.parse(todoCall!.arguments).todos).toEqual([
      { content: '分析需求', status: 'completed' },
      { content: '实现功能', status: 'in_progress', activeForm: '编码中' },
      { content: '编写测试', status: 'pending' },
    ])
  }, 15000)

  it('runningTools + pendingApproval：审批挂起 → open 快照含未决工具 + 同源 approvalId', async () => {
    const createRes = await client.call('chat.create', {
      brain: 'mock_confirm',
      senseGroup: 'confirm_senses',
    })
    chatId = (createRes.data as ChatCreateResponseData).chatId

    const input = submitChatInput(client, chatId, '写文件')
    await awaitInputAccepted(client, input)
    const interruptN = await waitForNotification(() => input.events, 'interrupt')
    const approvalId = (interruptN.data as InterruptNotificationData).approvalId

    const opened = await openChat(client, chatId)
    expect(opened.state.run?.state).toBe('running')

    // runningTools 含未决 write_file（id = interrupt approvalId，同源）
    const tool = opened.state.runningTools.find((t) => t.id === approvalId)
    expect(tool?.senseName).toBe('write_file')
    // pendingApproval 同源 approvalId（approvalManager 内存存活）
    expect(opened.state.pendingApproval?.approvalId).toBe(approvalId)
    expect(opened.state.pendingApproval?.senseName).toBe('write_file')

    // 清理：abort 挂起 run（统一暂停语义），免 afterAll 悬挂
    await client.call('chat.abort', { chatId })
    // 断言用到 interrupts 仅确认中断态确实到达（防回归）
    expect(interrupts(allEvents(input.events)).length).toBeGreaterThanOrEqual(1)
  }, 15000)
})
