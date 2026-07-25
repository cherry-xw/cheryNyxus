/**
 * 流程测试 Tier 2：chat.attach cursor 锚点 + attach+sync 补回 disconnect-window（S17 验收）。
 *
 * 规约见 [docs/flow-test.md](../../../docs/flow-test.md) §3.B S17。
 * M1+M2+M9 修复后端到端验证：
 * - chat.attach 响应携带 snapshotSeq + pendingQuestionBatches（与 chat.get/chat.sync 同源；
 *   cursor 锚点供前端 resetChatSeq 推进）
 * - attach 后立即 chat.sync(chatId, snapshotSeq) 返 0 events（cursor 已在 snapshotSeq）
 * - 模拟 disconnect 窗口：appendChatEvent 一行 seq>snapshotSeq，chat.sync(chatId, snapshotSeq) 命中该行
 *
 * 与 [flowRefresh.test.ts](./flowRefresh.test.ts)（S9 审批断连重连）互补：
 * S9 验 attach + accept 续跑；本测验 attach 自身 + cursor 锚点 + sync 补回事件。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { deleteChat } from '@/db/chat.js'
import { appendChatEvent } from '@/db/delivery.js'
import type {
  ChatCreateResponseData,
  ChatAttachResponseData,
  ChatSyncResponseData,
} from '@/service/message/types.js'
import { bootFlowService, connectClient, type FlowService } from '../helpers/serviceHarness.js'
import { notificationsByType, waitForNotification } from '../helpers/eventsAssert.js'
import type { RpcClient, RequestHandle } from '../../helpers/rpcClient.js'

/** drain chat.sync：收集流式 events + 拿 response（含 success/data）。 */
async function drainSync(
  client: RpcClient,
  chatId: string,
  afterSeq: number,
): Promise<{ handle: RequestHandle; success: boolean; data: ChatSyncResponseData }> {
  const handle = client.request('chat.sync', { chatId, afterSeq })
  const res = await client.awaitResponse(handle)
  return { handle, success: res.success, data: res.data as ChatSyncResponseData }
}

describe('S17 chat.attach cursor 锚点 + attach+sync 补回 disconnect-window', () => {
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

  it('idle chat attach：response 含 snapshotSeq + pendingQuestionBatches 字段（QuestionStateSnapshotData 继承）', async () => {
    const createRes = await client.call('chat.create', {
      brain: 'mock_todo',
      senseGroup: 'todo_senses',
    })
    chatId = (createRes.data as ChatCreateResponseData).chatId

    const attachRes = await client.call('chat.attach', { chatId })
    const attachData = attachRes.data as ChatAttachResponseData

    // 空闲 chat 未运行 → running:false，但 cursor 字段仍应携带（4 个 return 路径统一补 snapshotSeq）
    expect(attachData.running).toBe(false)
    expect(typeof attachData.snapshotSeq).toBe('number')
    expect(attachData.snapshotSeq).toBe(0) // 无 chat_events 持久化事件
    expect(Array.isArray(attachData.pendingQuestionBatches)).toBe(true)
    expect(attachData.pendingQuestionBatches).toEqual([])
  }, 10000)

  it('running chat attach：snapshotSeq 推进到 chat_events.MAX(seq)，attach 后 sync(chatId, snapshotSeq) 返 0 events', async () => {
    const createRes = await client.call('chat.create', {
      brain: 'mock_confirm',
      senseGroup: 'confirm_senses',
    })
    chatId = (createRes.data as ChatCreateResponseData).chatId

    // send 触发 interrupt → chat_events 持久化事件（>= 1 行）
    const send = client.request('chat.send', { chatId, prompt: '写文件' })
    await waitForNotification(() => send.events, 'interrupt')

    // attach 响应 snapshotSeq 应 > 0（持久化事件已存在）
    const attachRes = await client.call('chat.attach', { chatId })
    const attachData = attachRes.data as ChatAttachResponseData
    expect(attachData.running).toBe(true)
    expect(typeof attachData.snapshotSeq).toBe('number')
    expect(attachData.snapshotSeq).toBeGreaterThan(0)

    // attach 后立即 sync(snapshotSeq)：cursor 已在 snapshotSeq，应返 0 流式 events（M9 前置条件）
    const { handle: postAttachHandle, success: postAttachOk, data: postAttachRes } = await drainSync(
      client,
      chatId,
      attachData.snapshotSeq,
    )
    expect(postAttachOk).toBe(true)
    expect(postAttachRes.latestSeq).toBe(attachData.snapshotSeq)
    // 流式 events 应为空（cursor 已在 snapshotSeq，无 seq>snapshotSeq 的留存事件）
    expect(postAttachHandle.events.length).toBe(0)
  }, 15000)

  it('disconnect-window 补回：attach 后 appendChatEvent(seq>snapshotSeq) → sync(chatId, snapshotSeq) 命中该行', async () => {
    const createRes = await client.call('chat.create', {
      brain: 'mock_confirm',
      senseGroup: 'confirm_senses',
    })
    chatId = (createRes.data as ChatCreateResponseData).chatId

    const send = client.request('chat.send', { chatId, prompt: '写文件' })
    await waitForNotification(() => send.events, 'interrupt')

    const attachRes = await client.call('chat.attach', { chatId })
    const snapshotSeq = (attachRes.data as ChatAttachResponseData).snapshotSeq!
    expect(snapshotSeq).toBeGreaterThan(0)

    // 模拟 disconnect 窗口：手动 append 一行（真实场景下是断连期间 server 端落库的事件，未推送到旧 ws）
    appendChatEvent(chatId, {
      kind: 'notification',
      type: 'auto_compacted',
      chatId,
      data: { reason: 'usage', usedBefore: 100, total: 1000 },
    })

    // attach 后 sync(chatId, snapshotSeq)：应返回刚 append 的 disconnect-window 事件
    const { handle, success, data } = await drainSync(client, chatId, snapshotSeq)
    expect(success).toBe(true)
    expect(data.latestSeq).toBeGreaterThan(snapshotSeq)

    // 流式 events 应包含 append 的 auto_compacted notification
    const autoCompactedEvents = notificationsByType(handle.events, 'auto_compacted')
    expect(autoCompactedEvents.length).toBeGreaterThanOrEqual(1)
  }, 15000)
})