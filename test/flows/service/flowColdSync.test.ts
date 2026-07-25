/**
 * 流程测试 Tier 2：冷刷新单一事件流 S11（G3 改造A，service+WS 级）。
 *
 * 规约见 [docs/flow-test.md](../../../docs/flow-test.md) §3.B S11 / FP-D。chat.sync(0) = 唯一历史+实时水源：
 * - 非超窗：一次返回完整连续事件流（reset:false + currentState），前端单数组重建，无 chat.get 双路合并。
 * - 超窗：淘汰前缀由 messages 合成 staged 回填 + 留存近期，按 msgId/id 去重，reset 转 false + backfilled:true。
 *
 * 与 [flowSync.test.ts](../../service/chat/flowSync.test.ts) 单元互补：此处经完整 send 链产生真实历史
 * （非手动 addMessage）+ 真实 WS chat.sync 帧，验线上 hydration 路径端到端。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { deleteChat, getChat, getMessages } from '@/db/chat.js'
import { getMonthlyDb } from '@/db/index.js'
import type {
  ChatCreateResponseData,
  ChatSyncResponseData,
  StagedChunkData,
  StreamChunkData,
} from '@/service/message/types.js'
import { bootFlowService, connectClient, type FlowService } from '../helpers/serviceHarness.js'
import {
  stagedChunks,
  streamChunks,
  dones,
  waitForNotification,
} from '../helpers/eventsAssert.js'
import type { RpcClient, RequestHandle } from '../../helpers/rpcClient.js'

/** drain chat.sync：收集流式 events + 拿 response（currentState/reset/backfilled 在 response.data）。 */
async function drainSync(
  client: RpcClient,
  chatId: string,
  afterSeq: number,
): Promise<{ handle: RequestHandle; response: ChatSyncResponseData }> {
  const handle = client.request('chat.sync', { chatId, afterSeq })
  const res = await client.awaitResponse(handle)
  return { handle, response: res.data as ChatSyncResponseData }
}

describe('S11 冷刷新单一事件流（G3 端到端）', () => {
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

  it('非超窗：chat.sync(0) 返回完整事件流 + currentState（单一水源，reset:false）', async () => {
    const createRes = await client.call('chat.create', {
      brain: 'mock_todo',
      senseGroup: 'todo_senses',
    })
    chatId = (createRes.data as ChatCreateResponseData).chatId

    // 跑完产生真实历史（user + assistant 轮1[thinking/content/update_todo] + assistant 轮2）
    const send = client.request('chat.send', { chatId, prompt: '规划任务' })
    await waitForNotification(() => send.events, 'done')

    // chat.sync(0)：单一水源，一次返回完整连续事件流
    const { handle, response } = await drainSync(client, chatId, 0)
    expect(response.reset).toBe(false)
    expect(response.currentState).toBeDefined()
    expect(response.runtime).toEqual({ brain: 'mock_todo', senseGroup: 'todo_senses', mcpServers: [] })
    expect(response.contextBreakdown).toBeDefined()
    expect(response.contextTotal).toBeGreaterThan(0)
    expect(response.commandConfig).toBeDefined()
    expect(response.latestSeq).toBeGreaterThan(0)

    // 事件流可重建完整对话：staged（thinking/content/sense_end）+ stream + done 均到场
    const stagedTypes = stagedChunks(handle.events).map((c) => (c.data as StagedChunkData).type)
    expect(stagedTypes).toContain('content_end')
    expect(stagedTypes).toContain('sense_end') // update_todo
    const live = streamChunks(handle.events).map((chunk) => chunk.data as StreamChunkData)
    expect(live.length).toBeGreaterThan(0)
    expect(live.every((chunk) => !!chunk.msgId && typeof chunk.createdAt === 'number')).toBe(true)
    expect(dones(handle.events).length).toBeGreaterThanOrEqual(1)
  }, 15000)

  it('超窗：淘汰旧事件 → 回填合成旧消息 + 留存近期，msgId 去重，backfilled:true', async () => {
    const createRes = await client.call('chat.create', {
      brain: 'mock_todo',
      senseGroup: 'todo_senses',
    })
    chatId = (createRes.data as ChatCreateResponseData).chatId
    const send = client.request('chat.send', { chatId, prompt: '规划任务' })
    await waitForNotification(() => send.events, 'done')

    // 基线：sync(0) 正常返回，拿 latestSeq
    const baseline = await drainSync(client, chatId, 0)
    const latestSeq = baseline.response.latestSeq
    expect(latestSeq).toBeGreaterThan(2)

    // 强制淘汰旧事件（仅保留末 2 条 seq），模拟超窗淘汰前缀
    const month = getChat(chatId)!.messages_month
    getMonthlyDb(month)
      .prepare('DELETE FROM chat_events WHERE chat_id = ? AND chat_seq < ?')
      .run(chatId, latestSeq - 1)

    // 3 条持久消息（user + 2 assistant），均带 content → 各一 content_end staged
    const contentMsgIds = getMessages(chatId)
      .filter((m) => m.content && m.content.length > 0)
      .map((m) => m.id)

    // chat.sync(0) 回填：淘汰前缀由 messages 合成 staged + 留存近期，去重 → reset 转 false
    const { handle, response } = await drainSync(client, chatId, 0)
    expect(response.reset).toBe(false)
    expect(response.backfilled).toBe(true)

    // 所有消息 content_end 均出现（回填补旧 + 留存保新），msgId 无重复
    const msgIds = stagedChunks(handle.events)
      .filter((c) => (c.data as StagedChunkData).type === 'content_end')
      .map((c) => (c.data as StagedChunkData).msgId)
    expect(msgIds.length).toBe(new Set(msgIds).size) // 无重
    expect([...new Set(msgIds)].sort()).toEqual([...contentMsgIds].sort())
  }, 15000)
})
