/**
 * 流程测试 Tier 2：流式中断刷新续跑 S8（service+WS 级）。
 *
 * 规约见 [docs/flow-test.md](../../../docs/flow-test.md) §3.B。回应用户原始问题：
 * 「流式中断 → 重连 → 打字机内容完整重建」。flow_stream.yaml 的 chunkDelayMs=2000 制造
 * 可靠断连窗口（首 stream chunk 后断连，余下 content + done 经 liveOutput 到新 ws）。
 *
 * 关键：canonical input 在 ACK 后脱离传输请求；close **不 park**，重连 chat.open 原子恢复累计前缀与订阅。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { deleteChat } from '@/db/chat.js'
import type { ChatCreateResponseData } from '@/service/message/types.js'
import {
  awaitInputAccepted,
  bootFlowService,
  connectClient,
  openChat,
  submitChatInput,
  type FlowService,
} from '../helpers/serviceHarness.js'
import {
  allEvents,
  waitFor,
  streamChunks,
  collectStreamContent,
  dones,
  waitForNotification,
} from '../helpers/eventsAssert.js'
import type { RpcClient } from '../../helpers/rpcClient.js'

describe('S8 流式中断刷新续跑（detached run 存活，跨断连重建打字机内容）', () => {
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

  it('流式中 close 不 park → 重连 open 续跑 → done 到新 ws，内容跨断连重建', async () => {
    const createRes = await client.call('chat.create', {
      brain: 'mock_flow_stream',
      senseGroup: 'auto_senses',
    })
    chatId = (createRes.data as ChatCreateResponseData).chatId

    const input = submitChatInput(client, chatId, '回复')
    await awaitInputAccepted(client, input)

    // 2. 等首个 stream chunk → 流式已开始
    await waitFor(
      () => input.events,
      (events) => (streamChunks(events).length > 0 ? true : undefined),
      6000,
    )
    expect(streamChunks(input.events).length).toBeGreaterThanOrEqual(1)

    // 3. 流式中断连；detached run 不 park，generator 存活。
    client.close()
    await client.reconnect()

    const opened = await openChat(client, chatId)
    expect(opened.state.run?.state).toBe('running')
    expect(opened.state.activeTurns.length).toBeGreaterThan(0)

    // 6. 续跑到 done：余下 content chunk + done 经 liveOutput 到新 ws，归入 send.events
    await waitForNotification(() => input.events, 'done', 8000)
    expect(dones(allEvents(input.events)).length).toBeGreaterThanOrEqual(1)

    // 7. 跨断连重建打字机内容：thinking(pre-close) + content(post-reconnect) stream chunk 合并
    const content = collectStreamContent(allEvents(input.events))
    expect(content.length).toBeGreaterThan(0)
  }, 25000)
})
