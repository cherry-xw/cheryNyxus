/**
 * 流程测试 Tier 2：流式中断刷新续跑 S8（service+WS 级）。
 *
 * 规约见 [docs/flow-test.md](../../../docs/flow-test.md) §3.B。回应用户原始问题：
 * 「流式中断 → 重连 → 打字机内容完整重建」。flow_stream.yaml 的 chunkDelayMs=2000 制造
 * 可靠断连窗口（首 stream chunk 后断连，余下 content + done 经 liveOutput 到新 ws）。
 *
 * 关键：流式中 close **不 park**（grace 内 generator 存活）；重连 attach(running:true) 重定向输出。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { deleteChat } from '@/db/chat.js'
import type { ChatCreateResponseData, ChatAttachResponseData } from '@/service/message/types.js'
import { bootFlowService, connectClient, type FlowService } from '../helpers/serviceHarness.js'
import {
  allEvents,
  waitFor,
  streamChunks,
  collectStreamContent,
  dones,
  waitForNotification,
} from '../helpers/eventsAssert.js'
import type { RpcClient } from '../../helpers/rpcClient.js'

describe('S8 流式中断刷新续跑（grace 内 generator 存活，跨断连重建打字机内容）', () => {
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

  it('流式中 close 不 park → 重连 attach 续跑 → done 到新 ws，内容跨断连重建', async () => {
    const createRes = await client.call('chat.create', {
      brain: 'mock_flow_stream',
      senseGroup: 'auto_senses',
    })
    chatId = (createRes.data as ChatCreateResponseData).chatId

    // 1. send（chunkDelayMs=2000，首 thinking chunk 约 +2s 到达）
    const send = client.request('chat.send', { chatId, prompt: '回复' })

    // 2. 等首个 stream chunk → 流式已开始
    await waitFor(
      () => send.events,
      (events) => (streamChunks(events).length > 0 ? true : undefined),
      6000,
    )
    expect(streamChunks(send.events).length).toBeGreaterThanOrEqual(1)

    // 3. 流式中断连 → grace（不 park，generator 存活）
    client.close()
    await client.reconnect()

    // 4. attach：running=true（generator 仍存活，未 park）
    const attachRes = await client.call('chat.attach', { chatId })
    expect((attachRes.data as ChatAttachResponseData).running).toBe(true)

    // 5. sync 回放断连窗口事件
    await client.call('chat.sync', { chatId, afterSeq: 0 })

    // 6. 续跑到 done：余下 content chunk + done 经 liveOutput 到新 ws，归入 send.events
    await waitForNotification(() => send.events, 'done', 8000)
    expect(dones(allEvents(send.events)).length).toBeGreaterThanOrEqual(1)

    // 7. 跨断连重建打字机内容：thinking(pre-close) + content(post-reconnect) stream chunk 合并
    const content = collectStreamContent(allEvents(send.events))
    expect(content.length).toBeGreaterThan(0)
  }, 25000)
})
